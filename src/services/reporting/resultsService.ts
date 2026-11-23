import { APP_CONFIG } from '../../config/appConfig';
import { MediaRecordRow } from '../../database/models';
import { SqlValue } from '../../database/types';
import { ServiceContext } from '../context';

export type ResultsSortField = 'spend_zar' | 'impressions' | 'clicks' | 'conversions' | 'report_month' | 'campaign_name';

export interface ResultsFilter {
  supplierId?: number;
  clientId?: number;
  accountId?: number;
  platform?: string;
  campaignType?: string;
  monthFrom?: string;
  monthTo?: string;
  runId?: number;
  fileId?: number;
  search?: string;
}

export interface ResultsQuery extends ResultsFilter {
  sort?: ResultsSortField;
  direction?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface ResultsTotals {
  recordCount: number;
  spendZar: number;
  spendExcludedRecords: number;
  impressions: number;
  clicks: number;
  missingClickRecords: number;
  conversions: number | null;
}

export interface ResultsPage {
  items: MediaRecordRow[];
  totals: ResultsTotals;
  page: number;
  pageSize: number;
  totalPages: number;
}

const SORT_COLUMNS: Record<ResultsSortField, string> = {
  spend_zar: 'm.spend_zar',
  impressions: 'm.impressions',
  clicks: 'm.clicks',
  conversions: 'm.conversions',
  report_month: 'm.report_month',
  campaign_name: 'm.campaign_name',
};

export function buildResultsWhere(filter: ResultsFilter): { sql: string; params: SqlValue[] } {
  const where: string[] = filter.runId !== undefined ? ['m.run_id = ?'] : ['r.is_active = 1'];
  const params: SqlValue[] = filter.runId !== undefined ? [filter.runId] : [];
  const add = (clause: string, value: SqlValue | undefined) => {
    if (value !== undefined && value !== null && value !== '') {
      where.push(clause);
      params.push(value);
    }
  };
  add('m.supplier_id = ?', filter.supplierId);
  add('m.client_id = ?', filter.clientId);
  add('m.account_id = ?', filter.accountId);
  add('m.platform = ?', filter.platform);
  add('m.campaign_type = ?', filter.campaignType);
  add('m.report_month >= ?', filter.monthFrom);
  add('m.report_month <= ?', filter.monthTo);
  add('m.file_id = ?', filter.fileId);
  const search = filter.search?.trim();
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
    where.push(
      `(m.campaign_name LIKE ? ESCAPE '\\' OR m.ad_group_name LIKE ? ESCAPE '\\' OR m.placement LIKE ? ESCAPE '\\' OR m.source_objective LIKE ? ESCAPE '\\' OR m.campaign_type LIKE ? ESCAPE '\\' OR m.report_month LIKE ? ESCAPE '\\')`,
    );
    params.push(like, like, like, like, like, like);
  }
  return { sql: `FROM media_records m JOIN processing_runs r ON r.run_id = m.run_id WHERE ${where.join(' AND ')}`, params };
}

export async function getResultsTotals(ctx: ServiceContext, filter: ResultsFilter): Promise<ResultsTotals> {
  const { sql, params } = buildResultsWhere(filter);
  const row = await ctx.db.first<{
    record_count: number;
    spend: number | null;
    spend_excluded: number;
    impressions: number | null;
    clicks: number | null;
    missing_clicks: number;
    conversions: number | null;
    conversion_rows: number;
  }>(
    `SELECT COUNT(*) AS record_count, SUM(m.spend_zar) AS spend, SUM(CASE WHEN m.spend_zar IS NULL THEN 1 ELSE 0 END) AS spend_excluded,
      SUM(m.impressions) AS impressions, SUM(m.clicks) AS clicks, SUM(CASE WHEN m.clicks IS NULL THEN 1 ELSE 0 END) AS missing_clicks,
      SUM(m.conversions) AS conversions, SUM(CASE WHEN m.conversions IS NOT NULL THEN 1 ELSE 0 END) AS conversion_rows ${sql}`,
    params,
  );
  return {
    recordCount: row?.record_count ?? 0,
    spendZar: row?.spend ?? 0,
    spendExcludedRecords: row?.spend_excluded ?? 0,
    impressions: row?.impressions ?? 0,
    clicks: row?.clicks ?? 0,
    missingClickRecords: row?.missing_clicks ?? 0,
    conversions: row && row.conversion_rows > 0 ? row.conversions : null,
  };
}

export async function getProcessingResults(ctx: ServiceContext, query: ResultsQuery = {}): Promise<ResultsPage> {
  const pageSize = Math.min(Math.max(query.pageSize ?? APP_CONFIG.resultsPageSize, 1), 500);
  const totals = await getResultsTotals(ctx, query);
  const totalPages = Math.max(1, Math.ceil(totals.recordCount / pageSize));
  const page = Math.min(Math.max(query.page ?? 1, 1), totalPages);
  const sortColumn = SORT_COLUMNS[query.sort ?? 'report_month'] ?? SORT_COLUMNS.report_month;
  const direction = query.direction === 'asc' ? 'ASC' : 'DESC';
  const { sql, params } = buildResultsWhere(query);
  const items = await ctx.db.all<MediaRecordRow>(
    `SELECT m.* ${sql} ORDER BY ${sortColumn} IS NULL, ${sortColumn} ${direction}, m.record_id ASC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return { items, totals, page, pageSize, totalPages };
}

export async function getFilterOptions(ctx: ServiceContext, clientId?: number): Promise<{ platforms: string[]; campaignTypes: string[]; months: string[] }> {
  const clause = clientId !== undefined ? 'AND m.client_id = ?' : '';
  const params = clientId !== undefined ? [clientId] : [];
  const base = `FROM media_records m JOIN processing_runs r ON r.run_id = m.run_id WHERE r.is_active = 1 ${clause}`;
  const platforms = await ctx.db.all<{ value: string }>(`SELECT DISTINCT m.platform AS value ${base} ORDER BY value`, params);
  const types = await ctx.db.all<{ value: string }>(`SELECT DISTINCT m.campaign_type AS value ${base} ORDER BY value`, params);
  const months = await ctx.db.all<{ value: string }>(`SELECT DISTINCT m.report_month AS value ${base} ORDER BY value DESC`, params);
  return { platforms: platforms.map((row) => row.value), campaignTypes: types.map((row) => row.value), months: months.map((row) => row.value) };
}
