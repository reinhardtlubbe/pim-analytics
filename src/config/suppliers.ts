import { StandardFieldKey } from './standardFields';

export type SupplierCode = 'meta' | 'tiktok' | 'google_ads';

export type ClickMetricType = 'link_click' | 'destination_click' | 'click';

export interface SupplierDefaults {
  platform: string;
  currency: string | null;
  clickMetricType: ClickMetricType;
}

export interface SupplierConfig {
  code: SupplierCode;
  name: string;
  enabled: boolean;
  exactMappings: Record<string, StandardFieldKey>;
  skipColumns: string[];
  detectionColumns: string[];
  requiredFields: StandardFieldKey[];
  defaults: SupplierDefaults;
  currencySource: 'column' | 'default';
}

export const SUPPLIER_CONFIGS: SupplierConfig[] = [
  {
    code: 'meta',
    name: 'Meta',
    enabled: true,
    exactMappings: {
      Objective: 'source_objective',
      Month: 'report_month',
      Platform: 'placement',
      'Amount spent (ZAR)': 'spend_zar',
      Impressions: 'impressions',
      'Link clicks': 'clicks',
      'Campaign name': 'campaign_name',
      'Ad set name': 'ad_group_name',
    },
    skipColumns: ['Reporting starts', 'Reporting ends'],
    detectionColumns: ['Amount spent (ZAR)', 'Link clicks', 'Reporting starts', 'Reporting ends', 'Objective'],
    requiredFields: ['report_month', 'source_objective', 'spend_zar', 'impressions', 'clicks'],
    defaults: { platform: 'Meta', currency: 'ZAR', clickMetricType: 'link_click' },
    currencySource: 'default',
  },
  {
    code: 'tiktok',
    name: 'TikTok',
    enabled: true,
    exactMappings: {
      'Campaign name': 'campaign_name',
      'Advertising objective': 'source_objective',
      'By month': 'report_month',
      'Ad group name': 'ad_group_name',
      'Placements Types': 'placement',
      Spend: 'spend_zar',
      Impressions: 'impressions',
      'Clicks (destination)': 'clicks',
      Currency: 'currency',
    },
    skipColumns: [],
    detectionColumns: ['Advertising objective', 'By month', 'Ad group name', 'Placements Types', 'Clicks (destination)'],
    requiredFields: ['report_month', 'source_objective', 'spend_zar', 'impressions', 'clicks', 'currency'],
    defaults: { platform: 'TikTok', currency: null, clickMetricType: 'destination_click' },
    currencySource: 'column',
  },
  {
    code: 'google_ads',
    name: 'Google Ads',
    enabled: false,
    exactMappings: {
      Campaign: 'campaign_name',
      'Ad group': 'ad_group_name',
      'Campaign type': 'source_objective',
      Month: 'report_month',
      Cost: 'spend_zar',
      'Impr.': 'impressions',
      Clicks: 'clicks',
      Conversions: 'conversions',
      'Currency code': 'currency',
    },
    skipColumns: [],
    detectionColumns: ['Impr.', 'Currency code', 'Campaign type', 'Ad group'],
    requiredFields: ['report_month', 'source_objective', 'spend_zar', 'impressions', 'clicks', 'currency'],
    defaults: { platform: 'Google Ads', currency: null, clickMetricType: 'click' },
    currencySource: 'column',
  },
];

export function getSupplierConfigByName(name: string): SupplierConfig | undefined {
  const lowered = name.trim().toLowerCase();
  return SUPPLIER_CONFIGS.find((config) => config.name.toLowerCase() === lowered || config.code === lowered);
}

export function getSupplierConfig(code: string): SupplierConfig {
  const config = SUPPLIER_CONFIGS.find((item) => item.code === code);
  if (!config) {
    throw new Error(`Supplier ${code} is not configured.`);
  }
  return config;
}
