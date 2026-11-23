import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { login } from '../src/services/auth/authService';
import { calculateHistoricalMetrics } from '../src/services/forecasting/historicalService';
import { saveForecastScenario } from '../src/services/forecasting/scenarioService';
import { exportCleanData } from '../src/services/reporting/exportService';
import { getRunReconciliation } from '../src/services/reporting/historyService';
import { getProcessingResults } from '../src/services/reporting/resultsService';
import { createInitializedContext, getAccountId, TestContext } from './helpers/testContext';
import { importAndProcess } from './helpers/workflow';

const fixtureDirectory = join(__dirname, '..', 'fixtures', 'synthetic');

describe('end-to-end use case with the synthetic fixture files', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createInitializedContext();
  });

  afterAll(async () => {
    await ctx.db.close();
  });

  it('logs in, imports both files, searches, exports and forecasts', async () => {
    const session = await login(ctx, 'admin@planitmedia.com', 'PlanIt2026!');
    expect(session.actor.roles).toContain('Administrator');

    const tiktok = await importAndProcess(ctx, await getAccountId(ctx, 'tiktok'), 'SYNTHETIC_tiktok_ads_sample.csv', new Uint8Array(readFileSync(join(fixtureDirectory, 'SYNTHETIC_tiktok_ads_sample.csv'))));
    expect(tiktok.inspection.summaryRows).toBe(1);
    expect(tiktok.inspection.detailRows).toBe(91);
    expect(tiktok.summary).toMatchObject({ acceptedRows: 90, rejectedRows: 1, reconciled: true });

    const meta = await importAndProcess(ctx, await getAccountId(ctx, 'meta'), 'SYNTHETIC_meta_client_sample.xlsx', new Uint8Array(readFileSync(join(fixtureDirectory, 'SYNTHETIC_meta_client_sample.xlsx'))));
    expect(meta.inspection.worksheetName).toBe('Raw Data Report');
    expect(meta.inspection.summaryRows).toBe(1);
    expect(meta.summary.acceptedRows).toBe(108);
    expect(meta.summary.missingClickRows).toBeGreaterThan(0);
    expect(await getRunReconciliation(ctx, meta.summary.runId)).toMatchObject({ sourceBalanced: true, outcomeBalanced: true, storageBalanced: true });

    const search = await getProcessingResults(ctx, { search: 'brand reach', pageSize: 50 });
    expect(search.totals.recordCount).toBe(18);

    const exported = await exportCleanData(ctx, session.actor, {}, 'csv');
    expect(exported.rowCount).toBe(198);

    const clientId = (await ctx.db.first<{ client_id: number }>('SELECT client_id FROM clients'))!.client_id;
    const metrics = await calculateHistoricalMetrics(ctx, { clientId, window: 12, targetMonth: '2025-12' });
    expect(metrics.byChannel.length).toBeGreaterThan(3);
    const scenario = await saveForecastScenario(ctx, session.actor, {
      scenarioName: 'Synthetic December',
      clientId,
      targetMonth: '2025-12',
      totalBudgetZar: 250000,
      baselineWindow: 6,
      channelKeys: metrics.byChannel.map((channel) => channel.key),
      allocationMode: 'recommended',
    });
    const recommended = scenario.result.recommended!;
    expect(recommended.lines.reduce((sum, line) => sum + line.percentage, 0)).toBeCloseTo(100, 6);
    expect(recommended.allocatedBudget).toBeCloseTo(250000, 2);
    expect(scenario.result.channels.some((channel) => channel.seasonality.applied)).toBe(true);
  });
});
