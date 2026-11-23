import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { APP_CONFIG } from '../../config/appConfig';
import { normaliseColumnName, STANDARD_FIELDS } from '../../config/standardFields';
import { SUPPLIER_CONFIGS } from '../../config/suppliers';
import { ServiceError } from '../errors';
import { decodeText, DetectedEncoding } from './textDecoding';

export type CellValue = string | number | null;
export type FileType = 'csv' | 'xlsx';

export interface ParsedSheet {
  name: string;
  rows: CellValue[][];
}

export interface ParsedWorkbook {
  fileType: FileType;
  sheets: ParsedSheet[];
  encoding: DetectedEncoding | null;
}

export interface SourceRow {
  sourceRowNumber: number;
  values: Record<string, CellValue>;
}

export interface ExtractedTable {
  worksheetName: string | null;
  headerRowNumber: number;
  headers: string[];
  detailRows: SourceRow[];
  summaryRows: SourceRow[];
  blankRowCount: number;
  totalRowCount: number;
}

const SUMMARY_TEXT_PATTERN = /^(grand\s+)?totals?\b|^total\s+of\s+\d+|^summary\b|^\s*results?\s+total/i;
const REPORTING_RANGE_COLUMNS = new Set(['reporting starts', 'reporting ends']);

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function cleanCell(value: unknown): CellValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE';
  }
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }
  const text = String(value).replace(/ /g, ' ').trim();
  return text === '' ? null : text;
}

export function getFileType(filename: string): FileType | null {
  const lowered = filename.toLowerCase();
  if (lowered.endsWith('.csv')) {
    return 'csv';
  }
  if (lowered.endsWith('.xlsx')) {
    return 'xlsx';
  }
  return null;
}

export function parseCsvBytes(bytes: Uint8Array): ParsedWorkbook {
  const { text, encoding } = decodeText(bytes);
  if (!text.trim()) {
    throw new ServiceError('PARSE_ERROR', 'The CSV file is empty.');
  }
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false, delimiter: '' });
  const fatal = parsed.errors.find((error) => error.type === 'Quotes');
  if (fatal) {
    throw new ServiceError('PARSE_ERROR', `The CSV file could not be read: ${fatal.message} (row ${fatal.row ?? '?'}).`);
  }
  const rows = parsed.data.map((row) => (Array.isArray(row) ? row.map((cell) => cleanCell(cell)) : []));
  while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell === null)) {
    rows.pop();
  }
  return { fileType: 'csv', sheets: [{ name: 'CSV', rows }], encoding };
}

function readWorksheetCells(sheet: XLSX.WorkSheet): CellValue[][] {
  const reference = sheet['!ref'];
  if (!reference) {
    return [];
  }
  const range = XLSX.utils.decode_range(reference);
  const rows: CellValue[][] = [];
  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
    const row: CellValue[] = [];
    for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })] as XLSX.CellObject | undefined;
      if (!cell || cell.t === 'z' || cell.t === 'e') {
        row.push(null);
      } else if (cell.t === 'n' && typeof cell.v === 'number' && cell.z && XLSX.SSF.is_date(cell.z)) {
        const parsed = XLSX.SSF.parse_date_code(cell.v);
        row.push(parsed ? `${parsed.y}-${pad(parsed.m)}-${pad(parsed.d)}` : cleanCell(cell.v));
      } else if (cell.t === 'd' && cell.v instanceof Date) {
        row.push(cleanCell(cell.v));
      } else {
        row.push(cleanCell(cell.v));
      }
    }
    rows.push(row);
  }
  while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell === null)) {
    rows.pop();
  }
  return rows;
}

export function parseXlsxBytes(bytes: Uint8Array): ParsedWorkbook {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, { type: 'array', cellDates: false, cellNF: true, dense: false });
  } catch (error) {
    throw new ServiceError('PARSE_ERROR', 'The Excel workbook could not be opened. Check that it is a valid .xlsx file.', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const sheets = workbook.SheetNames.map((name) => ({ name, rows: readWorksheetCells(workbook.Sheets[name]) }));
  if (sheets.length === 0) {
    throw new ServiceError('PARSE_ERROR', 'The Excel workbook does not contain any worksheets.');
  }
  return { fileType: 'xlsx', sheets, encoding: null };
}

export function parseWorkbook(bytes: Uint8Array, fileType: FileType): ParsedWorkbook {
  return fileType === 'csv' ? parseCsvBytes(bytes) : parseXlsxBytes(bytes);
}

let knownColumnNames: Set<string> | null = null;

function getKnownColumnNames(): Set<string> {
  if (!knownColumnNames) {
    const names = new Set<string>();
    for (const supplier of SUPPLIER_CONFIGS) {
      Object.keys(supplier.exactMappings).forEach((name) => names.add(normaliseColumnName(name)));
      supplier.skipColumns.forEach((name) => names.add(normaliseColumnName(name)));
    }
    for (const field of STANDARD_FIELDS) {
      field.synonyms.forEach((name) => names.add(normaliseColumnName(name)));
    }
    knownColumnNames = names;
  }
  return knownColumnNames;
}

// Scan the first few rows of the worksheet to find the header row.
// We count how many cells match known advertising column names/synonyms (like spend, impressions, clicks, etc.)
// to determine the most likely header row index.
export function detectHeaderRowIndex(rows: CellValue[][]): number {
  const known = getKnownColumnNames();
  let best: { index: number; score: number; filled: number } | null = null;
  let widest: { index: number; filled: number } | null = null;
  const limit = Math.min(rows.length, APP_CONFIG.headerScanRows);
  for (let index = 0; index < limit; index += 1) {
    const cells = rows[index].filter((cell): cell is string | number => cell !== null);
    const filled = cells.length;
    if (!widest || filled > widest.filled) {
      widest = { index, filled };
    }
    const score = cells.filter((cell) => typeof cell === 'string' && known.has(normaliseColumnName(cell))).length;
    if (score > 0 && (!best || score > best.score || (score === best.score && filled > best.filled))) {
      best = { index, score, filled };
    }
  }
  if (best && best.score >= 2) {
    return best.index;
  }
  return widest?.index ?? 0;
}

function isNumericLike(value: CellValue): boolean {
  if (typeof value === 'number') {
    return true;
  }
  if (value === null) {
    return false;
  }
  return /^[-(]?\s*(r|zar|\$|€|£)?\s*[\d\s,.]+\)?\s*%?$/i.test(value);
}

function isSummaryRow(values: CellValue[], dimensionColumns: number[]): boolean {
  const texts = values.filter((cell): cell is string => typeof cell === 'string');
  if (texts.some((text) => SUMMARY_TEXT_PATTERN.test(text))) {
    return true;
  }
  if (dimensionColumns.length === 0) {
    return false;
  }
  const hasMetrics = values.some((cell, index) => !dimensionColumns.includes(index) && isNumericLike(cell));
  const dimensionsEmpty = dimensionColumns.every((index) => values[index] === null || values[index] === undefined);
  return hasMetrics && dimensionsEmpty;
}

function uniqueHeaders(raw: CellValue[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((cell, index) => {
    const base = cell === null ? `Column ${index + 1}` : String(cell).trim();
    const count = seen.get(base.toLowerCase()) ?? 0;
    seen.set(base.toLowerCase(), count + 1);
    return count === 0 ? base : `${base} (${count + 1})`;
  });
}

export function extractTable(sheet: ParsedSheet, worksheetName: string | null, headerRowIndexOverride?: number): ExtractedTable {
  if (sheet.rows.length === 0) {
    throw new ServiceError('PARSE_ERROR', worksheetName ? `Worksheet "${worksheetName}" is empty.` : 'The file is empty.');
  }
  const headerIndex = headerRowIndexOverride ?? detectHeaderRowIndex(sheet.rows);
  if (headerIndex < 0 || headerIndex >= sheet.rows.length) {
    throw new ServiceError('PARSE_ERROR', 'The selected header row is outside the data range.');
  }
  const headerRow = sheet.rows[headerIndex];
  const dataRows = sheet.rows.slice(headerIndex + 1);
  let width = headerRow.length;
  while (width > 0 && headerRow[width - 1] === null && dataRows.every((row) => row[width - 1] === null || row[width - 1] === undefined)) {
    width -= 1;
  }
  const keptColumns: number[] = [];
  for (let index = 0; index < width; index += 1) {
    if (headerRow[index] !== null || dataRows.some((row) => row[index] !== null && row[index] !== undefined)) {
      keptColumns.push(index);
    }
  }
  const headers = uniqueHeaders(keptColumns.map((index) => headerRow[index] ?? null));
  if (headers.length === 0 || headers.every((header) => /^Column \d+$/.test(header))) {
    throw new ServiceError('PARSE_ERROR', 'No header row was found. Add a row of column names above the data.');
  }
  const projected = dataRows.map((row) => keptColumns.map((index) => (row[index] === undefined ? null : row[index])));
  const dimensionColumns = headers
    .map((header, index) => ({ header, index }))
    .filter(({ header, index }) => {
      if (REPORTING_RANGE_COLUMNS.has(normaliseColumnName(header))) {
        return false;
      }
      const populated = projected.map((row) => row[index]).filter((cell) => cell !== null);
      if (populated.length === 0) {
        return false;
      }
      const textual = populated.filter((cell) => !isNumericLike(cell)).length;
      return textual / populated.length >= 0.8;
    })
    .map(({ index }) => index);

  const detailRows: SourceRow[] = [];
  const summaryRows: SourceRow[] = [];
  let blankRowCount = 0;
  projected.forEach((row, offset) => {
    const sourceRowNumber = headerIndex + offset + 2;
    if (row.every((cell) => cell === null)) {
      blankRowCount += 1;
      return;
    }
    const values: Record<string, CellValue> = {};
    headers.forEach((header, index) => {
      values[header] = row[index];
    });
    if (isSummaryRow(row, dimensionColumns)) {
      summaryRows.push({ sourceRowNumber, values });
    } else {
      detailRows.push({ sourceRowNumber, values });
    }
  });
  if (detailRows.length === 0) {
    throw new ServiceError('PARSE_ERROR', 'The file has column headers but no detail data rows.');
  }
  return {
    worksheetName,
    headerRowNumber: headerIndex + 1,
    headers,
    detailRows,
    summaryRows,
    blankRowCount,
    totalRowCount: projected.length,
  };
}

export function selectSheet(workbook: ParsedWorkbook, worksheetName?: string | null): ParsedSheet {
  if (workbook.fileType === 'csv') {
    return workbook.sheets[0];
  }
  if (worksheetName) {
    const sheet = workbook.sheets.find((item) => item.name === worksheetName);
    if (!sheet) {
      throw new ServiceError('VALIDATION', `Worksheet "${worksheetName}" was not found in the workbook.`);
    }
    return sheet;
  }
  const known = getKnownColumnNames();
  const scored = workbook.sheets
    .filter((sheet) => sheet.rows.some((row) => row.some((cell) => cell !== null)))
    .map((sheet) => {
      const headerRow = sheet.rows[detectHeaderRowIndex(sheet.rows)] ?? [];
      const matches = headerRow.filter((cell) => typeof cell === 'string' && known.has(normaliseColumnName(cell))).length;
      return { sheet, matches, rows: sheet.rows.length };
    })
    .sort((left, right) => right.matches - left.matches || right.rows - left.rows);
  if (scored.length === 0) {
    throw new ServiceError('PARSE_ERROR', 'All worksheets in the workbook are empty.');
  }
  return scored[0].sheet;
}
