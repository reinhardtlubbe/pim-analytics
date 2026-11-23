import { APP_CONFIG } from '../../config/appConfig';
import { CellValue } from '../ingestion/fileParser';

export type ParseOutcome<T> = { ok: true; value: T | null } | { ok: false; error: string };

const MISSING_TOKENS = new Set(['', '-', '--', '—', 'n/a', 'na', 'null', 'none', '#n/a']);

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

export function isMissing(value: CellValue | undefined): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value === 'number') {
    return !Number.isFinite(value);
  }
  return MISSING_TOKENS.has(value.trim().toLowerCase());
}

export function parseDecimal(value: CellValue | undefined): ParseOutcome<number> {
  if (isMissing(value)) {
    return { ok: true, value: null };
  }
  if (typeof value === 'number') {
    return { ok: true, value };
  }
  let text = String(value).trim();
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  text = text
    .replace(/ /g, ' ')
    .replace(/^(zar|usd|eur|gbp)\s*/i, '')
    .replace(/\s*(zar|usd|eur|gbp)$/i, '')
    .replace(/^[r$€£]\s*/i, '')
    .replace(/\s+/g, '');
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1);
  }
  if (!/^[\d.,]+$/.test(text)) {
    return { ok: false, error: `"${String(value)}" is not a valid number.` };
  }
  const commas = (text.match(/,/g) ?? []).length;
  const dots = (text.match(/\./g) ?? []).length;
  if (commas > 0 && dots > 0) {
    if (text.lastIndexOf(',') > text.lastIndexOf('.')) {
      text = text.replace(/\./g, '').replace(',', '.');
    } else {
      text = text.replace(/,/g, '');
    }
  } else if (commas > 0) {
    if (/^\d{1,3}(,\d{3})+$/.test(text)) {
      text = text.replace(/,/g, '');
    } else if (commas === 1 && /^\d+,\d{1,2}$/.test(text)) {
      text = text.replace(',', '.');
    } else {
      return { ok: false, error: `"${String(value)}" has an ambiguous number format.` };
    }
  } else if (dots > 1) {
    if (/^\d{1,3}(\.\d{3})+$/.test(text)) {
      text = text.replace(/\./g, '');
    } else {
      return { ok: false, error: `"${String(value)}" is not a valid number.` };
    }
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    return { ok: false, error: `"${String(value)}" is not a valid number.` };
  }
  return { ok: true, value: negative ? -parsed : parsed };
}

export function parseWholeNumber(value: CellValue | undefined): ParseOutcome<number> {
  const parsed = parseDecimal(value);
  if (!parsed.ok || parsed.value === null) {
    return parsed;
  }
  if (Math.abs(parsed.value - Math.round(parsed.value)) > 1e-9) {
    return { ok: false, error: `"${String(value)}" must be a whole number.` };
  }
  return { ok: true, value: Math.round(parsed.value) };
}

function pad(month: number): string {
  return month < 10 ? `0${month}` : String(month);
}

function buildMonth(year: number, month: number): ParseOutcome<string> {
  if (year < 2000 || year > 2100 || month < 1 || month > 12) {
    return { ok: false, error: `${year}-${month} is not a valid reporting month.` };
  }
  return { ok: true, value: `${year}-${pad(month)}` };
}

function excelSerialToMonth(serial: number): ParseOutcome<string> {
  if (serial < 36526 || serial > 73051) {
    return { ok: false, error: `${serial} is not a recognisable date.` };
  }
  const date = new Date(Math.round((serial - 25569) * 86400000));
  return buildMonth(date.getUTCFullYear(), date.getUTCMonth() + 1);
}

export function normaliseReportMonth(value: CellValue | undefined): ParseOutcome<string> {
  if (isMissing(value)) {
    return { ok: true, value: null };
  }
  if (typeof value === 'number') {
    if (value >= 200001 && value <= 210012 && Number.isInteger(value)) {
      return buildMonth(Math.floor(value / 100), value % 100);
    }
    return excelSerialToMonth(value);
  }
  const text = String(value).trim();
  let match = text.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?(?:[T\s].*)?(?:\s+-\s+.*)?$/);
  if (match) {
    return buildMonth(Number(match[1]), Number(match[2]));
  }
  match = text.match(/^(\d{4})(\d{2})$/);
  if (match) {
    return buildMonth(Number(match[1]), Number(match[2]));
  }
  match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:\s.*)?$/);
  if (match) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    const year = Number(match[3]);
    const dayFirst = first > 12 ? true : second > 12 ? false : APP_CONFIG.dayFirstDates;
    return buildMonth(year, dayFirst ? second : first);
  }
  match = text.match(/^(\d{1,2})[-/.](\d{4})$/);
  if (match) {
    return buildMonth(Number(match[2]), Number(match[1]));
  }
  match = text.match(/^(?:\d{1,2}\s+)?([a-z]+)\.?[\s,-]+(\d{4})$/i) ?? text.match(/^(\d{4})[\s,-]+([a-z]+)$/i);
  if (match) {
    const [monthText, yearText] = /^\d{4}$/.test(match[1]) ? [match[2], match[1]] : [match[1], match[2]];
    const month = MONTH_NAMES[monthText.toLowerCase()];
    if (month) {
      return buildMonth(Number(yearText), month);
    }
  }
  match = text.match(/^([a-z]+)\s+\d{1,2},?\s+(\d{4})$/i);
  if (match && MONTH_NAMES[match[1].toLowerCase()]) {
    return buildMonth(Number(match[2]), MONTH_NAMES[match[1].toLowerCase()]);
  }
  return { ok: false, error: `"${text}" is not a recognisable reporting month.` };
}

export function normaliseText(value: CellValue | undefined): string | null {
  if (isMissing(value)) {
    return null;
  }
  return String(value).replace(/\s+/g, ' ').trim();
}

export function normaliseCurrency(value: CellValue | undefined): ParseOutcome<string> {
  const text = normaliseText(value);
  if (text === null) {
    return { ok: true, value: null };
  }
  const upper = text.toUpperCase();
  const aliases: Record<string, string> = { R: 'ZAR', RAND: 'ZAR', '$': 'USD', '€': 'EUR', '£': 'GBP' };
  const code = aliases[upper] ?? upper;
  if (!/^[A-Z]{3}$/.test(code)) {
    return { ok: false, error: `"${text}" is not a valid ISO currency code.` };
  }
  return { ok: true, value: code };
}

const PLATFORM_ALIASES: Record<string, string> = {
  meta: 'Meta',
  facebook: 'Meta',
  'facebook ads': 'Meta',
  'meta ads': 'Meta',
  instagram: 'Meta',
  tiktok: 'TikTok',
  'tik tok': 'TikTok',
  'tiktok ads': 'TikTok',
  google: 'Google Ads',
  'google ads': 'Google Ads',
  adwords: 'Google Ads',
};

export function normalisePlatform(value: string | null, fallback: string): string {
  if (!value) {
    return fallback;
  }
  return PLATFORM_ALIASES[value.trim().toLowerCase()] ?? value.trim();
}

export function normalisePlacement(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const cleaned = value.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned === cleaned.toLowerCase() || cleaned === cleaned.toUpperCase()) {
    return cleaned.toLowerCase().replace(/\b([a-z])/g, (letter) => letter.toUpperCase());
  }
  return cleaned;
}
