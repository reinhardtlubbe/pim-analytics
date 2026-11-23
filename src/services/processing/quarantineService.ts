import { QuarantinedRecordRow, QuarantineStatus, ValidationErrorRow } from '../../database/models';
import { parseJson } from '../../utils/async';
import { recordAuditEvent } from '../audit/auditService';
import { Actor, requirePermission } from '../auth/permissions';
import { isoNow, ServiceContext } from '../context';
import { ServiceError } from '../errors';
import { CellValue } from '../ingestion/fileParser';
import { getMappingConfirmation } from '../mapping/confirmationService';
import { buildTransformContext, insertMediaRecords } from './processingService';
import { transformSourceRow } from './recordTransformer';

export interface QuarantineView extends QuarantinedRecordRow {
  original_filename: string;
  file_id: number;
  run_status: string;
  run_is_active: number;
}

export interface QuarantineQuery {
  runId?: number;
  fileId?: number;
  status?: QuarantineStatus;
  reasonType?: 'validation' | 'exact_duplicate';
  limit?: number;
  offset?: number;
}

export async function getQuarantinedRecords(ctx: ServiceContext, query: QuarantineQuery = {}): Promise<QuarantineView[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (query.runId !== undefined) {
    where.push('q.run_id = ?');
    params.push(query.runId);
  }
  if (query.fileId !== undefined) {
    where.push('r.file_id = ?');
    params.push(query.fileId);
  }
  if (query.status) {
    where.push('q.status = ?');
    params.push(query.status);
  }
  if (query.reasonType) {
    where.push('q.reason_type = ?');
    params.push(query.reasonType);
  }
  params.push(query.limit ?? 200, query.offset ?? 0);
  return ctx.db.all<QuarantineView>(
    `SELECT q.*, f.original_filename, f.file_id, r.status AS run_status, r.is_active AS run_is_active
     FROM quarantined_records q
     JOIN processing_runs r ON r.run_id = q.run_id
     JOIN uploaded_files f ON f.file_id = r.file_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY q.run_id DESC, q.source_row_number
     LIMIT ? OFFSET ?`,
    params,
  );
}

export async function getValidationErrors(
  ctx: ServiceContext,
  query: { runId?: number; severity?: 'error' | 'warning'; sourceRowNumber?: number; limit?: number; offset?: number } = {},
): Promise<(ValidationErrorRow & { original_filename: string; file_id: number })[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (query.runId !== undefined) {
    where.push('e.run_id = ?');
    params.push(query.runId);
  }
  if (query.severity) {
    where.push('e.severity = ?');
    params.push(query.severity);
  }
  if (query.sourceRowNumber !== undefined) {
    where.push('e.source_row_number = ?');
    params.push(query.sourceRowNumber);
  }
  params.push(query.limit ?? 500, query.offset ?? 0);
  return ctx.db.all(
    `SELECT e.*, f.original_filename, f.file_id FROM validation_errors e
     JOIN processing_runs r ON r.run_id = e.run_id
     JOIN uploaded_files f ON f.file_id = r.file_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY e.run_id DESC, e.source_row_number, e.error_id
     LIMIT ? OFFSET ?`,
    params,
  );
}

export async function getQuarantinedRecord(ctx: ServiceContext, quarantineId: number): Promise<QuarantineView> {
  const entry = await ctx.db.first<QuarantineView>(
    `SELECT q.*, f.original_filename, f.file_id, r.status AS run_status, r.is_active AS run_is_active
     FROM quarantined_records q JOIN processing_runs r ON r.run_id = q.run_id JOIN uploaded_files f ON f.file_id = r.file_id
     WHERE q.quarantine_id = ?`,
    [quarantineId],
  );
  if (!entry) {
    throw new ServiceError('NOT_FOUND', 'Quarantined record not found.');
  }
  return entry;
}

async function loadReviewable(ctx: ServiceContext, quarantineId: number): Promise<QuarantineView> {
  const entry = await getQuarantinedRecord(ctx, quarantineId);
  if (entry.status !== 'pending_review') {
    throw new ServiceError('CONFLICT', 'This quarantined record has already been reviewed.');
  }
  if (entry.run_is_active !== 1) {
    throw new ServiceError('CONFLICT', 'Only rows from the active processing run can be reviewed. Review the latest run instead.');
  }
  return entry;
}

export async function reprocessQuarantinedRecord(
  ctx: ServiceContext,
  actor: Actor,
  quarantineId: number,
  corrections: Record<string, CellValue>,
): Promise<{ recordId: number }> {
  requirePermission(actor, 'quarantine.review');
  const entry = await loadReviewable(ctx, quarantineId);
  if (entry.reason_type === 'exact_duplicate') {
    throw new ServiceError('CONFLICT', 'Exact duplicates cannot be re-imported. Dismiss the row instead.');
  }
  const run = await ctx.db.first<{ confirmation_id: number; file_id: number }>('SELECT confirmation_id, file_id FROM processing_runs WHERE run_id = ?', [entry.run_id]);
  if (!run) {
    throw new ServiceError('NOT_FOUND', 'Processing run not found.');
  }
  const confirmation = await getMappingConfirmation(ctx, run.confirmation_id);
  const original = parseJson<Record<string, CellValue>>(entry.source_data_json, {});
  const unknownColumns = Object.keys(corrections).filter((column) => !(column in original));
  if (unknownColumns.length) {
    throw new ServiceError('VALIDATION', `Corrections reference unknown columns: ${unknownColumns.join(', ')}.`);
  }
  const corrected: Record<string, CellValue> = { ...original, ...corrections };
  const file = await ctx.db.first<{ account_id: number }>('SELECT account_id FROM uploaded_files WHERE file_id = ?', [run.file_id]);
  const context = await buildTransformContext(ctx, file?.account_id ?? 0, confirmation);
  const result = transformSourceRow(entry.source_row_number, corrected, context);
  if (!result.record) {
    throw new ServiceError(
      'VALIDATION',
      result.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => issue.message)
        .join(' '),
      { issues: result.issues },
    );
  }
  const record = result.record;
  const duplicate = await ctx.db.first<{ record_id: number }>(
    `SELECT m.record_id FROM media_records m JOIN processing_runs r ON r.run_id = m.run_id
     WHERE m.account_id = ? AND r.is_active = 1 AND m.row_fingerprint = ? LIMIT 1`,
    [record.accountId, record.rowFingerprint],
  );
  if (duplicate) {
    throw new ServiceError('CONFLICT', `The corrected row exactly duplicates stored record ${duplicate.record_id}.`);
  }
  const keyClash = await ctx.db.first<{ record_id: number }>(
    `SELECT m.record_id FROM media_records m JOIN processing_runs r ON r.run_id = m.run_id
     WHERE m.account_id = ? AND r.is_active = 1 AND m.business_key = ? LIMIT 1`,
    [record.accountId, record.businessKey],
  );
  const now = isoNow(ctx);
  return ctx.db.transaction(async (tx) => {
    const [recordId] = await insertMediaRecords(
      tx,
      [{ ...record, duplicateFlag: keyClash ? 'potential_business_key' : 'distinct' }],
      entry.run_id,
      run.file_id,
      now,
    );
    await tx.run(
      "UPDATE quarantined_records SET status = 'resolved', corrected_data_json = ?, resolved_record_id = ?, reviewed_by = ?, reviewed_at = ? WHERE quarantine_id = ?",
      [JSON.stringify(corrections), recordId, actor.userId, now, quarantineId],
    );
    await tx.run(
      `UPDATE processing_runs SET accepted_rows = accepted_rows + 1, rejected_rows = rejected_rows - 1,
        missing_click_rows = missing_click_rows + ?, potential_duplicate_rows = potential_duplicate_rows + ? WHERE run_id = ?`,
      [record.clicks === null ? 1 : 0, keyClash ? 1 : 0, entry.run_id],
    );
    for (const issue of result.issues) {
      await tx.run(
        'INSERT INTO validation_errors (run_id, source_row_number, field_name, error_type, severity, error_message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [entry.run_id, issue.sourceRowNumber, issue.fieldName, issue.errorType, issue.severity, `After correction: ${issue.message}`, now],
      );
    }
    await recordAuditEvent(
      tx,
      {
        eventType: 'quarantine.reprocessed',
        message: `Row ${entry.source_row_number} corrected (${Object.keys(corrections).join(', ') || 'no field changes'}) and imported as record ${recordId}. Original values retained.`,
        runId: entry.run_id,
        fileId: run.file_id,
        userId: actor.userId,
        entityType: 'quarantine',
        entityId: quarantineId,
      },
      now,
    );
    return { recordId };
  });
}

export async function dismissQuarantinedRecord(ctx: ServiceContext, actor: Actor, quarantineId: number, note: string): Promise<void> {
  requirePermission(actor, 'quarantine.review');
  const entry = await loadReviewable(ctx, quarantineId);
  const now = isoNow(ctx);
  await ctx.db.transaction(async (tx) => {
    await tx.run("UPDATE quarantined_records SET status = 'dismissed', reviewed_by = ?, reviewed_at = ? WHERE quarantine_id = ?", [actor.userId, now, quarantineId]);
    await recordAuditEvent(
      tx,
      {
        eventType: 'quarantine.dismissed',
        message: `Row ${entry.source_row_number} dismissed${note.trim() ? `: ${note.trim()}` : ''}.`,
        runId: entry.run_id,
        fileId: entry.file_id,
        userId: actor.userId,
        entityType: 'quarantine',
        entityId: quarantineId,
      },
      now,
    );
  });
}
