import { confirmMapping } from '../src/services/mapping/confirmationService';
import { mappingsFromSuggestions } from '../src/services/mapping/mappingEngine';
import { normaliseReportMonth, parseDecimal, parseWholeNumber } from '../src/services/processing/normalisers';
import { processUploadedFile } from '../src/services/processing/processingService';
import { dismissQuarantinedRecord, getQuarantinedRecords, getValidationErrors, reprocessQuarantinedRecord } from '../src/services/processing/quarantineService';
import { saveCurrencyRate } from '../src/services/reference/referenceService';
import { getRunReconciliation } from '../src/services/reporting/historyService';
import { classifyObjective } from '../src/config/objectiveRules';
import { buildMetaXlsx, buildTikTokCsv, buildTikTokRows } from './helpers/fixtures';
import { adminActor, createInitializedContext, getAccountId, TestContext } from './helpers/testContext';
import { importAndProcess, uploadBytes } from './helpers/workflow';

describe('normalisation helpers', () => {
  it('cleans numbers with currency symbols, thousands separators and parentheses', () => {
    expect(parseDecimal('R 1,234.50')).toEqual({ ok: true, value: 1234.5 });
    expect(parseDecimal('ZAR 12 500,75')).toEqual({ ok: true, value: 12500.75 });
    expect(parseDecimal('1.234.567')).toEqual({ ok: true, value: 1234567 });
    expect(parseDecimal('(250.00)')).toEqual({ ok: true, value: -250 });
    expect(parseDecimal('0')).toEqual({ ok: true, value: 0 });
    expect(parseDecimal('')).toEqual({ ok: true, value: null });
    expect(parseDecimal('-')).toEqual({ ok: true, value: null });
    expect(parseDecimal(null)).toEqual({ ok: true, value: null });
    expect(parseDecimal('abc').ok).toBe(false);
    expect(parseWholeNumber('12.5').ok).toBe(false);
  });

  it('normalises reporting periods to YYYY-MM', () => {
    expect(normaliseReportMonth('2025-03-01 - 2025-03-31')).toEqual({ ok: true, value: '2025-03' });
    expect(normaliseReportMonth('2025-03')).toEqual({ ok: true, value: '2025-03' });
    expect(normaliseReportMonth('March 2025')).toEqual({ ok: true, value: '2025-03' });
    expect(normaliseReportMonth('Mar-2025')).toEqual({ ok: true, value: '2025-03' });
    expect(normaliseReportMonth('15/03/2025')).toEqual({ ok: true, value: '2025-03' });
    expect(normaliseReportMonth('03/2025')).toEqual({ ok: true, value: '2025-03' });
    expect(normaliseReportMonth(45717)).toEqual({ ok: true, value: '2025-03' });
    expect(normaliseReportMonth(202503)).toEqual({ ok: true, value: '2025-03' });
    expect(normaliseReportMonth('next quarter').ok).toBe(false);
  });

  it('classifies objectives with configurable rules and keeps unknowns explicit', () => {
    expect(classifyObjective('OUTCOME_TRAFFIC')).toBe('Traffic');
    expect(classifyObjective('Link clicks')).toBe('Traffic');
    expect(classifyObjective('Reach')).toBe('Awareness');
    expect(classifyObjective('Video views')).toBe('Video Views');
    expect(classifyObjective('Lead generation')).toBe('Leads');
    expect(classifyObjective('Something novel')).toBe('Unknown');
  });
});

describe('processing pipeline', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createInitializedContext();
  });

  afterEach(async () => {
    await ctx.db.close();
  });

  it('processes a TikTok CSV end to end and reconciles every row', async () => {
    const accountId = await getAccountId(ctx, 'tiktok');
    const { summary } = await importAndProcess(ctx, accountId, 'tiktok.csv', buildTikTokCsv());
    const detail = buildTikTokRows().length;
    expect(summary).toMatchObject({ summaryRows: 1, detailRows: detail, acceptedRows: detail, rejectedRows: 0, duplicateRows: 0, reconciled: true });
    const stored = await ctx.db.all<{ platform: string; click_metric_type: string; currency: string; campaign_type: string; report_month: string }>(
      'SELECT platform, click_metric_type, currency, campaign_type, report_month FROM media_records ORDER BY record_id',
    );
    expect(stored).toHaveLength(detail);
    expect(stored[0]).toEqual({ platform: 'TikTok', click_metric_type: 'destination_click', currency: 'ZAR', campaign_type: 'Traffic', report_month: '2025-01' });
    expect(stored.some((row) => row.campaign_type === 'Awareness')).toBe(true);
    const reconciliation = await getRunReconciliation(ctx, summary.runId);
    expect(reconciliation).toMatchObject({ sourceBalanced: true, outcomeBalanced: true, storageBalanced: true });
  });

  it('keeps missing Meta click values as NULL, distinct from zero', async () => {
    const accountId = await getAccountId(ctx, 'meta');
    const { summary } = await importAndProcess(ctx, accountId, 'meta.xlsx', buildMetaXlsx({ missingClickEvery: 3 }));
    expect(summary.acceptedRows).toBe(9);
    expect(summary.missingClickRows).toBe(3);
    const nullClicks = await ctx.db.first<{ total: number }>('SELECT COUNT(*) AS total FROM media_records WHERE clicks IS NULL');
    const zeroClicks = await ctx.db.first<{ total: number }>('SELECT COUNT(*) AS total FROM media_records WHERE clicks = 0');
    expect(nullClicks?.total).toBe(3);
    expect(zeroClicks?.total).toBe(0);
    const record = await ctx.db.first<{ platform: string; placement: string; click_metric_type: string; currency: string; campaign_name: string | null }>(
      'SELECT platform, placement, click_metric_type, currency, campaign_name FROM media_records ORDER BY record_id LIMIT 1',
    );
    expect(record).toEqual({ platform: 'Meta', placement: 'Facebook', click_metric_type: 'link_click', currency: 'ZAR', campaign_name: null });
  });

  it('quarantines invalid rows with errors instead of discarding them', async () => {
    const accountId = await getAccountId(ctx, 'tiktok');
    const extraRows = [
      ['Bad Month', 'Traffic', 'not-a-month', 'AG', 'Automatic placement', '10', '100', '5', 'ZAR'],
      ['Negative Spend', 'Traffic', '2025-02', 'AG', 'Automatic placement', '-10', '100', '5', 'ZAR'],
      ['Text Impressions', 'Traffic', '2025-02', 'AG', 'Automatic placement', '10', 'lots', '5', 'ZAR'],
      ['Zero Spend Legit', 'Traffic', '2025-02', 'AG2', 'Automatic placement', '0', '100', '0', 'ZAR'],
    ];
    const { summary } = await importAndProcess(ctx, accountId, 'tiktok-bad.csv', buildTikTokCsv({ extraRows }));
    expect(summary.rejectedRows).toBe(3);
    expect(summary.acceptedRows).toBe(buildTikTokRows().length + 1);
    expect(summary.reconciled).toBe(true);
    const zero = await ctx.db.first<{ spend_zar: number; clicks: number }>("SELECT spend_zar, clicks FROM media_records WHERE campaign_name = 'Zero Spend Legit'");
    expect(zero).toEqual({ spend_zar: 0, clicks: 0 });
    const quarantine = await getQuarantinedRecords(ctx, { runId: summary.runId });
    expect(quarantine).toHaveLength(3);
    expect(quarantine.every((row) => row.status === 'pending_review' && row.reason_type === 'validation')).toBe(true);
    expect(JSON.parse(quarantine[0].source_data_json)['Campaign name']).toBe('Bad Month');
    const errors = await getValidationErrors(ctx, { runId: summary.runId, severity: 'error' });
    expect(errors.map((error) => error.error_type).sort()).toEqual(['invalid_date', 'invalid_number', 'negative_value']);
    expect(errors[0].original_filename).toBe('tiktok-bad.csv');
  });

  it('detects exact duplicates and flags business-key duplicates without merging them', async () => {
    const accountId = await getAccountId(ctx, 'tiktok');
    const base = buildTikTokRows({ months: ['2025-01'] });
    const extraRows = [base[0], [...base[0].slice(0, 5), '999.99', '5000', '50', 'ZAR']];
    const { summary } = await importAndProcess(ctx, accountId, 'dupes.csv', buildTikTokCsv({ months: ['2025-01'], extraRows }));
    expect(summary.duplicateRows).toBe(1);
    expect(summary.potentialDuplicateRows).toBe(1);
    expect(summary.acceptedRows).toBe(base.length + 1);
    expect(summary.reconciled).toBe(true);
    const duplicates = await getQuarantinedRecords(ctx, { reasonType: 'exact_duplicate' });
    expect(duplicates).toHaveLength(1);
    const flagged = await ctx.db.first<{ total: number }>("SELECT COUNT(*) AS total FROM media_records WHERE duplicate_flag = 'potential_business_key'");
    expect(flagged?.total).toBe(1);
  });

  it('detects cross-file exact duplicates for the same advertising account', async () => {
    const accountId = await getAccountId(ctx, 'tiktok');
    await importAndProcess(ctx, accountId, 'jan-feb.csv', buildTikTokCsv({ months: ['2025-01', '2025-02'] }));
    const { summary } = await importAndProcess(ctx, accountId, 'feb-mar.csv', buildTikTokCsv({ months: ['2025-02', '2025-03'] }));
    expect(summary.duplicateRows).toBe(0);
    const overlapping = buildTikTokRows({ months: ['2025-01'] });
    const third = await importAndProcess(ctx, accountId, 'jan-again.csv', buildTikTokCsv({ months: ['2025-01'], extraRows: [['Other', 'Traffic', '2025-04', 'X', 'Y', '1', '1', '1', 'ZAR']] }));
    expect(third.summary.duplicateRows).toBe(overlapping.length);
  });

  it('reprocesses safely: supersedes the earlier run and keeps history', async () => {
    const accountId = await getAccountId(ctx, 'tiktok');
    const { inspection, summary, confirmationId } = await importAndProcess(ctx, accountId, 'tiktok.csv', buildTikTokCsv());
    const second = await processUploadedFile(ctx, adminActor, { fileId: inspection.fileId, confirmationId });
    expect(second.supersededRunId).toBe(summary.runId);
    expect(second.duplicateRows).toBe(0);
    const runs = await ctx.db.all<{ run_id: number; status: string; is_active: number }>('SELECT run_id, status, is_active FROM processing_runs ORDER BY run_id');
    expect(runs).toEqual([
      { run_id: summary.runId, status: 'superseded', is_active: 0 },
      { run_id: second.runId, status: 'completed', is_active: 1 },
    ]);
    const active = await ctx.db.first<{ total: number }>('SELECT COUNT(*) AS total FROM media_records m JOIN processing_runs r ON r.run_id = m.run_id WHERE r.is_active = 1');
    expect(active?.total).toBe(second.acceptedRows);
  });

  it('prevents conflicting runs of the same file', async () => {
    const accountId = await getAccountId(ctx, 'tiktok');
    const inspection = await uploadBytes(ctx, accountId, 'tiktok.csv', buildTikTokCsv());
    const confirmation = await confirmMapping(ctx, adminActor, { fileId: inspection.fileId, columnMappings: mappingsFromSuggestions(inspection.suggestions) });
    await ctx.db.run("INSERT INTO processing_runs (file_id, confirmation_id, status, is_active, started_at) VALUES (?, ?, 'running', 0, 'x')", [
      inspection.fileId,
      confirmation.confirmationId,
    ]);
    await expect(processUploadedFile(ctx, adminActor, { fileId: inspection.fileId, confirmationId: confirmation.confirmationId })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('rolls back all records when persistence fails', async () => {
    const accountId = await getAccountId(ctx, 'tiktok');
    const inspection = await uploadBytes(ctx, accountId, 'tiktok.csv', buildTikTokCsv());
    const confirmation = await confirmMapping(ctx, adminActor, { fileId: inspection.fileId, columnMappings: mappingsFromSuggestions(inspection.suggestions) });
    await ctx.db.exec("CREATE TRIGGER fail_late BEFORE INSERT ON quarantined_records BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END");
    await ctx.db.exec("CREATE TRIGGER fail_on_complete BEFORE UPDATE OF status ON processing_runs WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END");
    await expect(processUploadedFile(ctx, adminActor, { fileId: inspection.fileId, confirmationId: confirmation.confirmationId })).rejects.toThrow(/simulated/);
    const records = await ctx.db.first<{ total: number }>('SELECT COUNT(*) AS total FROM media_records');
    expect(records?.total).toBe(0);
    const run = await ctx.db.first<{ status: string; is_active: number }>('SELECT status, is_active FROM processing_runs');
    expect(run).toEqual({ status: 'failed', is_active: 0 });
  });

  it('converts non-ZAR spend only with a dated rate and otherwise excludes it from ZAR forecasting', async () => {
    const accountId = await getAccountId(ctx, 'tiktok');
    await saveCurrencyRate(ctx, adminActor, { currencyCode: 'USD', rateToZar: 18.5, rateDate: '2025-01-31', source: 'Test rate' });
    const { summary } = await importAndProcess(ctx, accountId, 'usd.csv', buildTikTokCsv({ months: ['2025-01'], currency: 'USD', extraRows: [['Old', 'Traffic', '2024-06', 'AG', 'Auto', '10', '100', '1', 'USD']] }));
    expect(summary.acceptedRows).toBe(3);
    const converted = await ctx.db.first<{ spend_zar: number; spend_original: number; fx_rate: number; currency: string; forecast_eligibility: string }>(
      "SELECT spend_zar, spend_original, fx_rate, currency, forecast_eligibility FROM media_records WHERE report_month = '2025-01' ORDER BY record_id LIMIT 1",
    );
    expect(converted).toEqual({ spend_zar: 18500, spend_original: 1000, fx_rate: 18.5, currency: 'USD', forecast_eligibility: 'eligible' });
    const excluded = await ctx.db.first<{ spend_zar: number | null; forecast_eligibility: string }>(
      "SELECT spend_zar, forecast_eligibility FROM media_records WHERE report_month = '2024-06'",
    );
    expect(excluded).toEqual({ spend_zar: null, forecast_eligibility: 'excluded_no_fx_rate' });
  });

  it('lets a reviewer correct a quarantined row while preserving the original audit trail', async () => {
    const accountId = await getAccountId(ctx, 'tiktok');
    const extraRows = [['Fix Me', 'Traffic', 'bad month', 'AG9', 'Automatic placement', '10', '100', '5', 'ZAR']];
    const { summary } = await importAndProcess(ctx, accountId, 'fix.csv', buildTikTokCsv({ extraRows }));
    const [entry] = await getQuarantinedRecords(ctx, { runId: summary.runId });
    await expect(reprocessQuarantinedRecord(ctx, adminActor, entry.quarantine_id, { 'By month': 'still bad' })).rejects.toMatchObject({ code: 'VALIDATION' });
    const { recordId } = await reprocessQuarantinedRecord(ctx, adminActor, entry.quarantine_id, { 'By month': '2025-02' });
    const record = await ctx.db.first<{ report_month: string; campaign_name: string }>('SELECT report_month, campaign_name FROM media_records WHERE record_id = ?', [recordId]);
    expect(record).toEqual({ report_month: '2025-02', campaign_name: 'Fix Me' });
    const [resolved] = await getQuarantinedRecords(ctx, { runId: summary.runId });
    expect(resolved.status).toBe('resolved');
    expect(JSON.parse(resolved.source_data_json)['By month']).toBe('bad month');
    const reconciliation = await getRunReconciliation(ctx, summary.runId);
    expect(reconciliation).toMatchObject({ rejectedRows: 0, outcomeBalanced: true, storageBalanced: true });
    await expect(dismissQuarantinedRecord(ctx, adminActor, entry.quarantine_id, 'again')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('handles 10,000 rows within a reasonable time', async () => {
    const accountId = await getAccountId(ctx, 'tiktok');
    const extraRows = Array.from({ length: 10000 }, (_, index) => [
      `Bulk ${index}`,
      index % 2 ? 'Traffic' : 'Reach',
      `2024-${String((index % 12) + 1).padStart(2, '0')}`,
      `AG ${index}`,
      'Automatic placement',
      String(100 + (index % 50)),
      String(10000 + index),
      String(100 + (index % 30)),
      'ZAR',
    ]);
    const started = Date.now();
    const { summary } = await importAndProcess(ctx, accountId, 'bulk.csv', buildTikTokCsv({ months: [], extraRows }));
    expect(summary.acceptedRows).toBe(10000);
    expect(summary.reconciled).toBe(true);
    expect(Date.now() - started).toBeLessThan(20000);
  });
});
