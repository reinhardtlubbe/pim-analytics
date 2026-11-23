import { CampaignType, CAMPAIGN_TYPES, classifyObjective, cleanObjectiveName } from '../../config/objectiveRules';
import { isStandardFieldKey, StandardFieldKey } from '../../config/standardFields';
import { CurrencyRateRow } from '../../database/models';
import { sha256Hex, stableStringify } from '../../utils/hashing';
import { CellValue } from '../ingestion/fileParser';
import { ConfirmedMapping } from '../mapping/confirmationService';
import {
  normaliseCurrency,
  normalisePlacement,
  normalisePlatform,
  normaliseReportMonth,
  normaliseText,
  parseDecimal,
  parseWholeNumber,
} from './normalisers';

export type ForecastEligibility = 'eligible' | 'excluded_no_fx_rate' | 'excluded_unknown_campaign_type';

export interface TransformContext {
  confirmation: ConfirmedMapping;
  clientId: number;
  clientName: string;
  accountId: number;
  accountName: string;
  supplierId: number;
  rates: CurrencyRateRow[];
}

export interface StandardisedRecord {
  sourceRowNumber: number;
  reportMonth: string;
  clientId: number;
  clientName: string;
  accountId: number;
  accountName: string;
  supplierId: number;
  platform: string;
  campaignName: string | null;
  adGroupName: string | null;
  placement: string | null;
  sourceObjective: string;
  campaignType: CampaignType;
  spendOriginal: number;
  spendZar: number | null;
  fxRate: number | null;
  fxRateDate: string | null;
  impressions: number;
  clicks: number | null;
  conversions: number | null;
  clickMetricType: string;
  currency: string;
  sourceData: Record<string, CellValue>;
  rowFingerprint: string;
  businessKey: string;
  forecastEligibility: ForecastEligibility;
}

export interface RowIssue {
  sourceRowNumber: number;
  fieldName: string | null;
  errorType: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface TransformResult {
  record: StandardisedRecord | null;
  issues: RowIssue[];
}

function monthEnd(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  const last = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month}-${last < 10 ? `0${last}` : last}`;
}

export function findConversionRate(rates: CurrencyRateRow[], currency: string, month: string): CurrencyRateRow | null {
  const limit = monthEnd(month);
  const candidates = rates.filter((rate) => rate.currency_code === currency && rate.rate_date <= limit).sort((a, b) => (a.rate_date < b.rate_date ? 1 : -1));
  return candidates[0] ?? null;
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

export function transformSourceRow(sourceRowNumber: number, values: Record<string, CellValue>, context: TransformContext): TransformResult {
  const issues: RowIssue[] = [];
  const raw: Partial<Record<StandardFieldKey, CellValue>> = {};
  Object.entries(context.confirmation.columnMappings).forEach(([column, target]) => {
    if (isStandardFieldKey(target)) {
      raw[target] = values[column] ?? null;
    }
  });
  const fail = (fieldName: string, errorType: string, message: string) =>
    issues.push({ sourceRowNumber, fieldName, errorType, severity: 'error', message });
  const warn = (fieldName: string, errorType: string, message: string) =>
    issues.push({ sourceRowNumber, fieldName, errorType, severity: 'warning', message });

  const month = normaliseReportMonth(raw.report_month);
  if (!month.ok) {
    fail('report_month', 'invalid_date', month.error);
  } else if (month.value === null) {
    fail('report_month', 'missing_required', 'Reporting month is missing.');
  }

  const objectiveText = normaliseText(raw.source_objective);
  if (objectiveText === null) {
    fail('source_objective', 'missing_required', 'Source objective is missing.');
  }

  const spend = parseDecimal(raw.spend_zar);
  if (!spend.ok) {
    fail('spend_zar', 'invalid_number', spend.error);
  } else if (spend.value === null) {
    fail('spend_zar', 'missing_required', 'Spend is missing.');
  } else if (spend.value < 0) {
    fail('spend_zar', 'negative_value', `Spend cannot be negative (${spend.value}).`);
  }

  const impressions = parseWholeNumber(raw.impressions);
  if (!impressions.ok) {
    fail('impressions', 'invalid_number', impressions.error);
  } else if (impressions.value === null) {
    fail('impressions', 'missing_required', 'Impressions are missing.');
  } else if (impressions.value < 0) {
    fail('impressions', 'negative_value', `Impressions cannot be negative (${impressions.value}).`);
  }

  const clicks = parseWholeNumber(raw.clicks);
  if (!clicks.ok) {
    fail('clicks', 'invalid_number', clicks.error);
  } else if (clicks.value !== null && clicks.value < 0) {
    fail('clicks', 'negative_value', `Clicks cannot be negative (${clicks.value}).`);
  }

  const conversions = parseDecimal(raw.conversions);
  if (!conversions.ok) {
    fail('conversions', 'invalid_number', conversions.error);
  } else if (conversions.value !== null && conversions.value < 0) {
    fail('conversions', 'negative_value', `Conversions cannot be negative (${conversions.value}).`);
  }

  const defaults = context.confirmation.supplierDefaults;
  const mappedCurrency = Object.values(context.confirmation.columnMappings).includes('currency');
  const currency = mappedCurrency ? normaliseCurrency(raw.currency) : { ok: true as const, value: defaults.currency };
  let currencyCode: string | null = null;
  if (!currency.ok) {
    fail('currency', 'invalid_currency', currency.error);
  } else if (!currency.value) {
    fail('currency', 'missing_required', 'Currency is missing and the supplier has no approved default.');
  } else {
    currencyCode = currency.value;
  }

  const platformText = normaliseText(raw.platform);
  const platform = normalisePlatform(platformText, defaults.platform);
  if (platform !== defaults.platform) {
    fail('platform', 'supplier_mismatch', `Row platform "${platformText}" does not belong to supplier ${context.confirmation.supplierName}.`);
  }

  if (issues.some((issue) => issue.severity === 'error')) {
    return { record: null, issues };
  }

  const reportMonth = month.ok ? (month.value as string) : '';
  const spendOriginal = spend.ok ? (spend.value as number) : 0;
  const objective = cleanObjectiveName(objectiveText as string);
  const mappedType = normaliseText(raw.campaign_type);
  const campaignType: CampaignType =
    mappedType && (CAMPAIGN_TYPES as string[]).includes(mappedType) ? (mappedType as CampaignType) : classifyObjective(objectiveText);
  let eligibility: ForecastEligibility = 'eligible';
  if (campaignType === 'Unknown') {
    eligibility = 'excluded_unknown_campaign_type';
    warn('source_objective', 'unknown_objective', `Objective "${objective}" is not covered by the campaign-type rules and was classified as Unknown.`);
  }

  let spendZar: number | null = null;
  let fxRate: number | null = null;
  let fxRateDate: string | null = null;
  const code = currencyCode as string;
  if (code === 'ZAR') {
    spendZar = spendOriginal;
  } else {
    const rate = findConversionRate(context.rates, code, reportMonth);
    if (rate) {
      fxRate = rate.rate_to_zar;
      fxRateDate = rate.rate_date;
      spendZar = roundCurrency(spendOriginal * rate.rate_to_zar);
    } else {
      eligibility = 'excluded_no_fx_rate';
      warn('currency', 'missing_fx_rate', `No dated ${code}→ZAR rate on or before ${monthEnd(reportMonth)}; spend kept in ${code} and excluded from ZAR forecasting.`);
    }
  }

  const campaignName = normaliseText(raw.campaign_name);
  const adGroupName = normaliseText(raw.ad_group_name);
  const placement = normalisePlacement(normaliseText(raw.placement));
  const clickValue = clicks.ok ? clicks.value : null;
  const conversionValue = conversions.ok ? conversions.value : null;
  const impressionValue = impressions.ok ? (impressions.value as number) : 0;
  const keyParts = [context.accountId, platform, reportMonth, campaignName, adGroupName, placement, objective].map((part) =>
    part === null ? '' : String(part).toLowerCase(),
  );
  const fingerprint = sha256Hex(
    stableStringify({
      account: context.accountId,
      key: keyParts,
      spend: spendOriginal,
      currency: code,
      impressions: impressionValue,
      clicks: clickValue,
      conversions: conversionValue,
    }),
  );

  return {
    record: {
      sourceRowNumber,
      reportMonth,
      clientId: context.clientId,
      clientName: context.clientName,
      accountId: context.accountId,
      accountName: context.accountName,
      supplierId: context.supplierId,
      platform,
      campaignName,
      adGroupName,
      placement,
      sourceObjective: objective,
      campaignType,
      spendOriginal,
      spendZar,
      fxRate,
      fxRateDate,
      impressions: impressionValue,
      clicks: clickValue,
      conversions: conversionValue,
      clickMetricType: defaults.clickMetricType,
      currency: code,
      sourceData: values,
      rowFingerprint: fingerprint,
      businessKey: keyParts.join('|'),
      forecastEligibility: eligibility,
    },
    issues,
  };
}
