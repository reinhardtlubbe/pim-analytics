import * as XLSX from 'xlsx';
import { encodeUtf8 } from '../../src/services/ingestion/textDecoding';

export const SYNTHETIC_LABEL = 'SYNTHETIC TEST FIXTURE - not real supplier data';

function monthList(start: string, count: number): string[] {
  const [year, month] = start.split('-').map(Number);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1 + index, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

export interface TikTokFixtureOptions {
  months?: string[];
  currency?: string;
  extraRows?: string[][];
  includeSummary?: boolean;
}

export const TIKTOK_HEADERS = [
  'Campaign name',
  'Advertising objective',
  'By month',
  'Ad group name',
  'Placements Types',
  'Spend',
  'Impressions',
  'Clicks (destination)',
  'Currency',
];

export function buildTikTokRows(options: TikTokFixtureOptions = {}): string[][] {
  const months = options.months ?? monthList('2025-01', 3);
  const rows: string[][] = [];
  months.forEach((month, monthIndex) => {
    [
      ['Synthetic Always On', 'Traffic', 'Traffic Ad Group'],
      ['Synthetic Reach Push', 'Reach', 'Reach Ad Group'],
    ].forEach(([campaign, objective, adGroup], campaignIndex) => {
      const spend = 1000 + monthIndex * 100 + campaignIndex * 250;
      const impressions = 100000 + monthIndex * 5000 + campaignIndex * 20000;
      const clicks = 900 + monthIndex * 40 + campaignIndex * 100;
      rows.push([campaign, objective, month, adGroup, 'Automatic placement', spend.toFixed(2), String(impressions), String(clicks), options.currency ?? 'ZAR']);
    });
  });
  return rows.concat(options.extraRows ?? []);
}

export function buildTikTokCsv(options: TikTokFixtureOptions = {}): Uint8Array {
  const rows = buildTikTokRows(options);
  const lines = [TIKTOK_HEADERS, ...rows];
  if (options.includeSummary !== false) {
    const spend = rows.reduce((sum, row) => sum + (Number(row[5]) || 0), 0);
    lines.push([`Total of ${rows.length} results`, '-', '-', '-', '-', spend.toFixed(2), '', '', '']);
  }
  const csv = lines.map((line) => line.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(',')).join('\r\n');
  return encodeUtf8(csv);
}

export const META_HEADERS = ['Reporting starts', 'Reporting ends', 'Objective', 'Month', 'Platform', 'Amount spent (ZAR)', 'Impressions', 'Link clicks'];

export interface MetaFixtureOptions {
  months?: string[];
  missingClickEvery?: number;
  sheetName?: string;
  extraSheet?: boolean;
}

export function buildMetaRows(options: MetaFixtureOptions = {}): (string | number | null)[][] {
  const months = options.months ?? monthList('2025-01', 3);
  const rows: (string | number | null)[][] = [];
  let counter = 0;
  months.forEach((month, monthIndex) => {
    const [year, monthNumber] = month.split('-').map(Number);
    const last = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const range = `${month}-01 - ${month}-${last}`;
    [
      ['Link clicks', 'Facebook'],
      ['Link clicks', 'Instagram'],
      ['Reach', 'Facebook'],
    ].forEach(([objective, platform], index) => {
      counter += 1;
      const spend = 2000 + monthIndex * 150 + index * 300;
      const impressions = 150000 + monthIndex * 7000 + index * 15000;
      const clicks = options.missingClickEvery && counter % options.missingClickEvery === 0 ? null : 1200 + monthIndex * 60 + index * 90;
      rows.push([`${month}-01`, `${month}-${last}`, objective, range, platform, spend, impressions, clicks]);
    });
  });
  return rows;
}

export function buildMetaXlsx(options: MetaFixtureOptions = {}): Uint8Array {
  const rows = buildMetaRows(options);
  const spend = rows.reduce((sum, row) => sum + Number(row[5]), 0);
  const impressions = rows.reduce((sum, row) => sum + Number(row[6]), 0);
  const first = rows[0][0];
  const last = rows[rows.length - 1][1];
  const summary = [first, last, null, null, null, spend, impressions, null];
  const workbook = XLSX.utils.book_new();
  if (options.extraSheet) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[SYNTHETIC_LABEL]]), 'Notes');
  }
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([META_HEADERS, summary, ...rows]), options.sheetName ?? 'Raw Data Report');
  return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

export { monthList };
