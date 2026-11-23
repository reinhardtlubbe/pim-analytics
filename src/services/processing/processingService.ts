import { APP_CONFIG } from '../../config/appConfig';
import { CurrencyRateRow, ProcessingRunRow } from '../../database/models';
import { Db, SqlValue } from '../../database/types';
import { chunk, yieldToEventLoop } from '../../utils/async';
import { recordAuditEvent } from '../audit/auditService';
import { Actor, requirePermission } from '../auth/permissions';
import { isoNow, ServiceContext } from '../context';
import { ServiceError } from '../errors';
import { loadStoredTable } from '../ingestion/ingestionService';
import { ConfirmedMapping, getMappingConfirmation } from '../mapping/confirmationService';
import { getAccount } from '../reference/referenceService';
import { RowIssue, StandardisedRecord, transformSourceRow, TransformContext } from './recordTransformer';

export type ProcessingStage = 'loading' | 'reading' | 'transforming' | 'persisting' | 'completed';

export interface ProcessingProgress {
  stage: ProcessingStage;
  processedRows: number;
  totalRows: number;
  message: string;
}

export interface ProcessingSummary {
  runId: number;
  fileId: number;
  confirmationId: number;
  status: 'completed';
  totalRows: number;
  blankRows: number;
  summaryRows: number;
  detailRows: number;
  acceptedRows: number;
  rejectedRows: number;
  duplicateRows: number;
  potentialDuplicateRows: number;
  missingClickRows: number;
  warningCount: number;
  durationMs: number;
  supersededRunId: number | null;
  reconciled: boolean;
}

interface QuarantineEntry {
  sourceRowNumber: number;
  sourceData: string;
  reason: string;
  reasonType: 'validation' | 'exact_duplicate';
}

interface AcceptedRecord extends StandardisedRecord {
  duplicateFlag: 'distinct' | 'potential_business_key';
}

const RECORD_COLUMNS = [
  'run_id',
  'file_id',
  'source_row_number',
  'report_month',
  'client_id',
  'client_name',
  'account_id',
  'account_name',
  'supplier_id',
  'platform',
  'campaign_name',
  'ad_group_name',
  'placement',
  'source_objective',
  'campaign_type',
  'spend_original',
  'spend_zar',
  'fx_rate',
  'fx_rate_date',
  'impressions',
  'clicks',
  'conversions',
  'click_metric_type',
  'currency',
  'source_data_json',
  'row_fingerprint',
  'business_key',
  'duplicate_flag',
  'forecast_eligibility',
  'created_at',
];

function recordValues(record: AcceptedRecord, runId: number, fileId: number, createdAt: string): SqlValue[] {
  return [
    runId,
    fileId,
    record.sourceRowNumber,
    record.reportMonth,
    record.clientId,
    record.clientName,
    record.accountId,
    record.accountName,
    record.supplierId,
    record.platform,
    record.campaignName,
    record.adGroupName,
    record.placement,
    record.sourceObjective,
    record.campaignType,
    record.spendOriginal,
    record.spendZar,
    record.fxRate,
    record.fxRateDate,
    record.impressions,
    record.clicks,
    record.conversions,
    record.clickMetricType,
    record.currency,
    JSON.stringify(record.sourceData),
    record.rowFingerprint,
    record.businessKey,
    record.duplicateFlag,
    record.forecastEligibility,
    createdAt,
  ];
}

export async function insertMediaRecords(db: Db, records: AcceptedRecord[], runId: number, fileId: number, createdAt: string): Promise<number[]> {
  const ids: number[] = [];
  for (const batch of chunk(records, APP_CONFIG.insertBatchSize)) {
    const placeholders = batch.map(() => `(${RECORD_COLUMNS.map(() => '?').join(', ')})`).join(', ');
    const params = batch.flatMap((record) => recordValues(record, runId, fileId, createdAt));
    const result = await db.run(`INSERT INTO media_records (${RECORD_COLUMNS.join(', ')}) VALUES ${placeholders}`, params);
    const first = result.lastInsertRowId - batch.length + 1;
    batch.forEach((_, index) => ids.push(first + index));
  }
  return ids;
}

async function insertIssues(db: Db, issues: RowIssue[], runId: number, createdAt: string): Promise<void> {
  for (const batch of chunk(issues, 150)) {
    const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
    const params = batch.flatMap((issue) => [runId, issue.sourceRowNumber, issue.fieldName, issue.errorType, issue.severity, issue.message, createdAt]);
    await db.run(
      `INSERT INTO validation_errors (run_id, source_row_number, field_name, error_type, severity, error_message, created_at) VALUES ${placeholders}`,
      params,
    );
  }
}

async function insertQuarantine(db: Db, entries: QuarantineEntry[], runId: number, createdAt: string): Promise<void> {
  for (const batch of chunk(entries, 150)) {
    const placeholders = batch.map(() => "(?, ?, ?, ?, ?, 'pending_review', ?)").join(', ');
    const params = batch.flatMap((entry) => [runId, entry.sourceRowNumber, entry.sourceData, entry.reason, entry.reasonType, createdAt]);
    await db.run(
      `INSERT INTO quarantined_records (run_id, source_row_number, source_data_json, reason, reason_type, status, created_at) VALUES ${placeholders}`,
      params,
    );
  }
}

export async function buildTransformContext(ctx: ServiceContext, accountId: number, confirmation: ConfirmedMapping): Promise<TransformContext> {
  const account = await getAccount(ctx, accountId);
  const rates = await ctx.db.all<CurrencyRateRow>('SELECT * FROM currency_rates');
  return {
    confirmation,
    clientId: account.client_id,
    clientName: account.client_name,
    accountId: account.account_id,
    accountName: account.account_name,
    supplierId: account.supplier_id,
    rates,
  };
}

export async function processUploadedFile(
  ctx: ServiceContext,
  actor: Actor,
  input: { fileId: number; confirmationId: number },
  onProgress?: (progress: ProcessingProgress) => void,
): Promise<ProcessingSummary> {
  requirePermission(actor, 'files.process');
  const startedAt = ctx.clock.now();
  const startedMs = Date.now();
  const confirmation = await getMappingConfirmation(ctx, input.confirmationId);
  if (confirmation.fileId !== input.fileId) {
    throw new ServiceError('VALIDATION', 'The mapping confirmation belongs to a different file.');
  }
  const running = await ctx.db.first<{ run_id: number }>("SELECT run_id FROM processing_runs WHERE file_id = ? AND status = 'running'", [input.fileId]);
  if (running) {
    throw new ServiceError('CONFLICT', `Run ${running.run_id} is already processing this file.`);
  }
  const runId = await ctx.db.transaction(async (tx) => {
    const result = await tx.run(
      "INSERT INTO processing_runs (file_id, confirmation_id, status, is_active, started_by, started_at) VALUES (?, ?, 'running', 0, ?, ?)",
      [input.fileId, input.confirmationId, actor.userId, startedAt.toISOString()],
    );
    await tx.run("UPDATE uploaded_files SET status = 'processing' WHERE file_id = ?", [input.fileId]);
    await recordAuditEvent(
      tx,
      { eventType: 'processing.started', message: `Processing started using confirmation ${input.confirmationId}.`, runId: result.lastInsertRowId, fileId: input.fileId, userId: actor.userId, entityType: 'run', entityId: result.lastInsertRowId },
      startedAt.toISOString(),
    );
    return result.lastInsertRowId;
  });

  try {
    onProgress?.({ stage: 'loading', processedRows: 0, totalRows: 0, message: 'Reading stored file' });
    const { file, table } = await loadStoredTable(ctx, input.fileId, confirmation.worksheetName, confirmation.headerRowNumber);
    if (file.file_hash !== confirmation.sourceFileHash) {
      throw new ServiceError('CONFLICT', 'The file content no longer matches the confirmed mapping snapshot.');
    }
    if (table.headers.join('\u0001') !== confirmation.sourceColumns.join('\u0001')) {
      throw new ServiceError('CONFLICT', 'The file columns no longer match the confirmed mapping snapshot. Confirm the mapping again.');
    }
    const context = await buildTransformContext(ctx, file.account_id, confirmation);
    const existingFingerprints = new Set(
      (
        await ctx.db.all<{ row_fingerprint: string }>(
          `SELECT m.row_fingerprint FROM media_records m JOIN processing_runs r ON r.run_id = m.run_id
           WHERE m.account_id = ? AND r.is_active = 1 AND r.file_id <> ?`,
          [file.account_id, input.fileId],
        )
      ).map((row) => row.row_fingerprint),
    );
    const existingKeys = new Set(
      (
        await ctx.db.all<{ business_key: string }>(
          `SELECT DISTINCT m.business_key FROM media_records m JOIN processing_runs r ON r.run_id = m.run_id
           WHERE m.account_id = ? AND r.is_active = 1 AND r.file_id <> ?`,
          [file.account_id, input.fileId],
        )
      ).map((row) => row.business_key),
    );

    const accepted: AcceptedRecord[] = [];
    const quarantine: QuarantineEntry[] = [];
    const issues: RowIssue[] = [];
    const runFingerprints = new Map<string, number>();
    const runKeys = new Set<string>();
    let rejected = 0;
    let duplicates = 0;
    let potential = 0;
    const total = table.detailRows.length;
    let processed = 0;

    for (const rows of chunk(table.detailRows, APP_CONFIG.processingChunkSize)) {
      for (const row of rows) {
        const result = transformSourceRow(row.sourceRowNumber, row.values, context);
        issues.push(...result.issues);
        if (!result.record) {
          rejected += 1;
          quarantine.push({
            sourceRowNumber: row.sourceRowNumber,
            sourceData: JSON.stringify(row.values),
            reason: result.issues
              .filter((issue) => issue.severity === 'error')
              .map((issue) => issue.message)
              .join(' '),
            reasonType: 'validation',
          });
          continue;
        }
        const record = result.record;
        const firstSeenRow = runFingerprints.get(record.rowFingerprint);
        if (firstSeenRow !== undefined || existingFingerprints.has(record.rowFingerprint)) {
          duplicates += 1;
          const origin = firstSeenRow !== undefined ? `row ${firstSeenRow} of this file` : 'a record already imported from another file for this account';
          const message = `Exact duplicate of ${origin}.`;
          issues.push({ sourceRowNumber: row.sourceRowNumber, fieldName: null, errorType: 'exact_duplicate', severity: 'warning', message });
          quarantine.push({ sourceRowNumber: row.sourceRowNumber, sourceData: JSON.stringify(row.values), reason: message, reasonType: 'exact_duplicate' });
          continue;
        }
        runFingerprints.set(record.rowFingerprint, row.sourceRowNumber);
        let duplicateFlag: AcceptedRecord['duplicateFlag'] = 'distinct';
        if (runKeys.has(record.businessKey) || existingKeys.has(record.businessKey)) {
          duplicateFlag = 'potential_business_key';
          potential += 1;
          issues.push({
            sourceRowNumber: row.sourceRowNumber,
            fieldName: null,
            errorType: 'potential_duplicate',
            severity: 'warning',
            message: 'Shares its business key (account, platform, month, campaign, ad group, placement, objective) with another record but has different metrics; kept as a distinct record for review.',
          });
        }
        runKeys.add(record.businessKey);
        accepted.push({ ...record, duplicateFlag });
      }
      processed += rows.length;
      onProgress?.({ stage: 'transforming', processedRows: processed, totalRows: total, message: `Validated ${processed} of ${total} rows` });
      await yieldToEventLoop();
    }

    onProgress?.({ stage: 'persisting', processedRows: total, totalRows: total, message: 'Saving records to the database' });
    const completedAt = ctx.clock.now().toISOString();
    const durationMs = Date.now() - startedMs;
    const missingClicks = accepted.filter((record) => record.clicks === null).length;
    const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
    let supersededRunId: number | null = null;
    await ctx.db.transaction(async (tx) => {
      const previous = await tx.first<ProcessingRunRow>('SELECT * FROM processing_runs WHERE file_id = ? AND is_active = 1', [input.fileId]);
      if (previous) {
        supersededRunId = previous.run_id;
        await tx.run("UPDATE processing_runs SET is_active = 0, status = 'superseded' WHERE run_id = ?", [previous.run_id]);
        await recordAuditEvent(
          tx,
          { eventType: 'processing.superseded', message: `Run ${previous.run_id} superseded by run ${runId}. Its records remain in history but are excluded from reporting.`, runId: previous.run_id, fileId: input.fileId, userId: actor.userId },
          completedAt,
        );
      }
      await insertMediaRecords(tx, accepted, runId, input.fileId, completedAt);
      await insertIssues(tx, issues, runId, completedAt);
      await insertQuarantine(tx, quarantine, runId, completedAt);
      await tx.run(
        `UPDATE processing_runs SET status = 'completed', is_active = 1, total_rows = ?, blank_rows = ?, summary_rows = ?, detail_rows = ?,
          accepted_rows = ?, rejected_rows = ?, duplicate_rows = ?, potential_duplicate_rows = ?, missing_click_rows = ?, duration_ms = ?, completed_at = ?
         WHERE run_id = ?`,
        [table.totalRowCount, table.blankRowCount, table.summaryRows.length, total, accepted.length, rejected, duplicates, potential, missingClicks, durationMs, completedAt, runId],
      );
      await tx.run("UPDATE uploaded_files SET status = 'processed' WHERE file_id = ?", [input.fileId]);
      if (table.summaryRows.length) {
        await recordAuditEvent(
          tx,
          {
            eventType: 'processing.summary_rows_excluded',
            message: `Excluded summary row${table.summaryRows.length === 1 ? '' : 's'} ${table.summaryRows.map((row) => row.sourceRowNumber).join(', ')} from campaign records.`,
            runId,
            fileId: input.fileId,
            userId: actor.userId,
          },
          completedAt,
        );
      }
      await recordAuditEvent(
        tx,
        {
          eventType: 'processing.completed',
          message: `Processed ${total} detail rows: ${accepted.length} accepted, ${rejected} quarantined, ${duplicates} duplicates, ${potential} potential duplicates, ${missingClicks} with missing clicks.`,
          severity: rejected > 0 ? 'warning' : 'info',
          runId,
          fileId: input.fileId,
          userId: actor.userId,
          entityType: 'run',
          entityId: runId,
        },
        completedAt,
      );
    });
    onProgress?.({ stage: 'completed', processedRows: total, totalRows: total, message: 'Processing complete' });
    return {
      runId,
      fileId: input.fileId,
      confirmationId: input.confirmationId,
      status: 'completed',
      totalRows: table.totalRowCount,
      blankRows: table.blankRowCount,
      summaryRows: table.summaryRows.length,
      detailRows: total,
      acceptedRows: accepted.length,
      rejectedRows: rejected,
      duplicateRows: duplicates,
      potentialDuplicateRows: potential,
      missingClickRows: missingClicks,
      warningCount,
      durationMs,
      supersededRunId,
      reconciled: total === accepted.length + rejected + duplicates && table.totalRowCount === total + table.summaryRows.length + table.blankRowCount,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedAt = isoNow(ctx);
    await ctx.db.transaction(async (tx) => {
      await tx.run("UPDATE processing_runs SET status = 'failed', is_active = 0, error_message = ?, completed_at = ?, duration_ms = ? WHERE run_id = ?", [
        message,
        failedAt,
        Date.now() - startedMs,
        runId,
      ]);
      const active = await tx.first<{ run_id: number }>('SELECT run_id FROM processing_runs WHERE file_id = ? AND is_active = 1', [input.fileId]);
      await tx.run('UPDATE uploaded_files SET status = ? WHERE file_id = ?', [active ? 'processed' : 'failed', input.fileId]);
      await recordAuditEvent(
        tx,
        { eventType: 'processing.failed', message: `Processing failed: ${message}`, severity: 'error', runId, fileId: input.fileId, userId: actor.userId, entityType: 'run', entityId: runId },
        failedAt,
      );
    });
    if (error instanceof ServiceError) {
      throw error;
    }
    throw new ServiceError('PROCESSING_FAILED', `Processing failed: ${message}`, { runId });
  }
}
