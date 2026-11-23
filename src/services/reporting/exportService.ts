import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { MediaRecordRow } from '../../database/models';
import { recordAuditEvent } from '../audit/auditService';
import { Actor, requirePermission } from '../auth/permissions';
import { isoNow, ServiceContext } from '../context';
import { ServiceError } from '../errors';
import { getProcessingRun, getRunReconciliation } from './historyService';
import { buildResultsWhere, ResultsFilter } from './resultsService';

export type ExportFormat = 'csv' | 'xlsx';

export interface ExportResult {
  uri: string;
  filename: string;
  mimeType: string;
  rowCount: number;
  spendZarTotal: number;
}

const EXPORT_COLUMNS: { key: keyof MediaRecordRow; header: string }[] = [
  { key: 'record_id', header: 'record_id' },
  { key: 'run_id', header: 'run_id' },
  { key: 'file_id', header: 'file_id' },
  { key: 'source_row_number', header: 'source_row_number' },
  { key: 'report_month', header: 'report_month' },
  { key: 'client_name', header: 'client' },
  { key: 'account_name', header: 'account' },
  { key: 'platform', header: 'platform' },
  { key: 'campaign_name', header: 'campaign_name' },
  { key: 'ad_group_name', header: 'ad_group_name' },
  { key: 'placement', header: 'placement' },
  { key: 'source_objective', header: 'source_objective' },
  { key: 'campaign_type', header: 'campaign_type' },
  { key: 'spend_zar', header: 'spend_zar' },
  { key: 'spend_original', header: 'spend_original' },
  { key: 'currency', header: 'currency' },
  { key: 'fx_rate', header: 'fx_rate_to_zar' },
  { key: 'fx_rate_date', header: 'fx_rate_date' },
  { key: 'impressions', header: 'impressions' },
  { key: 'clicks', header: 'clicks' },
  { key: 'conversions', header: 'conversions' },
  { key: 'click_metric_type', header: 'click_metric_type' },
  { key: 'duplicate_flag', header: 'duplicate_flag' },
  { key: 'forecast_eligibility', header: 'forecast_eligibility' },
];

const MIME_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function timestampForFilename(iso: string): string {
  return iso.replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
}

function toCsv(rows: Record<string, unknown>[], headers: string[]): string {
  return `﻿${Papa.unparse({ fields: headers, data: rows.map((row) => headers.map((header) => (row[header] === null || row[header] === undefined ? '' : row[header]))) })}`;
}

function toWorkbookBytes(sheets: { name: string; rows: (string | number | null)[][] }[]): Uint8Array {
  const workbook = XLSX.utils.book_new();
  sheets.forEach((sheet) => {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name.slice(0, 31));
  });
  const output = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new Uint8Array(output);
}

export async function queryExportRows(ctx: ServiceContext, filter: ResultsFilter): Promise<MediaRecordRow[]> {
  const { sql, params } = buildResultsWhere(filter);
  const rows: MediaRecordRow[] = [];
  const pageSize = 2000;
  for (let offset = 0; ; offset += pageSize) {
    const page = await ctx.db.all<MediaRecordRow>(`SELECT m.* ${sql} ORDER BY m.report_month, m.record_id LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
    rows.push(...page);
    if (page.length < pageSize) {
      break;
    }
  }
  return rows;
}

export async function exportCleanData(ctx: ServiceContext, actor: Actor, filter: ResultsFilter, format: ExportFormat): Promise<ExportResult> {
  requirePermission(actor, 'reports.export');
  const rows = await queryExportRows(ctx, filter);
  if (rows.length === 0) {
    throw new ServiceError('VALIDATION', 'There are no stored records matching the current filters to export.');
  }
  const now = isoNow(ctx);
  const filename = `planit_clean_data_${timestampForFilename(now)}.${format}`;
  const headers = EXPORT_COLUMNS.map((column) => column.header);
  const mapped = rows.map((row) => {
    const output: Record<string, string | number | null> = {};
    EXPORT_COLUMNS.forEach((column) => {
      output[column.header] = row[column.key] as string | number | null;
    });
    return output;
  });
  const content =
    format === 'csv' ? toCsv(mapped, headers) : toWorkbookBytes([{ name: 'Clean data', rows: [headers, ...mapped.map((row) => headers.map((header) => row[header]))] }]);
  const uri = await ctx.files.writeExport(filename, content);
  const spendZarTotal = Math.round(rows.reduce((sum, row) => sum + (row.spend_zar ?? 0), 0) * 100) / 100;
  await recordAuditEvent(
    ctx.db,
    { eventType: 'export.clean_data', message: `Exported ${rows.length} clean records to ${filename}.`, userId: actor.userId, entityType: 'export' },
    now,
  );
  return { uri, filename, mimeType: MIME_TYPES[format], rowCount: rows.length, spendZarTotal };
}

export async function exportProcessingReport(ctx: ServiceContext, actor: Actor, runId: number, format: ExportFormat): Promise<ExportResult> {
  requirePermission(actor, 'reports.export');
  const run = await getProcessingRun(ctx, runId);
  const file = await ctx.db.first<{ original_filename: string; file_hash: string; file_size_bytes: number; upload_date: string; worksheet_name: string | null }>(
    'SELECT original_filename, file_hash, file_size_bytes, upload_date, worksheet_name FROM uploaded_files WHERE file_id = ?',
    [run.file_id],
  );
  const reconciliation = await getRunReconciliation(ctx, runId);
  const errorSummary = await ctx.db.all<{ error_type: string; severity: string; field_name: string | null; occurrences: number }>(
    `SELECT error_type, severity, field_name, COUNT(*) AS occurrences FROM validation_errors WHERE run_id = ?
     GROUP BY error_type, severity, field_name ORDER BY severity, occurrences DESC`,
    [runId],
  );
  const quarantine = await ctx.db.all<{ source_row_number: number; reason_type: string; status: string; reason: string }>(
    'SELECT source_row_number, reason_type, status, reason FROM quarantined_records WHERE run_id = ? ORDER BY source_row_number',
    [runId],
  );
  const now = isoNow(ctx);
  const details: (string | number | null)[][] = [
    ['Field', 'Value'],
    ['Original file', file?.original_filename ?? ''],
    ['File SHA-256', file?.file_hash ?? ''],
    ['File size (bytes)', file?.file_size_bytes ?? null],
    ['Worksheet', file?.worksheet_name ?? ''],
    ['Uploaded', file?.upload_date ?? ''],
    ['Client', run.client_name],
    ['Account', run.account_name],
    ['Supplier', run.supplier_name],
    ['Run ID', run.run_id],
    ['Run status', run.status],
    ['Processing started', run.started_at],
    ['Processing completed', run.completed_at ?? ''],
    ['Duration (ms)', run.duration_ms ?? null],
    ['Total source rows', reconciliation.totalRows],
    ['Blank rows skipped', reconciliation.blankRows],
    ['Summary rows excluded', reconciliation.summaryRows],
    ['Detail rows processed', reconciliation.detailRows],
    ['Accepted rows', reconciliation.acceptedRows],
    ['Quarantined (rejected) rows', reconciliation.rejectedRows],
    ['Exact duplicate rows', reconciliation.duplicateRows],
    ['Potential business-key duplicates (kept)', run.potential_duplicate_rows],
    ['Accepted rows with missing clicks', run.missing_click_rows],
    ['Stored records in database', reconciliation.storedRecords],
    ['Source rows reconcile (total = blank + summary + detail)', reconciliation.sourceBalanced ? 'Yes' : 'No'],
    ['Outcomes reconcile (detail = accepted + rejected + duplicates)', reconciliation.outcomeBalanced ? 'Yes' : 'No'],
    ['Storage reconciles (stored = accepted)', reconciliation.storageBalanced ? 'Yes' : 'No'],
    ['Report generated', now],
  ];
  const errors: (string | number | null)[][] = [
    ['error_type', 'severity', 'field', 'occurrences'],
    ...errorSummary.map((row) => [row.error_type, row.severity, row.field_name ?? '', row.occurrences]),
  ];
  const quarantined: (string | number | null)[][] = [
    ['source_row_number', 'reason_type', 'status', 'reason'],
    ...quarantine.map((row) => [row.source_row_number, row.reason_type, row.status, row.reason]),
  ];
  const filename = `planit_processing_report_run${runId}_${timestampForFilename(now)}.${format}`;
  let content: string | Uint8Array;
  if (format === 'csv') {
    const sections = [
      Papa.unparse(details),
      '',
      'Error summary',
      Papa.unparse(errors),
      '',
      'Quarantined rows',
      Papa.unparse(quarantined),
    ];
    content = `﻿${sections.join('\r\n')}`;
  } else {
    content = toWorkbookBytes([
      { name: 'Summary', rows: details },
      { name: 'Error summary', rows: errors },
      { name: 'Quarantined rows', rows: quarantined },
    ]);
  }
  const uri = await ctx.files.writeExport(filename, content);
  await recordAuditEvent(
    ctx.db,
    { eventType: 'export.processing_report', message: `Exported processing report for run ${runId} to ${filename}.`, runId, fileId: run.file_id, userId: actor.userId, entityType: 'export' },
    now,
  );
  return { uri, filename, mimeType: MIME_TYPES[format], rowCount: reconciliation.acceptedRows, spendZarTotal: 0 };
}
