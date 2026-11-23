export interface MetricValue {
  value: number | null;
  unavailableReason?: string;
}

export interface PerformanceTotals {
  spend: number;
  impressions: number;
  clicks: number;
  spendWithClicks: number;
  impressionsWithClicks: number;
  conversions: number | null;
  clicksWithConversions: number;
  rows: number;
}

export interface PerformanceMetrics {
  cpc: MetricValue;
  cpm: MetricValue;
  ctr: MetricValue;
  conversionRate: MetricValue;
}

export function emptyTotals(): PerformanceTotals {
  return { spend: 0, impressions: 0, clicks: 0, spendWithClicks: 0, impressionsWithClicks: 0, conversions: null, clicksWithConversions: 0, rows: 0 };
}

export function addTotals(target: PerformanceTotals, source: PerformanceTotals): PerformanceTotals {
  return {
    spend: target.spend + source.spend,
    impressions: target.impressions + source.impressions,
    clicks: target.clicks + source.clicks,
    spendWithClicks: target.spendWithClicks + source.spendWithClicks,
    impressionsWithClicks: target.impressionsWithClicks + source.impressionsWithClicks,
    conversions: target.conversions === null && source.conversions === null ? null : (target.conversions ?? 0) + (source.conversions ?? 0),
    clicksWithConversions: target.clicksWithConversions + source.clicksWithConversions,
    rows: target.rows + source.rows,
  };
}

function ratio(numerator: number, denominator: number, multiplier: number, reason: string): MetricValue {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return { value: null, unavailableReason: reason };
  }
  return { value: (numerator / denominator) * multiplier };
}

export function calculateCpc(totals: PerformanceTotals): MetricValue {
  if (totals.clicks <= 0) {
    return { value: null, unavailableReason: totals.spendWithClicks > 0 || totals.spend > 0 ? 'No clicks were recorded, so CPC cannot be calculated.' : 'No spend or clicks in this period.' };
  }
  return ratio(totals.spendWithClicks, totals.clicks, 1, 'No clicks were recorded.');
}

export function calculateCpm(totals: PerformanceTotals): MetricValue {
  return ratio(totals.spend, totals.impressions, 1000, 'No impressions were recorded, so CPM cannot be calculated.');
}

export function calculateCtr(totals: PerformanceTotals): MetricValue {
  if (totals.impressionsWithClicks <= 0) {
    return { value: null, unavailableReason: 'No impressions with a recorded click value, so CTR cannot be calculated.' };
  }
  return ratio(totals.clicks, totals.impressionsWithClicks, 100, 'No impressions were recorded.');
}

export function calculateConversionRate(totals: PerformanceTotals): MetricValue {
  if (totals.conversions === null) {
    return { value: null, unavailableReason: 'The imported data does not contain conversion values.' };
  }
  return ratio(totals.conversions, totals.clicksWithConversions, 100, 'No clicks with conversion data were recorded.');
}

export function calculateMetrics(totals: PerformanceTotals): PerformanceMetrics {
  return {
    cpc: calculateCpc(totals),
    cpm: calculateCpm(totals),
    ctr: calculateCtr(totals),
    conversionRate: calculateConversionRate(totals),
  };
}

export function addMonths(month: string, offset: number): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  const resultMonth = date.getUTCMonth() + 1;
  return `${date.getUTCFullYear()}-${resultMonth < 10 ? `0${resultMonth}` : resultMonth}`;
}

export function monthRange(endMonth: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => addMonths(endMonth, index - count + 1));
}
