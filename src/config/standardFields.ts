export type StandardFieldKey =
  | 'report_month'
  | 'client'
  | 'account'
  | 'platform'
  | 'campaign_name'
  | 'ad_group_name'
  | 'placement'
  | 'source_objective'
  | 'campaign_type'
  | 'spend_zar'
  | 'impressions'
  | 'clicks'
  | 'conversions'
  | 'currency';

export type FieldValueKind = 'month' | 'text' | 'decimal' | 'integer' | 'currency';

export interface StandardFieldDefinition {
  key: StandardFieldKey;
  label: string;
  kind: FieldValueKind;
  presentationAliases: string[];
  synonyms: string[];
}

export const SKIP_TARGET = 'skip';
export const UNRESOLVED_TARGET = '';

export type MappingTarget = StandardFieldKey | typeof SKIP_TARGET | typeof UNRESOLVED_TARGET;

export const STANDARD_FIELDS: StandardFieldDefinition[] = [
  {
    key: 'report_month',
    label: 'Reporting month',
    kind: 'month',
    presentationAliases: ['date'],
    synonyms: ['month', 'date', 'day', 'report date', 'reporting month', 'reporting period', 'period', 'by month', 'week'],
  },
  {
    key: 'client',
    label: 'Client',
    kind: 'text',
    presentationAliases: [],
    synonyms: ['client', 'client name', 'advertiser', 'advertiser name', 'brand'],
  },
  {
    key: 'account',
    label: 'Account',
    kind: 'text',
    presentationAliases: [],
    synonyms: ['account', 'account name', 'ad account', 'ad account name', 'advertiser account'],
  },
  {
    key: 'platform',
    label: 'Platform',
    kind: 'text',
    presentationAliases: ['channel'],
    synonyms: ['channel', 'media channel', 'network', 'publisher', 'supplier'],
  },
  {
    key: 'campaign_name',
    label: 'Campaign name',
    kind: 'text',
    presentationAliases: [],
    synonyms: ['campaign', 'campaign name', 'campaign title'],
  },
  {
    key: 'ad_group_name',
    label: 'Ad group / ad set',
    kind: 'text',
    presentationAliases: [],
    synonyms: ['ad group', 'ad group name', 'ad set', 'ad set name', 'adset', 'adset name'],
  },
  {
    key: 'placement',
    label: 'Placement',
    kind: 'text',
    presentationAliases: [],
    synonyms: ['placement', 'placements', 'placement type', 'placements types', 'publisher platform', 'platform'],
  },
  {
    key: 'source_objective',
    label: 'Source objective',
    kind: 'text',
    presentationAliases: [],
    synonyms: ['objective', 'campaign objective', 'advertising objective', 'goal', 'optimisation goal', 'optimization goal'],
  },
  {
    key: 'campaign_type',
    label: 'Campaign type',
    kind: 'text',
    presentationAliases: [],
    synonyms: ['campaign type', 'type'],
  },
  {
    key: 'spend_zar',
    label: 'Spend (ZAR)',
    kind: 'decimal',
    presentationAliases: ['spend'],
    synonyms: ['spend', 'cost', 'media cost', 'amount spent', 'amount spent zar', 'total cost', 'total spend', 'spend zar'],
  },
  {
    key: 'impressions',
    label: 'Impressions',
    kind: 'integer',
    presentationAliases: [],
    synonyms: ['impressions', 'impression', 'impr', 'imps'],
  },
  {
    key: 'clicks',
    label: 'Clicks',
    kind: 'integer',
    presentationAliases: [],
    synonyms: ['clicks', 'click', 'link clicks', 'clicks destination', 'clicks all', 'all clicks'],
  },
  {
    key: 'conversions',
    label: 'Conversions',
    kind: 'decimal',
    presentationAliases: [],
    synonyms: ['conversions', 'conversion', 'conv', 'results', 'purchases', 'leads'],
  },
  {
    key: 'currency',
    label: 'Currency',
    kind: 'currency',
    presentationAliases: [],
    synonyms: ['currency', 'currency code', 'curr'],
  },
];

export const STANDARD_FIELD_KEYS: StandardFieldKey[] = STANDARD_FIELDS.map((field) => field.key);

export function isStandardFieldKey(value: string): value is StandardFieldKey {
  return (STANDARD_FIELD_KEYS as string[]).includes(value);
}

export function getStandardField(key: StandardFieldKey): StandardFieldDefinition {
  const field = STANDARD_FIELDS.find((item) => item.key === key);
  if (!field) {
    throw new Error(`Unknown standard field: ${key}`);
  }
  return field;
}

export function normaliseColumnName(name: string): string {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
