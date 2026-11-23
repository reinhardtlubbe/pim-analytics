import { APP_CONFIG } from '../config/appConfig';
import { SUPPLIER_CONFIGS } from '../config/suppliers';
import { recordAuditEvent } from '../services/audit/auditService';
import { createUser } from '../services/auth/authService';
import { ROLE_DEFINITIONS } from '../services/auth/permissions';
import { isoNow, ServiceContext } from '../services/context';
import { getSchemaVersion, runMigrations } from './migrations';
import { Db } from './types';

export interface InitializationResult {
  schemaVersion: number;
  appliedMigrations: number[];
  createdDemoAdministrator: boolean;
  recoveredRuns: number;
}

export async function configureConnection(db: Db): Promise<void> {
  await db.exec('PRAGMA foreign_keys = ON');
  await db.exec('PRAGMA busy_timeout = 5000');
}

async function seedReferenceData(db: Db, now: string): Promise<void> {
  for (const supplier of SUPPLIER_CONFIGS) {
    await db.run(
      `INSERT INTO suppliers (supplier_code, supplier_name, default_platform, default_currency, click_metric_type, is_active, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(supplier_code) DO UPDATE SET
         supplier_name = excluded.supplier_name,
         default_platform = excluded.default_platform,
         default_currency = excluded.default_currency,
         click_metric_type = excluded.click_metric_type,
         is_active = excluded.is_active`,
      [
        supplier.code,
        supplier.name,
        supplier.defaults.platform,
        supplier.defaults.currency,
        supplier.defaults.clickMetricType,
        supplier.enabled ? 1 : 0,
        JSON.stringify({ currencySource: supplier.currencySource }),
        now,
      ],
    );
  }
  for (const role of ROLE_DEFINITIONS) {
    await db.run('INSERT OR IGNORE INTO roles (role_name, description) VALUES (?, ?)', [role.name, role.description]);
  }
}

// Seed a default demo client (Client Alpha) and sample accounts so the user has data to work with immediately upon launching the app.
async function seedEvaluationClient(db: Db, now: string): Promise<void> {
  const existing = await db.first<{ total: number }>('SELECT COUNT(*) AS total FROM clients');
  if ((existing?.total ?? 0) > 0) {
    return;
  }
  const client = await db.run(
    'INSERT INTO clients (client_name, industry, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ['Client Alpha', 'Advertising', JSON.stringify({ purpose: 'demo' }), now, now],
  );
  const suppliers = await db.all<{ supplier_id: number; supplier_name: string; supplier_code: string }>(
    'SELECT supplier_id, supplier_name, supplier_code FROM suppliers WHERE is_active = 1 ORDER BY supplier_id',
  );
  for (const supplier of suppliers) {
    await db.run(
      'INSERT INTO advertising_accounts (client_id, supplier_id, account_name, external_account_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [client.lastInsertRowId, supplier.supplier_id, `Campaign 01 · ${supplier.supplier_name}`, `CAMP-${supplier.supplier_code.toUpperCase()}-01`, '{}', now],
    );
  }
}

export async function recoverInterruptedRuns(db: Db, now: string): Promise<number> {
  const stale = await db.all<{ run_id: number; file_id: number }>("SELECT run_id, file_id FROM processing_runs WHERE status = 'running'");
  for (const run of stale) {
    await db.transaction(async (tx) => {
      await tx.run(
        "UPDATE processing_runs SET status = 'failed', is_active = 0, completed_at = ?, error_message = ? WHERE run_id = ?",
        [now, 'Processing was interrupted before completion. No records from this run were kept.', run.run_id],
      );
      await tx.run('DELETE FROM media_records WHERE run_id = ?', [run.run_id]);
      const active = await tx.first<{ run_id: number }>('SELECT run_id FROM processing_runs WHERE file_id = ? AND is_active = 1', [run.file_id]);
      await tx.run('UPDATE uploaded_files SET status = ? WHERE file_id = ?', [active ? 'processed' : 'mapped', run.file_id]);
      await recordAuditEvent(
        tx,
        { eventType: 'processing.recovered', message: `Run ${run.run_id} was interrupted and marked as failed.`, severity: 'warning', runId: run.run_id, fileId: run.file_id },
        now,
      );
    });
  }
  return stale.length;
}

export async function initializeDatabase(ctx: ServiceContext): Promise<InitializationResult> {
  await configureConnection(ctx.db);
  const now = isoNow(ctx);
  const appliedMigrations = await runMigrations(ctx.db, () => isoNow(ctx));
  await ctx.db.transaction(async (tx) => {
    await seedReferenceData(tx, now);
    await seedEvaluationClient(tx, now);
  });
  const users = await ctx.db.first<{ total: number }>('SELECT COUNT(*) AS total FROM users');
  let createdDemoAdministrator = false;
  if ((users?.total ?? 0) === 0) {
    await createUser(
      ctx,
      null,
      {
        email: APP_CONFIG.demoAdmin.email,
        displayName: APP_CONFIG.demoAdmin.displayName,
        password: APP_CONFIG.demoAdmin.password,
        role: 'Administrator',
      },
      { isDemo: true, skipPermission: true },
    );
    createdDemoAdministrator = true;
  }
  const recoveredRuns = await recoverInterruptedRuns(ctx.db, now);
  return { schemaVersion: await getSchemaVersion(ctx.db), appliedMigrations, createdDemoAdministrator, recoveredRuns };
}
