export type CampaignType =
  | 'Awareness'
  | 'Video Views'
  | 'Traffic'
  | 'Engagement'
  | 'Leads'
  | 'Conversions'
  | 'App Promotion'
  | 'Unknown';

export const CAMPAIGN_TYPES: CampaignType[] = [
  'Awareness',
  'Video Views',
  'Traffic',
  'Engagement',
  'Leads',
  'Conversions',
  'App Promotion',
  'Unknown',
];

export interface ObjectiveRule {
  campaignType: Exclude<CampaignType, 'Unknown'>;
  patterns: RegExp[];
}

export const OBJECTIVE_RULES: ObjectiveRule[] = [
  { campaignType: 'Video Views', patterns: [/video ?views?/, /thruplay/] },
  { campaignType: 'Awareness', patterns: [/awareness/, /^reach$/, /brand/, /^reach /, /impressions?$/] },
  { campaignType: 'Traffic', patterns: [/traffic/, /link clicks?/, /^clicks?$/, /website visits?/] },
  { campaignType: 'Engagement', patterns: [/engagement/, /community interaction/, /page likes?/, /followers?/, /messages?/] },
  { campaignType: 'Leads', patterns: [/leads?/, /lead generation/] },
  {
    campaignType: 'Conversions',
    patterns: [/conversions?/, /sales/, /purchases?/, /catalog/, /product sales/, /web conversions?/, /shop/],
  },
  { campaignType: 'App Promotion', patterns: [/app ?(installs?|promotion)/, /^app /] },
];

export function cleanObjectiveName(raw: string): string {
  const stripped = raw
    .trim()
    .replace(/^outcome[_\s]+/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  return stripped.replace(/\b([a-z])/g, (match) => match.toUpperCase());
}

export function classifyObjective(raw: string | null): CampaignType {
  if (!raw) {
    return 'Unknown';
  }
  const key = cleanObjectiveName(raw).toLowerCase();
  for (const rule of OBJECTIVE_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(key))) {
      return rule.campaignType;
    }
  }
  return 'Unknown';
}
