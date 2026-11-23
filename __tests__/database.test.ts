import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeDatabase } from '../src/database/initialize';
import { getSchemaVersion, MIGRATIONS } from '../src/database/migrations';
import { createInitializedContext, createTestContext } from './helpers/testContext';

describe('database initialisation and migrations', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'planit-db-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('creates the schema, seeds suppliers, roles and the evaluation administrator on first run', async () => {
    const ctx = createTestContext(join(directory, 'first.db'));
    const result = await initializeDatabase(ctx);
    expect(result.appliedMigrations).toEqual(MIGRATIONS.map((migration) => migration.version));
    expect(result.createdDemoAdministrator).toBe(true);
    expect(result.schemaVersion).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
    const suppliers = await ctx.db.all<{ supplier_name: string; is_active: number }>('SELECT supplier_name, is_active FROM suppliers ORDER BY supplier_id');
    expect(suppliers).toEqual([
      { supplier_name: 'Meta', is_active: 1 },
      { supplier_name: 'TikTok', is_active: 1 },
      { supplier_name: 'Google Ads', is_active: 0 },
    ]);
    const roles = await ctx.db.all<{ role_name: string }>('SELECT role_name FROM roles ORDER BY role_id');
    expect(roles.map((role) => role.role_name)).toEqual(['Administrator', 'Analyst', 'Viewer']);
    const admin = await ctx.db.first<{ password_hash: string; email: string }>('SELECT * FROM users');
    expect(admin?.email).toBe('admin@planitmedia.com');
    expect(admin?.password_hash).not.toContain('PlanIt2026!');
    await ctx.db.close();
  });

  it('reopens an existing database without re-running migrations or clearing data', async () => {
    const path = join(directory, 'reopen.db');
    const first = createTestContext(path);
    await initializeDatabase(first);
    await first.db.run("INSERT INTO clients (client_name, created_at, updated_at) VALUES ('Persisted Client', 'x', 'x')");
    await first.db.close();

    const second = createTestContext(path);
    const result = await initializeDatabase(second);
    expect(result.appliedMigrations).toEqual([]);
    expect(result.createdDemoAdministrator).toBe(false);
    const client = await second.db.first<{ client_name: string }>("SELECT client_name FROM clients WHERE client_name = 'Persisted Client'");
    expect(client?.client_name).toBe('Persisted Client');
    const users = await second.db.first<{ total: number }>('SELECT COUNT(*) AS total FROM users');
    expect(users?.total).toBe(1);
    expect(await getSchemaVersion(second.db)).toBe(1);
    const recorded = await second.db.all<{ version: number }>('SELECT version FROM schema_migrations');
    expect(recorded).toEqual([{ version: 1 }]);
    await second.db.close();
  });

  it('enforces foreign keys on the connection', async () => {
    const ctx = await createInitializedContext();
    await expect(
      ctx.db.run(
        "INSERT INTO advertising_accounts (client_id, supplier_id, account_name, external_account_id, created_at) VALUES (9999, 1, 'Orphan', 'X1', 'x')",
      ),
    ).rejects.toThrow(/FOREIGN KEY/);
    await ctx.db.close();
  });

  it('rolls back a failed transaction completely', async () => {
    const ctx = await createInitializedContext();
    await expect(
      ctx.db.transaction(async (tx) => {
        await tx.run("INSERT INTO clients (client_name, created_at, updated_at) VALUES ('Rollback Client', 'x', 'x')");
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const client = await ctx.db.first("SELECT * FROM clients WHERE client_name = 'Rollback Client'");
    expect(client).toBeNull();
    await ctx.db.close();
  });
});
