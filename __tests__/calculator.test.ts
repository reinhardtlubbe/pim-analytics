import { calculateBudgetForecast, ChannelHistory, fitDiminishingReturns, recommendAllocation, reconcileAmounts, reverseCalculate, buildChannelBaseline } from '../src/services/forecasting/forecastEngine';
import { calculateHistoricalMetrics } from '../src/services/forecasting/historicalService';
import { calculateMetrics, emptyTotals } from '../src/services/forecasting/metrics';
import {
  compareForecastScenarios,
  deleteForecastScenario,
  getForecastScenario,
  listForecastScenarios,
  saveForecastScenario,
  ScenarioInput,
  updateForecastScenario,
} from '../src/services/forecasting/scenarioService';
import { buildTikTokCsv, monthList } from './helpers/fixtures';
import { adminActor, createInitializedContext, createTestContext, getAccountId, TestContext, viewerActor } from './helpers/testContext';
import { importAndProcess } from './helpers/workflow';
import { initializeDatabase } from '../src/database/initialize';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function observation(month: string, spend: number, clicks: number | null, impressions: number) {
  return {
    month,
    spend,
    impressions,
    clicks: clicks ?? 0,
    spendWithClicks: clicks === null ? 0 : spend,
    impressionsWithClicks: clicks === null ? 0 : impressions,
    conversions: null,
    clicksWithConversions: 0,
    rows: 1,
  };
}

describe('historical metrics', () => {
  it('calculates CPC, CPM and CTR from aggregate totals', () => {
    const totals = { ...emptyTotals(), spend: 3000, impressions: 400000, clicks: 1500, spendWithClicks: 3000, impressionsWithClicks: 400000, rows: 2 };
    const metrics = calculateMetrics(totals);
    expect(metrics.cpc.value).toBeCloseTo(2, 10);
    expect(metrics.cpm.value).toBeCloseTo(7.5, 10);
    expect(metrics.ctr.value).toBeCloseTo(0.375, 10);
    expect(metrics.conversionRate.value).toBeNull();
    expect(metrics.conversionRate.unavailableReason).toMatch(/conversion/);
  });

  it('does not average row-level rates', () => {
    const rowA = { ...emptyTotals(), spend: 100, clicks: 100, spendWithClicks: 100, impressions: 1000, impressionsWithClicks: 1000, rows: 1 };
    const rowB = { ...emptyTotals(), spend: 900, clicks: 100, spendWithClicks: 900, impressions: 1000, impressionsWithClicks: 1000, rows: 1 };
    const combined = { ...emptyTotals(), spend: 1000, clicks: 200, spendWithClicks: 1000, impressions: 2000, impressionsWithClicks: 2000, rows: 2 };
    expect(calculateMetrics(combined).cpc.value).toBe(5);
    expect(((calculateMetrics(rowA).cpc.value as number) + (calculateMetrics(rowB).cpc.value as number)) / 2).toBe(5);
    const skewed = { ...emptyTotals(), spend: 1000, clicks: 110, spendWithClicks: 1000, impressions: 2000, impressionsWithClicks: 2000, rows: 2 };
    expect(calculateMetrics(skewed).cpc.value).toBeCloseTo(1000 / 110, 10);
  });

  it('returns unavailable values instead of dividing by zero', () => {
    const metrics = calculateMetrics({ ...emptyTotals(), spend: 500, impressions: 0, rows: 1 });
    expect(metrics.cpc.value).toBeNull();
    expect(metrics.cpm.value).toBeNull();
    expect(metrics.ctr.value).toBeNull();
    expect(metrics.cpc.unavailableReason).toBeTruthy();
  });

  it('excludes rows with missing clicks from CPC rather than treating them as zero', () => {
    const history: ChannelHistory = {
      platform: 'Meta',
      campaignType: 'Traffic',
      observations: [observation('2025-01', 1000, 500, 100000), observation('2025-02', 1000, null, 100000), observation('2025-03', 1000, 500, 100000)],
    };
    const baseline = buildChannelBaseline(history, 3, '2025-04', '2025-03');
    expect(baseline.metrics.cpc.value).toBe(2);
    expect(baseline.metrics.cpm.value).toBe(10);
    expect(baseline.metrics.ctr.value).toBeCloseTo(0.5, 10);
  });

  it('applies 3, 6 and 12 month baseline windows and warns when history is short', () => {
    const months = monthList('2024-01', 12);
    const history: ChannelHistory = {
      platform: 'TikTok',
      campaignType: 'Traffic',
      observations: months.map((month, index) => observation(month, 1000, index < 6 ? 1000 : 500, 100000)),
    };
    expect(buildChannelBaseline(history, 3, '2025-01', '2024-12').metrics.cpc.value).toBe(2);
    expect(buildChannelBaseline(history, 6, '2025-01', '2024-12').metrics.cpc.value).toBe(2);
    expect(buildChannelBaseline(history, 12, '2025-01', '2024-12').metrics.cpc.value).toBeCloseTo(12000 / 9000, 10);
    const short: ChannelHistory = { ...history, observations: history.observations.slice(-2) };
    const baseline = buildChannelBaseline(short, 6, '2025-01', '2024-12');
    expect(baseline.monthsCovered).toBe(2);
    expect(baseline.warnings.join(' ')).toMatch(/Only 2 months/);
  });
});

describe('forecasting engine', () => {
  const months = monthList('2024-01', 18);
  const traffic: ChannelHistory = {
    platform: 'TikTok',
    campaignType: 'Traffic',
    observations: months.map((month, index) => {
      const spend = 1000 + (index % 6) * 800;
      const seasonal = month.endsWith('-11') ? 0.7 : 1;
      return observation(month, spend, Math.round(60 * Math.pow(spend, 0.6) * seasonal), spend * 100);
    }),
  };
  const awareness: ChannelHistory = {
    platform: 'Meta',
    campaignType: 'Awareness',
    observations: months.map((month) => observation(month, 2000, 400, 500000)),
  };

  it('calculates a seasonality index when twelve months of history exist', () => {
    const result = calculateBudgetForecast({ totalBudget: 10000, targetMonth: '2025-11', window: 6, histories: [traffic] });
    const channel = result.channels[0];
    expect(channel.seasonality.applied).toBe(true);
    expect(channel.seasonality.index as number).toBeGreaterThan(1);
    expect(channel.adjustedCpc as number).toBeCloseTo((channel.metrics.cpc.value as number) * (channel.seasonality.index as number), 8);
  });

  it('explains when seasonality cannot be calculated', () => {
    const short: ChannelHistory = { ...traffic, observations: traffic.observations.slice(-5) };
    const result = calculateBudgetForecast({ totalBudget: 10000, targetMonth: '2025-07', window: 3, histories: [short] });
    expect(result.channels[0].seasonality.applied).toBe(false);
    expect(result.channels[0].seasonality.explanation).toMatch(/unadjusted baseline/);
  });

  it('models diminishing returns and identifies the 25% marginal CPC threshold', () => {
    const model = fitDiminishingReturns(traffic, '2025-06');
    expect(model.modelled).toBe(true);
    expect(model.exponent as number).toBeGreaterThan(0.4);
    expect(model.exponent as number).toBeLessThan(0.8);
    const reference = model.referenceSpend as number;
    const threshold = model.thresholdSpend as number;
    const marginal = (spend: number) => 1 / ((model.coefficient as number) * (model.exponent as number) * Math.pow(spend, (model.exponent as number) - 1));
    expect(marginal(threshold) / marginal(reference)).toBeCloseTo(1.25, 6);
  });

  it('does not fabricate a threshold without enough evidence', () => {
    const model = fitDiminishingReturns({ ...traffic, observations: traffic.observations.slice(0, 4) }, '2025-06');
    expect(model.modelled).toBe(false);
    expect(model.thresholdSpend).toBeNull();
    expect(model.explanation).toMatch(/at least 6/);
  });

  it('produces low, expected and high scenarios with recorded assumptions', () => {
    const result = calculateBudgetForecast({ totalBudget: 20000, targetMonth: '2025-07', window: 6, histories: [traffic, awareness] });
    const plan = result.recommended;
    expect(plan).not.toBeNull();
    expect(plan!.clicks.low).toBeLessThan(plan!.clicks.expected);
    expect(plan!.clicks.expected).toBeLessThan(plan!.clicks.high);
    expect(result.assumptions.length).toBeGreaterThan(3);
  });

  it('recommends an allocation whose percentages total 100% and amounts reconcile to the budget', () => {
    const result = calculateBudgetForecast({ totalBudget: 12345.67, targetMonth: '2025-07', window: 6, histories: [traffic, awareness] });
    const lines = result.recommended!.lines;
    expect(lines.reduce((sum, line) => sum + line.percentage, 0)).toBeCloseTo(100, 6);
    expect(Math.round(lines.reduce((sum, line) => sum + line.amount, 0) * 100)).toBe(1234567);
    const amounts = reconcileAmounts(100, [
      { key: 'a', weight: 1 },
      { key: 'b', weight: 1 },
      { key: 'c', weight: 1 },
    ]);
    expect(amounts.reduce((sum, item) => sum + item.amount, 0)).toBeCloseTo(100, 10);
    expect(amounts.reduce((sum, item) => sum + item.percentage, 0)).toBeCloseTo(100, 10);
  });

  it('caps recommended spend at the diminishing-returns threshold when other channels can absorb budget', () => {
    const result = calculateBudgetForecast({ totalBudget: 60000, targetMonth: '2025-07', window: 6, histories: [traffic, awareness] });
    const trafficLine = result.recommended!.lines.find((line) => line.campaignType === 'Traffic')!;
    expect(trafficLine.amount).toBeLessThanOrEqual((trafficLine.thresholdSpend as number) + 0.01);
  });

  it('recalculates manual allocations and validates the 100% rule', () => {
    const keys = ['TikTok::Traffic', 'Meta::Awareness'];
    const result = calculateBudgetForecast({
      totalBudget: 10000,
      targetMonth: '2025-07',
      window: 6,
      histories: [traffic, awareness],
      manualPercentages: { [keys[0]]: 25, [keys[1]]: 75 },
    });
    expect(result.manual!.lines.find((line) => line.key === keys[1])!.amount).toBe(7500);
    expect(result.manual!.blendedCpc).not.toBeNull();
    expect(() =>
      calculateBudgetForecast({ totalBudget: 10000, targetMonth: '2025-07', window: 6, histories: [traffic, awareness], manualPercentages: { [keys[0]]: 30, [keys[1]]: 30 } }),
    ).toThrow(/total 100%/);
  });

  it('reverse-calculates the budget required for a click target', () => {
    const result = calculateBudgetForecast({ totalBudget: 10000, targetMonth: '2025-07', window: 6, histories: [traffic, awareness] });
    const reverse = reverseCalculate(result.channels, 'clicks', result.recommended!.clicks.expected);
    expect(reverse.requiredBudget).not.toBeNull();
    expect(Math.abs((reverse.requiredBudget as number) - 10000)).toBeLessThan(5);
    const conversions = reverseCalculate(result.channels, 'conversions', 100);
    expect(conversions.requiredBudget).toBeNull();
    expect(conversions.warnings[0]).toMatch(/no conversion data/);
  });

  it('returns warnings instead of invented results when there is no history', () => {
    const result = calculateBudgetForecast({ totalBudget: 1000, targetMonth: '2025-01', window: 3, histories: [] });
    expect(result.recommended).toBeNull();
    expect(result.warnings[0]).toMatch(/cannot be produced/);
    expect(recommendAllocation([], 1000)).toBeNull();
  });
});

describe('forecast scenarios persisted in SQLite', () => {
  let ctx: TestContext;
  let clientId: number;
  let baseInput: ScenarioInput;

  beforeEach(async () => {
    ctx = await createInitializedContext();
    const accountId = await getAccountId(ctx, 'tiktok');
    await importAndProcess(ctx, accountId, 'history.csv', buildTikTokCsv({ months: monthList('2024-06', 8) }));
    clientId = (await ctx.db.first<{ client_id: number }>('SELECT client_id FROM clients'))!.client_id;
    baseInput = {
      scenarioName: 'February push',
      clientId,
      targetMonth: '2025-02',
      totalBudgetZar: 50000,
      baselineWindow: 3,
      channelKeys: ['TikTok::Traffic', 'TikTok::Awareness'],
      allocationMode: 'recommended',
    };
  });

  afterEach(async () => {
    await ctx.db.close();
  });

  it('calculates historical metrics from stored records', async () => {
    const metrics = await calculateHistoricalMetrics(ctx, { clientId, window: 3, targetMonth: '2025-02' });
    expect(metrics.anchorMonth).toBe('2025-01');
    expect(metrics.windowMonths).toEqual(['2024-11', '2024-12', '2025-01']);
    expect(metrics.byChannel.map((channel) => channel.key).sort()).toEqual(['TikTok::Awareness', 'TikTok::Traffic']);
    const stored = await ctx.db.first<{ spend: number; clicks: number }>(
      "SELECT SUM(spend_zar) AS spend, SUM(clicks) AS clicks FROM media_records WHERE report_month BETWEEN '2024-11' AND '2025-01'",
    );
    expect(metrics.overall!.metrics.cpc.value).toBeCloseTo(stored!.spend / stored!.clicks, 10);
  });

  it('creates, reads, updates, compares and deletes scenarios', async () => {
    const saved = await saveForecastScenario(ctx, adminActor, baseInput);
    expect(saved.allocations.filter((row) => row.allocation_type === 'recommended')).toHaveLength(2);
    expect(saved.allocations.reduce((sum, row) => sum + row.allocated_budget_zar, 0)).toBeCloseTo(50000, 2);
    expect((await getForecastScenario(ctx, saved.scenarioId)).parameters.totalBudgetZar).toBe(50000);

    const updated = await updateForecastScenario(ctx, adminActor, saved.scenarioId, {
      ...baseInput,
      scenarioName: 'February push (manual)',
      totalBudgetZar: 80000,
      allocationMode: 'manual',
      manualPercentages: { 'TikTok::Traffic': 60, 'TikTok::Awareness': 40 },
    });
    expect(updated.scenarioName).toBe('February push (manual)');
    const manualRows = updated.allocations.filter((row) => row.allocation_type === 'manual');
    expect(manualRows.find((row) => row.campaign_type === 'Traffic')!.allocated_budget_zar).toBe(48000);

    const second = await saveForecastScenario(ctx, adminActor, { ...baseInput, scenarioName: 'Lower budget', totalBudgetZar: 20000 });
    const comparison = await compareForecastScenarios(ctx, [updated.scenarioId, second.scenarioId]);
    expect(comparison[0].expectedClicks as number).toBeGreaterThan(comparison[1].expectedClicks as number);

    await deleteForecastScenario(ctx, adminActor, second.scenarioId);
    const remaining = await listForecastScenarios(ctx);
    expect(remaining.map((scenario) => scenario.scenarioId)).toEqual([updated.scenarioId]);
    const orphanAllocations = await ctx.db.first<{ total: number }>('SELECT COUNT(*) AS total FROM forecast_allocations WHERE scenario_id = ?', [second.scenarioId]);
    expect(orphanAllocations!.total).toBe(0);
  });

  it('stops viewers from saving scenarios but lets them read', async () => {
    await expect(saveForecastScenario(ctx, viewerActor, baseInput)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await saveForecastScenario(ctx, adminActor, baseInput);
    expect(await listForecastScenarios(ctx)).toHaveLength(1);
  });

  it('refuses to save a scenario when there is no eligible history', async () => {
    await expect(saveForecastScenario(ctx, adminActor, { ...baseInput, targetMonth: '2024-01' })).rejects.toMatchObject({ code: 'INSUFFICIENT_DATA' });
  });
});

describe('scenario persistence across restarts', () => {
  it('keeps scenarios after the database is closed and reopened', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'planit-scenario-'));
    const path = join(directory, 'app.db');
    const first = createTestContext(path);
    await initializeDatabase(first);
    const accountId = await getAccountId(first, 'tiktok');
    await importAndProcess(first, accountId, 'history.csv', buildTikTokCsv({ months: monthList('2024-06', 6) }));
    const clientId = (await first.db.first<{ client_id: number }>('SELECT client_id FROM clients'))!.client_id;
    const saved = await saveForecastScenario(first, adminActor, {
      scenarioName: 'Persisted',
      clientId,
      targetMonth: '2024-12',
      totalBudgetZar: 10000,
      baselineWindow: 3,
      channelKeys: ['TikTok::Traffic'],
      allocationMode: 'recommended',
    });
    await first.db.close();

    const second = createTestContext(path, first.files);
    await initializeDatabase(second);
    const reloaded = await getForecastScenario(second, saved.scenarioId);
    expect(reloaded.scenarioName).toBe('Persisted');
    expect(reloaded.result.recommended!.clicks.expected).toBeCloseTo(saved.result.recommended!.clicks.expected, 6);
    const records = await second.db.first<{ total: number }>('SELECT COUNT(*) AS total FROM media_records');
    expect(records!.total).toBe(12);
    await second.db.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
