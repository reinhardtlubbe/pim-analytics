import { APP_CONFIG } from '../../config/appConfig';
import { ServiceError } from '../errors';
import { addMonths, addTotals, calculateMetrics, emptyTotals, monthRange, PerformanceMetrics, PerformanceTotals } from './metrics';

export type BaselineWindow = 3 | 6 | 12;

export interface MonthlyObservation extends PerformanceTotals {
  month: string;
}

export interface ChannelHistory {
  platform: string;
  campaignType: string;
  observations: MonthlyObservation[];
}

export interface SeasonalityResult {
  applied: boolean;
  index: number | null;
  targetMonthCpc: number | null;
  annualCpc: number | null;
  explanation: string;
}

export interface DiminishingReturnsResult {
  modelled: boolean;
  coefficient: number | null;
  exponent: number | null;
  rSquared: number | null;
  observations: number;
  referenceSpend: number | null;
  thresholdSpend: number | null;
  explanation: string;
}

export interface ChannelBaseline {
  key: string;
  platform: string;
  campaignType: string;
  windowMonths: string[];
  monthsCovered: number;
  totals: PerformanceTotals;
  metrics: PerformanceMetrics;
  seasonality: SeasonalityResult;
  adjustedCpc: number | null;
  adjustedCpm: number | null;
  diminishingReturns: DiminishingReturnsResult;
  cpcVariation: number;
  cpmVariation: number;
  variationSource: 'observed' | 'assumed';
  warnings: string[];
}

export interface Range {
  low: number;
  expected: number;
  high: number;
}

export interface AllocationLine {
  key: string;
  platform: string;
  campaignType: string;
  percentage: number;
  amount: number;
  clicks: Range | null;
  impressions: Range | null;
  conversions: Range | null;
  expectedCpc: number | null;
  efficiencyFactor: number;
  thresholdSpend: number | null;
  beyondThreshold: boolean;
  notes: string[];
}

export interface AllocationPlan {
  mode: 'recommended' | 'manual';
  lines: AllocationLine[];
  totalBudget: number;
  allocatedBudget: number;
  clicks: Range;
  impressions: Range;
  conversions: Range | null;
  blendedCpc: number | null;
  warnings: string[];
}

export interface ForecastInput {
  totalBudget: number;
  targetMonth: string;
  window: BaselineWindow;
  histories: ChannelHistory[];
  manualPercentages?: Record<string, number> | null;
}

export interface ForecastResult {
  targetMonth: string;
  window: BaselineWindow;
  anchorMonth: string | null;
  windowMonths: string[];
  channels: ChannelBaseline[];
  recommended: AllocationPlan | null;
  manual: AllocationPlan | null;
  warnings: string[];
  assumptions: string[];
}

export function channelKey(platform: string, campaignType: string): string {
  return `${platform}::${campaignType}`;
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function sumObservations(observations: MonthlyObservation[]): PerformanceTotals {
  return observations.reduce<PerformanceTotals>((total, item) => addTotals(total, item), emptyTotals());
}

function coefficientOfVariation(values: number[]): number | null {
  if (values.length < 3) {
    return null;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean <= 0) {
    return null;
  }
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.min(0.5, Math.max(0.05, Math.sqrt(variance) / mean));
}

export function determineAnchorMonth(histories: ChannelHistory[], targetMonth: string): string | null {
  const limit = addMonths(targetMonth, -1);
  const months = histories.flatMap((history) => history.observations.map((item) => item.month)).filter((month) => month <= limit);
  if (months.length === 0) {
    return null;
  }
  return months.sort()[months.length - 1];
}

export function calculateSeasonality(history: ChannelHistory, anchorMonth: string, targetMonth: string): SeasonalityResult {
  const eligible = history.observations.filter((item) => item.month <= anchorMonth);
  const distinctMonths = new Set(eligible.map((item) => item.month)).size;
  if (distinctMonths < APP_CONFIG.seasonalityMinimumMonths) {
    return {
      applied: false,
      index: null,
      targetMonthCpc: null,
      annualCpc: null,
      explanation: `Seasonality needs at least ${APP_CONFIG.seasonalityMinimumMonths} months of history; ${distinctMonths} available. Using the unadjusted baseline.`,
    };
  }
  const calendarMonth = targetMonth.slice(5, 7);
  const sameMonth = eligible.filter((item) => item.month.slice(5, 7) === calendarMonth);
  const annualMonths = new Set(monthRange(anchorMonth, 12));
  const annual = eligible.filter((item) => annualMonths.has(item.month));
  const targetCpc = calculateMetrics(sumObservations(sameMonth)).cpc.value;
  const annualCpc = calculateMetrics(sumObservations(annual)).cpc.value;
  if (targetCpc === null || annualCpc === null || annualCpc <= 0) {
    return {
      applied: false,
      index: null,
      targetMonthCpc: targetCpc,
      annualCpc,
      explanation: `No click-bearing history exists for calendar month ${calendarMonth}, so seasonality cannot be calculated reliably. Using the unadjusted baseline.`,
    };
  }
  const index = targetCpc / annualCpc;
  return {
    applied: true,
    index,
    targetMonthCpc: targetCpc,
    annualCpc,
    explanation: `Historical CPC for month ${calendarMonth} is ${round(index * 100, 1)}% of the trailing 12-month CPC; costs adjusted by this index.`,
  };
}

export function fitDiminishingReturns(history: ChannelHistory, anchorMonth: string): DiminishingReturnsResult {
  const points = history.observations
    .filter((item) => item.month <= anchorMonth && item.spendWithClicks > 0 && item.clicks > 0)
    .map((item) => ({ x: Math.log(item.spendWithClicks), y: Math.log(item.clicks), spend: item.spendWithClicks }));
  const minimum = APP_CONFIG.diminishingReturnsMinimumObservations;
  const base = { coefficient: null, exponent: null, rSquared: null, observations: points.length, referenceSpend: null, thresholdSpend: null };
  if (points.length < minimum) {
    return { ...base, modelled: false, explanation: `Diminishing returns need at least ${minimum} monthly observations with spend and clicks; ${points.length} available. No efficiency threshold is applied.` };
  }
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const sxx = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  const sxy = points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0);
  const syy = points.reduce((sum, point) => sum + (point.y - meanY) ** 2, 0);
  if (sxx <= 1e-9) {
    return { ...base, modelled: false, explanation: 'Historical monthly spend levels are too similar to measure how efficiency changes with budget.' };
  }
  const exponent = sxy / sxx;
  const coefficient = Math.exp(meanY - exponent * meanX);
  const rSquared = syy <= 1e-12 ? 0 : (sxy * sxy) / (sxx * syy);
  const spends = points.map((point) => point.spend).sort((a, b) => a - b);
  const middle = Math.floor(spends.length / 2);
  const referenceSpend = spends.length % 2 ? spends[middle] : (spends[middle - 1] + spends[middle]) / 2;
  if (rSquared < 0.3) {
    return { ...base, coefficient, exponent, rSquared, referenceSpend, modelled: false, explanation: `The spend–clicks relationship is too weak (R² ${round(rSquared, 2)}) to model diminishing returns reliably.` };
  }
  if (exponent >= 1 || exponent <= 0) {
    return {
      ...base,
      coefficient,
      exponent,
      rSquared,
      referenceSpend,
      modelled: false,
      explanation: `Historical data does not show diminishing returns (elasticity ${round(exponent, 2)}); no threshold applied.`,
    };
  }
  const thresholdSpend = referenceSpend * (1 + APP_CONFIG.diminishingReturnsThreshold) ** (1 / (1 - exponent));
  return {
    coefficient,
    exponent,
    rSquared,
    observations: points.length,
    referenceSpend,
    thresholdSpend,
    modelled: true,
    explanation: `Clicks ≈ ${round(coefficient, 3)} × spend^${round(exponent, 3)} (R² ${round(rSquared, 2)}). Marginal CPC exceeds the median-spend reference by 25% above R${round(thresholdSpend, 0)} per month.`,
  };
}

export function buildChannelBaseline(history: ChannelHistory, window: BaselineWindow, targetMonth: string, anchorMonth: string): ChannelBaseline {
  const windowMonths = monthRange(anchorMonth, window);
  const windowSet = new Set(windowMonths);
  const inWindow = history.observations.filter((item) => windowSet.has(item.month));
  const totals = sumObservations(inWindow);
  const metrics = calculateMetrics(totals);
  const warnings: string[] = [];
  const monthsCovered = new Set(inWindow.map((item) => item.month)).size;
  if (monthsCovered < APP_CONFIG.minimumHistoryMonths) {
    warnings.push(`Only ${monthsCovered} month${monthsCovered === 1 ? '' : 's'} of reliable history in the ${window}-month window; projections are less certain.`);
  }
  if (metrics.cpc.value === null) {
    warnings.push(metrics.cpc.unavailableReason ?? 'CPC unavailable.');
  }
  const seasonality = calculateSeasonality(history, anchorMonth, targetMonth);
  const index = seasonality.applied && seasonality.index ? seasonality.index : 1;
  const diminishingReturns = fitDiminishingReturns(history, anchorMonth);
  const monthlyCpc = inWindow.map((item) => calculateMetrics(item).cpc.value).filter((value): value is number => value !== null);
  const monthlyCpm = inWindow.map((item) => calculateMetrics(item).cpm.value).filter((value): value is number => value !== null);
  const cpcVariation = coefficientOfVariation(monthlyCpc);
  const cpmVariation = coefficientOfVariation(monthlyCpm);
  return {
    key: channelKey(history.platform, history.campaignType),
    platform: history.platform,
    campaignType: history.campaignType,
    windowMonths,
    monthsCovered,
    totals,
    metrics,
    seasonality,
    adjustedCpc: metrics.cpc.value !== null ? metrics.cpc.value * index : null,
    adjustedCpm: metrics.cpm.value !== null ? metrics.cpm.value * index : null,
    diminishingReturns,
    cpcVariation: cpcVariation ?? APP_CONFIG.defaultScenarioVariation,
    cpmVariation: cpmVariation ?? APP_CONFIG.defaultScenarioVariation,
    variationSource: cpcVariation !== null ? 'observed' : 'assumed',
    warnings,
  };
}

function efficiencyFactor(baseline: ChannelBaseline, amount: number): number {
  const model = baseline.diminishingReturns;
  if (!model.modelled || model.exponent === null || model.referenceSpend === null || amount <= model.referenceSpend) {
    return 1;
  }
  return (amount / model.referenceSpend) ** (1 - model.exponent);
}

function range(expectedRate: number | null, amount: number, variation: number, factor: number, perUnit: number): Range | null {
  if (expectedRate === null || expectedRate <= 0) {
    return null;
  }
  const cost = expectedRate * factor;
  return {
    low: (amount / (cost * (1 + variation))) * perUnit,
    expected: (amount / cost) * perUnit,
    high: (amount / (cost * Math.max(0.01, 1 - variation))) * perUnit,
  };
}

export function projectLine(baseline: ChannelBaseline, amount: number, percentage: number): AllocationLine {
  const factor = efficiencyFactor(baseline, amount);
  const clicks = range(baseline.adjustedCpc, amount, baseline.cpcVariation, factor, 1);
  const impressions = range(baseline.adjustedCpm, amount, baseline.cpmVariation, 1, 1000);
  const conversionRate = baseline.metrics.conversionRate.value;
  const conversions =
    clicks && conversionRate !== null
      ? { low: (clicks.low * conversionRate) / 100, expected: (clicks.expected * conversionRate) / 100, high: (clicks.high * conversionRate) / 100 }
      : null;
  const notes: string[] = [];
  const threshold = baseline.diminishingReturns.thresholdSpend;
  const beyondThreshold = threshold !== null && amount > threshold;
  if (beyondThreshold) {
    notes.push(`Budget exceeds the diminishing-returns threshold of R${round(threshold as number, 0)}.`);
  }
  if (amount > 0 && clicks === null) {
    notes.push('Clicks cannot be projected because historical CPC is unavailable.');
  }
  return {
    key: baseline.key,
    platform: baseline.platform,
    campaignType: baseline.campaignType,
    percentage,
    amount,
    clicks,
    impressions,
    conversions,
    expectedCpc: baseline.adjustedCpc !== null ? baseline.adjustedCpc * factor : null,
    efficiencyFactor: factor,
    thresholdSpend: threshold,
    beyondThreshold,
    notes,
  };
}

export function reconcileAmounts(totalBudget: number, weights: { key: string; weight: number }[]): { key: string; amount: number; percentage: number }[] {
  const totalWeight = weights.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) {
    return [];
  }
  const totalCents = Math.round(totalBudget * 100);
  const raw = weights.map((item) => ({ key: item.key, cents: (totalCents * item.weight) / totalWeight }));
  const floored = raw.map((item) => ({ key: item.key, cents: Math.floor(item.cents), remainder: item.cents - Math.floor(item.cents) }));
  let leftover = totalCents - floored.reduce((sum, item) => sum + item.cents, 0);
  [...floored]
    .sort((a, b) => b.remainder - a.remainder)
    .forEach((item) => {
      if (leftover > 0) {
        item.cents += 1;
        leftover -= 1;
      }
    });
  const amounts = floored.map((item) => ({ key: item.key, amount: item.cents / 100, percentage: totalCents > 0 ? round((item.cents / totalCents) * 100, 2) : 0 }));
  const percentageGap = round(100 - amounts.reduce((sum, item) => sum + item.percentage, 0), 2);
  if (amounts.length && percentageGap !== 0) {
    const largest = amounts.reduce((best, item) => (item.amount > best.amount ? item : best), amounts[0]);
    largest.percentage = round(largest.percentage + percentageGap, 2);
  }
  return amounts;
}

function summarisePlan(mode: AllocationPlan['mode'], lines: AllocationLine[], totalBudget: number, warnings: string[]): AllocationPlan {
  const sumRange = (pick: (line: AllocationLine) => Range | null): Range => {
    return lines.reduce<Range>(
      (total, line) => {
        const value = pick(line);
        return value ? { low: total.low + value.low, expected: total.expected + value.expected, high: total.high + value.high } : total;
      },
      { low: 0, expected: 0, high: 0 },
    );
  };
  const clicks = sumRange((line) => line.clicks);
  const conversionLines = lines.filter((line) => line.conversions !== null && line.amount > 0);
  const budgetWithClicks = lines.filter((line) => line.clicks !== null).reduce((sum, line) => sum + line.amount, 0);
  return {
    mode,
    lines,
    totalBudget,
    allocatedBudget: round(lines.reduce((sum, line) => sum + line.amount, 0)),
    clicks,
    impressions: sumRange((line) => line.impressions),
    conversions: conversionLines.length ? sumRange((line) => line.conversions) : null,
    blendedCpc: clicks.expected > 0 ? budgetWithClicks / clicks.expected : null,
    warnings,
  };
}

export function recommendAllocation(baselines: ChannelBaseline[], totalBudget: number): AllocationPlan | null {
  const eligible = baselines.filter((baseline) => baseline.adjustedCpc !== null && baseline.adjustedCpc > 0);
  if (eligible.length === 0 || totalBudget <= 0) {
    return null;
  }
  const warnings: string[] = [];
  const allocation = new Map<string, number>();
  let remaining = totalBudget;
  let uncapped = [...eligible];
  while (remaining > 0.005 && uncapped.length > 0) {
    const totalWeight = uncapped.reduce((sum, baseline) => sum + 1 / (baseline.adjustedCpc as number), 0);
    const capped = uncapped.filter((baseline) => {
      const share = (remaining * (1 / (baseline.adjustedCpc as number))) / totalWeight;
      const threshold = baseline.diminishingReturns.thresholdSpend;
      return threshold !== null && (allocation.get(baseline.key) ?? 0) + share > threshold;
    });
    if (capped.length === 0) {
      uncapped.forEach((baseline) => {
        const share = (remaining * (1 / (baseline.adjustedCpc as number))) / totalWeight;
        allocation.set(baseline.key, (allocation.get(baseline.key) ?? 0) + share);
      });
      remaining = 0;
      break;
    }
    capped.forEach((baseline) => {
      const threshold = baseline.diminishingReturns.thresholdSpend as number;
      const current = allocation.get(baseline.key) ?? 0;
      const top = Math.max(0, threshold - current);
      allocation.set(baseline.key, current + top);
      remaining -= top;
    });
    const cappedKeys = new Set(capped.map((baseline) => baseline.key));
    uncapped = uncapped.filter((baseline) => !cappedKeys.has(baseline.key));
  }
  if (remaining > 0.005) {
    warnings.push('The budget exceeds every channel’s diminishing-returns threshold; the excess was spread by efficiency and returns will be lower.');
    const totalWeight = eligible.reduce((sum, baseline) => sum + 1 / (baseline.adjustedCpc as number), 0);
    eligible.forEach((baseline) => {
      allocation.set(baseline.key, (allocation.get(baseline.key) ?? 0) + (remaining * (1 / (baseline.adjustedCpc as number))) / totalWeight);
    });
  }
  const amounts = reconcileAmounts(
    totalBudget,
    eligible.map((baseline) => ({ key: baseline.key, weight: allocation.get(baseline.key) ?? 0 })),
  );
  const lines = amounts.map((item) => projectLine(eligible.find((baseline) => baseline.key === item.key) as ChannelBaseline, item.amount, item.percentage));
  const excluded = baselines.filter((baseline) => !eligible.includes(baseline));
  if (excluded.length) {
    warnings.push(`${excluded.map((baseline) => `${baseline.platform} ${baseline.campaignType}`).join(', ')} excluded from the recommendation because CPC is unavailable.`);
  }
  return summarisePlan('recommended', lines, totalBudget, warnings);
}

export function manualAllocation(baselines: ChannelBaseline[], totalBudget: number, percentages: Record<string, number>): AllocationPlan {
  const unknown = Object.keys(percentages).filter((key) => !baselines.some((baseline) => baseline.key === key));
  if (unknown.length) {
    throw new ServiceError('VALIDATION', `Allocations reference channels without history: ${unknown.join(', ')}.`);
  }
  const values = baselines.map((baseline) => percentages[baseline.key] ?? 0);
  if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 100)) {
    throw new ServiceError('VALIDATION', 'Each allocation percentage must be between 0 and 100.');
  }
  const sum = values.reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 100) > 0.01) {
    throw new ServiceError('VALIDATION', `Allocation percentages must total 100% (currently ${round(sum, 2)}%).`, { total: round(sum, 2) });
  }
  const amounts = reconcileAmounts(
    totalBudget,
    baselines.map((baseline) => ({ key: baseline.key, weight: percentages[baseline.key] ?? 0 })),
  );
  const lines = amounts.map((item) => projectLine(baselines.find((baseline) => baseline.key === item.key) as ChannelBaseline, item.amount, item.percentage));
  const warnings = lines.filter((line) => line.amount > 0 && line.clicks === null).map((line) => `${line.platform} ${line.campaignType}: clicks cannot be projected without historical CPC.`);
  return summarisePlan('manual', lines, totalBudget, warnings);
}

export function calculateBudgetForecast(input: ForecastInput): ForecastResult {
  if (!Number.isFinite(input.totalBudget) || input.totalBudget <= 0) {
    throw new ServiceError('VALIDATION', 'Enter a total budget greater than zero.');
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.targetMonth)) {
    throw new ServiceError('VALIDATION', 'Enter the target month as YYYY-MM.');
  }
  if (![3, 6, 12].includes(input.window)) {
    throw new ServiceError('VALIDATION', 'The baseline window must be 3, 6 or 12 months.');
  }
  const assumptions = [
    'Historical metrics use aggregate totals (total spend ÷ total clicks), not averages of row-level rates.',
    'CPC and CTR only use records with a recorded click value; missing clicks are excluded rather than treated as zero.',
    'Only accepted records from active processing runs with ZAR spend and a known campaign type are used.',
    'Meta link clicks and TikTok destination clicks keep their own definitions; each channel is forecast from its own click metric.',
  ];
  const anchorMonth = determineAnchorMonth(input.histories, input.targetMonth);
  if (!anchorMonth) {
    return {
      targetMonth: input.targetMonth,
      window: input.window,
      anchorMonth: null,
      windowMonths: [],
      channels: [],
      recommended: null,
      manual: null,
      warnings: ['No eligible historical records exist before the target month for the selected client and channels. A forecast cannot be produced.'],
      assumptions,
    };
  }
  assumptions.push(`The ${input.window}-month baseline window ends at ${anchorMonth}, the latest month with data before ${input.targetMonth}.`);
  const channels = input.histories
    .map((history) => buildChannelBaseline(history, input.window, input.targetMonth, anchorMonth))
    .filter((baseline) => baseline.totals.rows > 0);
  const warnings: string[] = [];
  if (channels.length === 0) {
    warnings.push(`No eligible records fall inside the ${input.window}-month window ending ${anchorMonth}.`);
  }
  channels.forEach((channel) => channel.warnings.forEach((warning) => warnings.push(`${channel.platform} ${channel.campaignType}: ${warning}`)));
  const variationAssumed = channels.some((channel) => channel.variationSource === 'assumed');
  assumptions.push(
    `Low and high scenarios vary cost per result by each channel's observed month-to-month coefficient of variation (bounded 5%–50%)${
      variationAssumed ? `, or an assumed ±${APP_CONFIG.defaultScenarioVariation * 100}% where fewer than three monthly observations exist` : ''
    }.`,
  );
  const recommended = recommendAllocation(channels, input.totalBudget);
  if (!recommended && channels.length) {
    warnings.push('No channel has enough click history to recommend an allocation.');
  }
  const manual = input.manualPercentages ? manualAllocation(channels, input.totalBudget, input.manualPercentages) : null;
  return {
    targetMonth: input.targetMonth,
    window: input.window,
    anchorMonth,
    windowMonths: monthRange(anchorMonth, input.window),
    channels,
    recommended,
    manual,
    warnings,
    assumptions,
  };
}

export interface ReverseCalculationResult {
  goal: 'clicks' | 'conversions';
  target: number;
  requiredBudget: number | null;
  plan: AllocationPlan | null;
  warnings: string[];
}

export function reverseCalculate(channels: ChannelBaseline[], goal: 'clicks' | 'conversions', target: number): ReverseCalculationResult {
  if (!Number.isFinite(target) || target <= 0) {
    throw new ServiceError('VALIDATION', `Enter the desired number of ${goal}.`);
  }
  const warnings: string[] = [];
  if (goal === 'conversions' && !channels.some((channel) => channel.metrics.conversionRate.value !== null)) {
    return { goal, target, requiredBudget: null, plan: null, warnings: ['The imported history has no conversion data, so a conversion-based budget cannot be estimated.'] };
  }
  const outcome = (budget: number): { value: number; plan: AllocationPlan | null } => {
    const plan = recommendAllocation(channels, budget);
    if (!plan) {
      return { value: 0, plan: null };
    }
    return { value: goal === 'clicks' ? plan.clicks.expected : (plan.conversions?.expected ?? 0), plan };
  };
  if (!recommendAllocation(channels, 1000)) {
    return { goal, target, requiredBudget: null, plan: null, warnings: ['No channel has enough click history to estimate a budget.'] };
  }
  let low = 0;
  let high = 1000;
  const ceiling = 1e9;
  while (outcome(high).value < target) {
    high *= 2;
    if (high > ceiling) {
      return { goal, target, requiredBudget: null, plan: null, warnings: ['The target cannot be reached within a realistic budget given the observed diminishing returns.'] };
    }
  }
  for (let iteration = 0; iteration < 60 && high - low > 0.5; iteration += 1) {
    const middle = (low + high) / 2;
    if (outcome(middle).value >= target) {
      high = middle;
    } else {
      low = middle;
    }
  }
  const requiredBudget = Math.ceil(high);
  const { plan } = outcome(requiredBudget);
  if (channels.some((channel) => channel.monthsCovered < APP_CONFIG.minimumHistoryMonths)) {
    warnings.push('Some channels have fewer than three months of history; the estimate is less reliable.');
  }
  if (plan?.lines.some((line) => line.beyondThreshold)) {
    warnings.push('Reaching this target pushes at least one channel beyond its diminishing-returns threshold.');
  }
  return { goal, target, requiredBudget, plan, warnings };
}

