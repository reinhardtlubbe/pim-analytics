import { ProcessingRunView } from '../../database/models';
import { ServiceContext } from '../context';
import { ServiceError } from '../errors';

const RUN_VIEW_SQL = `SELECT r.*, f.original_filename, a.account_name, c.client_name, s.supplier_name
  FROM processing_runs r
  JOIN uploaded_files f ON f.file_id = r.file_id
  JOIN advertising_accounts a ON a.account_id = f.account_id
  JOIN clients c ON c.client_id = a.client_id
  JOIN suppliers s ON s.supplier_id = f.supplier_id`;

export async function getProcessingHistory(
  ctx: ServiceContext,
  filter: { fileId?: number; clientId?: number; status?: string; limit?: number } = {},
): Promise<ProcessingRunView[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.fileId !== undefined) {
    where.push('r.file_id = ?');
    params.push(filter.fileId);
  }
  if (filter.clientId !== undefined) {
    where.push('a.client_id = ?');
    params.push(filter.clientId);
  }
  if (filter.status) {
    where.push('r.status = ?');
    params.push(filter.status);
  }
  params.push(filter.limit ?? 200);
  return ctx.db.all<ProcessingRunView>(`${RUN_VIEW_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.run_id DESC LIMIT ?`, params);
}

export async function getProcessingRun(ctx: ServiceContext, runId: number): Promise<ProcessingRunView> {
  const run = await ctx.db.first<ProcessingRunView>(`${RUN_VIEW_SQL} WHERE r.run_id = ?`, [runId]);
  if (!run) {
    throw new ServiceError('NOT_FOUND', 'Processing run not found.');
  }
  return run;
}

export interface Reconciliation {
  totalRows: number;
  blankRows: number;
  summaryRows: number;
  detailRows: number;
  acceptedRows: number;
  rejectedRows: number;
  duplicateRows: number;
  storedRecords: number;
  pendingQuarantine: number;
  sourceBalanced: boolean;
  outcomeBalanced: boolean;
  storageBalanced: boolean;
}

export async function getRunReconciliation(ctx: ServiceContext, runId: number): Promise<Reconciliation> {
  const run = await getProcessingRun(ctx, runId);
  const stored = await ctx.db.first<{ total: number }>('SELECT COUNT(*) AS total FROM media_records WHERE run_id = ?', [runId]);
  const pending = await ctx.db.first<{ total: number }>("SELECT COUNT(*) AS total FROM quarantined_records WHERE run_id = ? AND status = 'pending_review'", [runId]);
  return {
    totalRows: run.total_rows,
    blankRows: run.blank_rows,
    summaryRows: run.summary_rows,
    detailRows: run.detail_rows,
    acceptedRows: run.accepted_rows,
    rejectedRows: run.rejected_rows,
    duplicateRows: run.duplicate_rows,
    storedRecords: stored?.total ?? 0,
    pendingQuarantine: pending?.total ?? 0,
    sourceBalanced: run.total_rows === run.blank_rows + run.summary_rows + run.detail_rows,
    outcomeBalanced: run.detail_rows === run.accepted_rows + run.rejected_rows + run.duplicate_rows,
    storageBalanced: (stored?.total ?? 0) === run.accepted_rows,
  };
}

export interface DashboardStats {
  files: number;
  completedRuns: number;
  activeRecords: number;
  pendingQuarantine: number;
  totalSpendZar: number;
  latestMonth: string | null;
  clients: number;
  scenarios: number;
}

export async function getDashboardStats(ctx: ServiceContext): Promise<DashboardStats> {
  const row = await ctx.db.first<{
    files: number;
    completed_runs: number;
    active_records: number;
    pending: number;
    spend: number | null;
    latest_month: string | null;
    clients: number;
    scenarios: number;
  }>(
    `SELECT
      (SELECT COUNT(*) FROM uploaded_files) AS files,
      (SELECT COUNT(*) FROM processing_runs WHERE status IN ('completed', 'superseded')) AS completed_runs,
      (SELECT COUNT(*) FROM media_records m JOIN processing_runs r ON r.run_id = m.run_id WHERE r.is_active = 1) AS active_records,
      (SELECT COUNT(*) FROM quarantined_records q JOIN processing_runs r ON r.run_id = q.run_id WHERE r.is_active = 1 AND q.status = 'pending_review') AS pending,
      (SELECT SUM(m.spend_zar) FROM media_records m JOIN processing_runs r ON r.run_id = m.run_id WHERE r.is_active = 1) AS spend,
      (SELECT MAX(m.report_month) FROM media_records m JOIN processing_runs r ON r.run_id = m.run_id WHERE r.is_active = 1) AS latest_month,
      (SELECT COUNT(*) FROM clients) AS clients,
      (SELECT COUNT(*) FROM forecast_scenarios) AS scenarios`,
  );
  return {
    files: row?.files ?? 0,
    completedRuns: row?.completed_runs ?? 0,
    activeRecords: row?.active_records ?? 0,
    pendingQuarantine: row?.pending ?? 0,
    totalSpendZar: row?.spend ?? 0,
    latestMonth: row?.latest_month ?? null,
    clients: row?.clients ?? 0,
    scenarios: row?.scenarios ?? 0,
  };
}
