import { Db } from './types';

export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core_schema',
    statements: [
      `CREATE TABLE suppliers (
        supplier_id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_code TEXT NOT NULL UNIQUE,
        supplier_name TEXT NOT NULL UNIQUE,
        default_platform TEXT NOT NULL,
        default_currency TEXT,
        click_metric_type TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE clients (
        client_id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        industry TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE advertising_accounts (
        account_id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER NOT NULL REFERENCES clients(client_id) ON DELETE RESTRICT,
        supplier_id INTEGER NOT NULL REFERENCES suppliers(supplier_id) ON DELETE RESTRICT,
        account_name TEXT NOT NULL,
        external_account_id TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE (supplier_id, external_account_id)
      )`,
      `CREATE INDEX ix_accounts_client ON advertising_accounts(client_id)`,
      `CREATE TABLE roles (
        role_id INTEGER PRIMARY KEY AUTOINCREMENT,
        role_name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL
      )`,
      `CREATE TABLE users (
        user_id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_iterations INTEGER NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        is_demo_account INTEGER NOT NULL DEFAULT 0 CHECK (is_demo_account IN (0, 1)),
        failed_login_count INTEGER NOT NULL DEFAULT 0,
        last_login_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE user_roles (
        user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        role_id INTEGER NOT NULL REFERENCES roles(role_id) ON DELETE RESTRICT,
        assigned_at TEXT NOT NULL,
        PRIMARY KEY (user_id, role_id)
      )`,
      `CREATE TABLE user_sessions (
        session_id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        device_label TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      )`,
      `CREATE INDEX ix_sessions_user ON user_sessions(user_id)`,
      `CREATE TABLE uploaded_files (
        file_id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES advertising_accounts(account_id) ON DELETE RESTRICT,
        supplier_id INTEGER NOT NULL REFERENCES suppliers(supplier_id) ON DELETE RESTRICT,
        original_filename TEXT NOT NULL,
        stored_filename TEXT NOT NULL,
        stored_uri TEXT NOT NULL,
        file_type TEXT NOT NULL CHECK (file_type IN ('csv', 'xlsx')),
        content_type TEXT,
        file_size_bytes INTEGER NOT NULL CHECK (file_size_bytes >= 0),
        file_hash TEXT NOT NULL,
        record_count INTEGER NOT NULL,
        total_rows INTEGER NOT NULL,
        summary_rows INTEGER NOT NULL,
        blank_rows INTEGER NOT NULL,
        header_row_number INTEGER NOT NULL,
        worksheet_name TEXT,
        worksheet_names_json TEXT NOT NULL DEFAULT '[]',
        source_columns_json TEXT NOT NULL,
        detected_supplier_code TEXT,
        status TEXT NOT NULL CHECK (status IN ('registered', 'mapped', 'processing', 'processed', 'failed')),
        uploaded_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
        upload_date TEXT NOT NULL,
        UNIQUE (account_id, file_hash)
      )`,
      `CREATE INDEX ix_files_hash ON uploaded_files(file_hash)`,
      `CREATE TABLE mapping_profiles (
        profile_id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_id INTEGER NOT NULL REFERENCES suppliers(supplier_id) ON DELETE RESTRICT,
        profile_name TEXT NOT NULL,
        file_type TEXT NOT NULL CHECK (file_type IN ('csv', 'xlsx')),
        column_mappings_json TEXT NOT NULL,
        source_columns_json TEXT NOT NULL,
        header_row_number INTEGER NOT NULL DEFAULT 1,
        worksheet_name TEXT,
        created_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (supplier_id, profile_name)
      )`,
      `CREATE TABLE mapping_confirmations (
        confirmation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES uploaded_files(file_id) ON DELETE RESTRICT,
        source_file_hash TEXT NOT NULL,
        supplier_name TEXT NOT NULL,
        profile_id INTEGER,
        profile_name TEXT,
        source_columns_json TEXT NOT NULL,
        column_mappings_json TEXT NOT NULL,
        supplier_defaults_json TEXT NOT NULL,
        header_row_number INTEGER NOT NULL,
        worksheet_name TEXT,
        confirmed_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
        confirmed_at TEXT NOT NULL
      )`,
      `CREATE INDEX ix_confirmations_file ON mapping_confirmations(file_id)`,
      `CREATE TRIGGER trg_confirmations_no_update BEFORE UPDATE ON mapping_confirmations
        BEGIN SELECT RAISE(ABORT, 'Mapping confirmations are immutable'); END`,
      `CREATE TRIGGER trg_confirmations_no_delete BEFORE DELETE ON mapping_confirmations
        BEGIN SELECT RAISE(ABORT, 'Mapping confirmations are immutable'); END`,
      `CREATE TABLE processing_runs (
        run_id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES uploaded_files(file_id) ON DELETE RESTRICT,
        confirmation_id INTEGER NOT NULL REFERENCES mapping_confirmations(confirmation_id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'superseded')),
        is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
        total_rows INTEGER NOT NULL DEFAULT 0,
        blank_rows INTEGER NOT NULL DEFAULT 0,
        summary_rows INTEGER NOT NULL DEFAULT 0,
        detail_rows INTEGER NOT NULL DEFAULT 0,
        accepted_rows INTEGER NOT NULL DEFAULT 0,
        rejected_rows INTEGER NOT NULL DEFAULT 0,
        duplicate_rows INTEGER NOT NULL DEFAULT 0,
        potential_duplicate_rows INTEGER NOT NULL DEFAULT 0,
        missing_click_rows INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        error_message TEXT,
        started_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT
      )`,
      `CREATE INDEX ix_runs_file ON processing_runs(file_id)`,
      `CREATE UNIQUE INDEX ux_runs_one_active ON processing_runs(file_id) WHERE is_active = 1`,
      `CREATE UNIQUE INDEX ux_runs_one_running ON processing_runs(file_id) WHERE status = 'running'`,
      `CREATE TABLE media_records (
        record_id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES processing_runs(run_id) ON DELETE CASCADE,
        file_id INTEGER NOT NULL REFERENCES uploaded_files(file_id) ON DELETE RESTRICT,
        source_row_number INTEGER NOT NULL,
        report_month TEXT NOT NULL CHECK (report_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
        client_id INTEGER NOT NULL REFERENCES clients(client_id) ON DELETE RESTRICT,
        client_name TEXT NOT NULL,
        account_id INTEGER NOT NULL REFERENCES advertising_accounts(account_id) ON DELETE RESTRICT,
        account_name TEXT NOT NULL,
        supplier_id INTEGER NOT NULL REFERENCES suppliers(supplier_id) ON DELETE RESTRICT,
        platform TEXT NOT NULL,
        campaign_name TEXT,
        ad_group_name TEXT,
        placement TEXT,
        source_objective TEXT NOT NULL,
        campaign_type TEXT NOT NULL,
        spend_original REAL NOT NULL CHECK (spend_original >= 0),
        spend_zar REAL CHECK (spend_zar IS NULL OR spend_zar >= 0),
        fx_rate REAL,
        fx_rate_date TEXT,
        impressions INTEGER NOT NULL CHECK (impressions >= 0),
        clicks INTEGER CHECK (clicks IS NULL OR clicks >= 0),
        conversions REAL CHECK (conversions IS NULL OR conversions >= 0),
        click_metric_type TEXT NOT NULL,
        currency TEXT NOT NULL,
        source_data_json TEXT NOT NULL,
        row_fingerprint TEXT NOT NULL,
        business_key TEXT NOT NULL,
        duplicate_flag TEXT NOT NULL DEFAULT 'distinct' CHECK (duplicate_flag IN ('distinct', 'potential_business_key')),
        forecast_eligibility TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (run_id, source_row_number)
      )`,
      `CREATE INDEX ix_records_run ON media_records(run_id)`,
      `CREATE INDEX ix_records_client_month ON media_records(client_id, report_month)`,
      `CREATE INDEX ix_records_account_fp ON media_records(account_id, row_fingerprint)`,
      `CREATE INDEX ix_records_account_key ON media_records(account_id, business_key)`,
      `CREATE INDEX ix_records_platform_type ON media_records(platform, campaign_type)`,
      `CREATE INDEX ix_records_campaign ON media_records(campaign_name)`,
      `CREATE TABLE validation_errors (
        error_id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES processing_runs(run_id) ON DELETE CASCADE,
        source_row_number INTEGER NOT NULL,
        field_name TEXT,
        error_type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'error' CHECK (severity IN ('error', 'warning')),
        error_message TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX ix_errors_run ON validation_errors(run_id)`,
      `CREATE TABLE quarantined_records (
        quarantine_id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES processing_runs(run_id) ON DELETE CASCADE,
        source_row_number INTEGER NOT NULL,
        source_data_json TEXT NOT NULL,
        reason TEXT NOT NULL,
        reason_type TEXT NOT NULL CHECK (reason_type IN ('validation', 'exact_duplicate')),
        status TEXT NOT NULL CHECK (status IN ('pending_review', 'resolved', 'dismissed')),
        corrected_data_json TEXT,
        resolved_record_id INTEGER REFERENCES media_records(record_id) ON DELETE SET NULL,
        reviewed_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
        reviewed_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (run_id, source_row_number)
      )`,
      `CREATE INDEX ix_quarantine_status ON quarantined_records(status)`,
      `CREATE TABLE processing_logs (
        log_id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER REFERENCES processing_runs(run_id) ON DELETE CASCADE,
        file_id INTEGER REFERENCES uploaded_files(file_id) ON DELETE SET NULL,
        user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        entity_type TEXT,
        entity_id INTEGER,
        message TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX ix_logs_created ON processing_logs(created_at)`,
      `CREATE INDEX ix_logs_run ON processing_logs(run_id)`,
      `CREATE TABLE currency_rates (
        rate_id INTEGER PRIMARY KEY AUTOINCREMENT,
        currency_code TEXT NOT NULL,
        rate_to_zar REAL NOT NULL CHECK (rate_to_zar > 0),
        rate_date TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (currency_code, rate_date)
      )`,
      `CREATE TABLE forecast_scenarios (
        scenario_id INTEGER PRIMARY KEY AUTOINCREMENT,
        scenario_name TEXT NOT NULL,
        client_id INTEGER NOT NULL REFERENCES clients(client_id) ON DELETE RESTRICT,
        account_id INTEGER REFERENCES advertising_accounts(account_id) ON DELETE SET NULL,
        target_month TEXT NOT NULL CHECK (target_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
        total_budget_zar REAL NOT NULL CHECK (total_budget_zar > 0),
        baseline_window INTEGER NOT NULL CHECK (baseline_window IN (3, 6, 12)),
        allocation_mode TEXT NOT NULL CHECK (allocation_mode IN ('recommended', 'manual')),
        scenario_parameters_json TEXT NOT NULL,
        results_json TEXT NOT NULL,
        created_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX ix_scenarios_client ON forecast_scenarios(client_id)`,
      `CREATE TABLE forecast_allocations (
        allocation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        scenario_id INTEGER NOT NULL REFERENCES forecast_scenarios(scenario_id) ON DELETE CASCADE,
        allocation_type TEXT NOT NULL CHECK (allocation_type IN ('recommended', 'manual')),
        platform TEXT NOT NULL,
        campaign_type TEXT NOT NULL,
        allocation_percentage REAL NOT NULL CHECK (allocation_percentage >= 0 AND allocation_percentage <= 100),
        allocated_budget_zar REAL NOT NULL CHECK (allocated_budget_zar >= 0),
        projected_clicks REAL,
        projected_impressions REAL,
        projected_conversions REAL,
        projected_cpc REAL,
        UNIQUE (scenario_id, allocation_type, platform, campaign_type)
      )`,
    ],
  },
];

export async function getSchemaVersion(db: Db): Promise<number> {
  const row = await db.first<{ user_version: number }>('PRAGMA user_version');
  return row?.user_version ?? 0;
}

export async function runMigrations(db: Db, now: () => string): Promise<number[]> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`,
  );
  const applied: number[] = [];
  const current = await getSchemaVersion(db);
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) {
      continue;
    }
    await db.transaction(async (tx) => {
      for (const statement of migration.statements) {
        await tx.exec(statement);
      }
      await tx.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        now(),
      ]);
      await tx.exec(`PRAGMA user_version = ${migration.version}`);
    });
    applied.push(migration.version);
  }
  return applied;
}
