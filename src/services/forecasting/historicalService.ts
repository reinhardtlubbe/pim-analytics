import { SqlValue } from '../../database/types';
import { ServiceContext } from '../context';
import { BaselineWindow, buildChannelBaseline, ChannelBaseline, ChannelHistory, determineAnchorMonth, MonthlyObservation } from './forecastEngine';
import { addMonths, addTotals, calculateMetrics, emptyTotals, monthRange, PerformanceMetrics, PerformanceTotals } from './metrics';

export interface HistoryFilter {
  clientId: number;
  accountId?: number | null;
  platforms?: string[];
  campaignTypes?: string[];
  channelKeys?: string[];
}

export async function loadChannelHistories(ctx: ServiceContext, filter: HistoryFilter): Promise<ChannelHistory[]> {
  const where = ["r.is_active = 1", "m.forecast_eligibility = 'eligible'", 'm.spend_zar IS NOT NULL', 'm.client_id = ?'];
  const params: SqlValue[] = [filter.clientId];
  if (filter.accountId) {
    where.push('m.account_id = ?');
    params.push(filter.accountId);
  }
  if (filter.platforms?.length) {
    where.push(`m.platform IN (${filter.platforms.map(() => '?').join(', ')})`);
    params.push(...filter.platforms);
  }
  if (filter.campaignTypes?.length) {
    where.push(`m.campaign_type IN (${filter.campaignTypes.map(() => '?').join(', ')})`);
    params.push(...filter.campaignTypes);
  }
  const rows = await ctx.db.all<{
    platform: string;
    campaign_type: string;
    report_month: string;
    spend: number;
    impressions: number;
    clicks: number | null;
    spend_with_clicks: number | null;
    impressions_with_clicks: number | null;
    conversions: number | null;
    clicks_with_conversions: number | null;
    row_count: number;
  }>(
    `SELECT m.platform, m.campaign_type, m.report_month,
       SUM(m.spend_zar) AS spend,
       SUM(m.impressions) AS impressions,
       SUM(m.clicks) AS clicks,
       SUM(CASE WHEN m.clicks IS NOT NULL THEN m.spend_zar ELSE 0 END) AS spend_with_clicks,
       SUM(CASE WHEN m.clicks IS NOT NULL THEN m.impressions ELSE 0 END) AS impressions_with_clicks,
       SUM(m.conversions) AS conversions,
       SUM(CASE WHEN m.conversions IS NOT NULL THEN m.clicks ELSE 0 END) AS clicks_with_conversions,
       COUNT(*) AS row_count
     FROM media_records m JOIN processing_runs r ON r.run_id = m.run_id
     WHERE ${where.join(' AND ')}
     GROUP BY m.platform, m.campaign_type, m.report_month
     ORDER BY m.platform, m.campaign_type, m.report_month`,
    params,
  );
  const histories = new Map<string, ChannelHistory>();
  rows.forEach((row) => {
    const key = `${row.platform}::${row.campaign_type}`;
    if (filter.channelKeys?.length && !filter.channelKeys.includes(key)) {
      return;
    }
    const history = histories.get(key) ?? { platform: row.platform, campaignType: row.campaign_type, observations: [] };
    const observation: MonthlyObservation = {
      month: row.report_month,
      spend: row.spend ?? 0,
      impressions: row.impressions ?? 0,
      clicks: row.clicks ?? 0,
      spendWithClicks: row.spend_with_clicks ?? 0,
      impressionsWithClicks: row.impressions_with_clicks ?? 0,
      conversions: row.conversions,
      clicksWithConversions: row.clicks_with_conversions ?? 0,
      rows: row.row_count,
    };
    history.observations.push(observation);
    histories.set(key, history);
  });
  return [...histories.values()];
}

export interface HistoricalMetricsGroup {
  key: string;
  label: string;
  totals: PerformanceTotals;
  metrics: PerformanceMetrics;
  monthsCovered: number;
}

export interface HistoricalMetricsResult {
  window: BaselineWindow;
  anchorMonth: string | null;
  windowMonths: string[];
  overall: HistoricalMetricsGroup | null;
  byChannel: ChannelBaseline[];
  byMonth: HistoricalMetricsGroup[];
  warnings: string[];
}

export async function calculateHistoricalMetrics(
  ctx: ServiceContext,
  filter: HistoryFilter & { window: BaselineWindow; targetMonth?: string },
): Promise<HistoricalMetricsResult> {
  const histories = await loadChannelHistories(ctx, filter);
  const latest = histories.flatMap((history) => history.observations.map((item) => item.month)).sort().pop() ?? null;
  const target = filter.targetMonth ?? (latest ? addMonths(latest, 1) : null);
  const anchorMonth = target ? determineAnchorMonth(histories, target) : null;
  if (!anchorMonth || !target) {
    return {
      window: filter.window,
      anchorMonth: null,
      windowMonths: [],
      overall: null,
      byChannel: [],
      byMonth: [],
      warnings: ['No eligible processed records are available for this selection.'],
    };
  }
  const windowMonths = monthRange(anchorMonth, filter.window);
  const windowSet = new Set(windowMonths);
  const byChannel = histories.map((history) => buildChannelBaseline(history, filter.window, target, anchorMonth)).filter((item) => item.totals.rows > 0);
  const monthTotals = new Map<string, PerformanceTotals>();
  histories.forEach((history) =>
    history.observations
      .filter((item) => windowSet.has(item.month))
      .forEach((item) => monthTotals.set(item.month, addTotals(monthTotals.get(item.month) ?? emptyTotals(), item))),
  );
  const byMonth = [...monthTotals.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([month, totals]) => ({ key: month, label: month, totals, metrics: calculateMetrics(totals), monthsCovered: 1 }));
  const overallTotals = byMonth.reduce((sum, item) => addTotals(sum, item.totals), emptyTotals());
  const warnings: string[] = [];
  if (byMonth.length < 3) {
    warnings.push(`Only ${byMonth.length} month${byMonth.length === 1 ? '' : 's'} of reliable history in the selected window. Treat these metrics with caution.`);
  }
  return {
    window: filter.window,
    anchorMonth,
    windowMonths,
    overall: byMonth.length ? { key: 'overall', label: 'All selected channels', totals: overallTotals, metrics: calculateMetrics(overallTotals), monthsCovered: byMonth.length } : null,
    byChannel,
    byMonth,
    warnings,
  };
}

export async function listForecastChannels(ctx: ServiceContext, clientId: number, accountId?: number | null): Promise<{ key: string; platform: string; campaignType: string; months: number }[]> {
  const histories = await loadChannelHistories(ctx, { clientId, accountId });
  return histories.map((history) => ({
    key: `${history.platform}::${history.campaignType}`,
    platform: history.platform,
    campaignType: history.campaignType,
    months: history.observations.length,
  }));
}
