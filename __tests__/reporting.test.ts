import * as XLSX from 'xlsx';
import Papa from 'papaparse';
import { listAuditLogs } from '../src/services/audit/auditService';
import { exportCleanData, exportProcessingReport } from '../src/services/reporting/exportService';
import { getDashboardStats, getProcessingHistory } from '../src/services/reporting/historyService';
import { getFilterOptions, getProcessingResults } from '../src/services/reporting/resultsService';
import { buildMetaXlsx, buildTikTokCsv, monthList } from './helpers/fixtures';
import { adminActor, createInitializedContext, getAccountId, TestContext, viewerActor } from './helpers/testContext';
import { importAndProcess } from './helpers/workflow';

describe('results, history and exports', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createInitializedContext();
    await importAndProcess(ctx, await getAccountId(ctx, 'tiktok'), 'tiktok.csv', buildTikTokCsv({ months: monthList('2025-01', 4) }));
    await importAndProcess(ctx, await getAccountId(ctx, 'meta'), 'meta.xlsx', buildMetaXlsx({ months: monthList('2025-01', 2), missingClickEvery: 2 }));
  });

  afterEach(async () => {
    await ctx.db.close();
  });

  it('queries stored records with totals and pagination', async () => {
    const page = await getProcessingResults(ctx, { pageSize: 5, page: 2 });
    const all = await ctx.db.first<{ total: number; spend: number; clicks: number }>('SELECT COUNT(*) AS total, SUM(spend_zar) AS spend, SUM(clicks) AS clicks FROM media_records');
    expect(page.totals.recordCount).toBe(all!.total);
    expect(page.totals.spendZar).toBeCloseTo(all!.spend, 6);
    expect(page.totals.clicks).toBe(all!.clicks);
    expect(page.totals.missingClickRecords).toBe(3);
    expect(page.totals.conversions).toBeNull();
    expect(page.items).toHaveLength(5);
    expect(page.page).toBe(2);
    expect(page.totalPages).toBe(Math.ceil(all!.total / 5));
  });

  it('filters by platform, campaign type and month range', async () => {
    const page = await getProcessingResults(ctx, { platform: 'Meta', campaignType: 'Traffic', monthFrom: '2025-02', monthTo: '2025-02', pageSize: 100 });
    expect(page.items.length).toBe(2);
    expect(page.items.every((item) => item.platform === 'Meta' && item.campaign_type === 'Traffic' && item.report_month === '2025-02')).toBe(true);
    const options = await getFilterOptions(ctx);
    expect(options.platforms).toEqual(['Meta', 'TikTok']);
    expect(options.months[0]).toBe('2025-04');
  });

  it('searches campaign names and related fields', async () => {
    const byCampaign = await getProcessingResults(ctx, { search: 'reach push', pageSize: 100 });
    expect(byCampaign.items.length).toBe(4);
    expect(byCampaign.items.every((item) => item.campaign_name === 'Synthetic Reach Push')).toBe(true);
    const byPlacement = await getProcessingResults(ctx, { search: 'instagram', pageSize: 100 });
    expect(byPlacement.items.every((item) => item.placement === 'Instagram')).toBe(true);
    const literal = await getProcessingResults(ctx, { search: '100%', pageSize: 100 });
    expect(literal.items).toHaveLength(0);
  });

  it('sorts by spend, clicks and month', async () => {
    const bySpend = await getProcessingResults(ctx, { sort: 'spend_zar', direction: 'desc', pageSize: 100 });
    const spends = bySpend.items.map((item) => item.spend_zar as number);
    expect(spends).toEqual([...spends].sort((a, b) => b - a));
    const byClicks = await getProcessingResults(ctx, { sort: 'clicks', direction: 'asc', pageSize: 100 });
    const clicks = byClicks.items.map((item) => item.clicks);
    const populated = clicks.filter((value): value is number => value !== null);
    expect(populated).toEqual([...populated].sort((a, b) => a - b));
    expect(clicks.slice(-3)).toEqual([null, null, null]);
    const byMonth = await getProcessingResults(ctx, { sort: 'report_month', direction: 'asc', pageSize: 100 });
    expect(byMonth.items[0].report_month).toBe('2025-01');
  });

  it('exports CSV that reconciles with the stored records', async () => {
    const exported = await exportCleanData(ctx, adminActor, { platform: 'TikTok' }, 'csv');
    const content = ctx.files.exports.get(exported.uri) as string;
    const parsed = Papa.parse<Record<string, string>>(content.replace(/^﻿/, ''), { header: true, skipEmptyLines: true });
    const stored = await ctx.db.first<{ total: number; spend: number }>("SELECT COUNT(*) AS total, SUM(spend_zar) AS spend FROM media_records WHERE platform = 'TikTok'");
    expect(parsed.data).toHaveLength(stored!.total);
    expect(exported.rowCount).toBe(stored!.total);
    const csvSpend = parsed.data.reduce((sum, row) => sum + Number(row.spend_zar), 0);
    expect(csvSpend).toBeCloseTo(stored!.spend, 6);
    expect(parsed.meta.fields).toContain('click_metric_type');
  });

  it('exports XLSX with blanks preserved for missing clicks', async () => {
    const exported = await exportCleanData(ctx, adminActor, { platform: 'Meta' }, 'xlsx');
    const workbook = XLSX.read(ctx.files.exports.get(exported.uri) as Uint8Array, { type: 'array' });
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets['Clean data'], { defval: null });
    expect(rows).toHaveLength(6);
    expect(rows.filter((row) => row.clicks === null)).toHaveLength(3);
    const log = await listAuditLogs(ctx.db, { eventType: 'export.clean_data' });
    expect(log).toHaveLength(1);
  });

  it('exports a processing report with reconciliation and error summary', async () => {
    const [run] = await getProcessingHistory(ctx, { limit: 1 });
    const exported = await exportProcessingReport(ctx, adminActor, run.run_id, 'xlsx');
    const workbook = XLSX.read(ctx.files.exports.get(exported.uri) as Uint8Array, { type: 'array' });
    expect(workbook.SheetNames).toEqual(['Summary', 'Error summary', 'Quarantined rows']);
    const summary = XLSX.utils.sheet_to_json<{ Field: string; Value: unknown }>(workbook.Sheets['Summary']);
    const lookup = Object.fromEntries(summary.map((row) => [row.Field, row.Value]));
    expect(lookup['Original file']).toBe('meta.xlsx');
    expect(lookup['Accepted rows']).toBe(6);
    expect(lookup['Summary rows excluded']).toBe(1);
    expect(lookup['Storage reconciles (stored = accepted)']).toBe('Yes');
  });

  it('blocks viewers from exporting and records history and dashboard stats', async () => {
    await expect(exportCleanData(ctx, viewerActor, {}, 'csv')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const history = await getProcessingHistory(ctx);
    expect(history).toHaveLength(2);
    const stats = await getDashboardStats(ctx);
    expect(stats.files).toBe(2);
    expect(stats.activeRecords).toBe(14);
    const events = (await listAuditLogs(ctx.db)).map((log) => log.event_type);
    expect(events).toEqual(expect.arrayContaining(['file.registered', 'mapping.confirmed', 'processing.started', 'processing.completed']));
  });
});
