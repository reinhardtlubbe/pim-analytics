import {
  getStandardField,
  isStandardFieldKey,
  MappingTarget,
  normaliseColumnName,
  SKIP_TARGET,
  STANDARD_FIELDS,
  StandardFieldKey,
  UNRESOLVED_TARGET,
} from '../../config/standardFields';
import { getSupplierConfig, SupplierCode, SupplierConfig, SUPPLIER_CONFIGS } from '../../config/suppliers';
import { CellValue, SourceRow } from '../ingestion/fileParser';

export type MappingStatus = 'matched' | 'review' | 'skipped';
export type MappingSource = 'supplier_exact' | 'supplier_skip' | 'synonym' | 'manual' | 'profile' | 'none';

export interface ColumnMappingSuggestion {
  sourceColumn: string;
  target: MappingTarget;
  status: MappingStatus;
  source: MappingSource;
  candidates: StandardFieldKey[];
  sampleValues: string[];
}

export type ColumnMappings = Record<string, MappingTarget>;

export interface MappingIssue {
  type: 'duplicate_target' | 'invalid_target' | 'unresolved' | 'missing_required' | 'missing_currency' | 'unknown_column';
  message: string;
  columns: string[];
  field?: string;
}

export interface MappingValidationResult {
  valid: boolean;
  issues: MappingIssue[];
  matchedCount: number;
  skippedCount: number;
  reviewCount: number;
  totalColumns: number;
  duplicateTargets: StandardFieldKey[];
}

export function detectSupplier(headers: string[]): { code: SupplierCode | null; score: number; scores: Record<string, number> } {
  const normalised = new Set(headers.map((header) => normaliseColumnName(header)));
  const scores: Record<string, number> = {};
  let best: { code: SupplierCode | null; score: number } = { code: null, score: 0 };
  for (const supplier of SUPPLIER_CONFIGS) {
    const score = supplier.detectionColumns.filter((column) => normalised.has(normaliseColumnName(column))).length;
    scores[supplier.code] = score;
    if (score > best.score) {
      best = { code: supplier.code, score };
    }
  }
  return best.score >= 2 ? { ...best, scores } : { code: null, score: best.score, scores };
}

function formatSample(value: CellValue): string {
  if (value === null) {
    return '';
  }
  const text = String(value);
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

export function collectSampleValues(headers: string[], rows: SourceRow[], limit: number): Record<string, string[]> {
  const samples: Record<string, string[]> = {};
  for (const header of headers) {
    const values: string[] = [];
    for (const row of rows) {
      const value = row.values[header];
      if (value !== null && value !== undefined) {
        const formatted = formatSample(value);
        if (!values.includes(formatted)) {
          values.push(formatted);
        }
      }
      if (values.length >= limit) {
        break;
      }
    }
    samples[header] = values;
  }
  return samples;
}

function findSynonymCandidates(normalised: string): StandardFieldKey[] {
  return STANDARD_FIELDS.filter(
    (field) => normaliseColumnName(field.key) === normalised || field.synonyms.some((synonym) => normaliseColumnName(synonym) === normalised),
  ).map((field) => field.key);
}

export function suggestColumnMappings(
  headers: string[],
  supplierCode: SupplierCode,
  samples: Record<string, string[]> = {},
): ColumnMappingSuggestion[] {
  const supplier = getSupplierConfig(supplierCode);
  const exact = new Map<string, StandardFieldKey>(
    Object.entries(supplier.exactMappings).map(([column, field]) => [normaliseColumnName(column), field]),
  );
  const skip = new Set(supplier.skipColumns.map((column) => normaliseColumnName(column)));
  const used = new Set<StandardFieldKey>();
  const suggestions: ColumnMappingSuggestion[] = headers.map((header) => ({
    sourceColumn: header,
    target: UNRESOLVED_TARGET,
    status: 'review',
    source: 'none',
    candidates: [],
    sampleValues: samples[header] ?? [],
  }));

  suggestions.forEach((suggestion) => {
    const key = normaliseColumnName(suggestion.sourceColumn);
    const field = exact.get(key);
    if (field && !used.has(field)) {
      suggestion.target = field;
      suggestion.status = 'matched';
      suggestion.source = 'supplier_exact';
      suggestion.candidates = [field];
      used.add(field);
    } else if (skip.has(key)) {
      suggestion.target = SKIP_TARGET;
      suggestion.status = 'skipped';
      suggestion.source = 'supplier_skip';
    }
  });

  suggestions.forEach((suggestion) => {
    if (suggestion.source !== 'none') {
      return;
    }
    const candidates = findSynonymCandidates(normaliseColumnName(suggestion.sourceColumn)).filter((field) => !used.has(field));
    suggestion.candidates = candidates;
    if (candidates.length === 1) {
      suggestion.target = candidates[0];
      suggestion.status = 'matched';
      suggestion.source = 'synonym';
      used.add(candidates[0]);
    }
  });
  return suggestions;
}

export function mappingsFromSuggestions(suggestions: ColumnMappingSuggestion[]): ColumnMappings {
  const mappings: ColumnMappings = {};
  suggestions.forEach((suggestion) => {
    mappings[suggestion.sourceColumn] = suggestion.target;
  });
  return mappings;
}

export function statusForTarget(target: MappingTarget): MappingStatus {
  if (target === SKIP_TARGET) {
    return 'skipped';
  }
  return isStandardFieldKey(target) ? 'matched' : 'review';
}

export function findDuplicateTargets(mappings: ColumnMappings): StandardFieldKey[] {
  const counts = new Map<StandardFieldKey, number>();
  Object.values(mappings).forEach((target) => {
    if (isStandardFieldKey(target)) {
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
  });
  return [...counts.entries()].filter(([, count]) => count > 1).map(([field]) => field);
}

export function supplierProvidesCurrency(supplier: SupplierConfig, mappings: ColumnMappings): boolean {
  return Object.values(mappings).includes('currency') || (supplier.currencySource === 'default' && Boolean(supplier.defaults.currency));
}

export function validateColumnMappings(headers: string[], mappings: ColumnMappings, supplierCode: SupplierCode): MappingValidationResult {
  const supplier = getSupplierConfig(supplierCode);
  const issues: MappingIssue[] = [];
  const headerSet = new Set(headers);
  const unknown = Object.keys(mappings).filter((column) => !headerSet.has(column));
  if (unknown.length) {
    issues.push({ type: 'unknown_column', message: `These columns are not in the file: ${unknown.join(', ')}.`, columns: unknown });
  }
  const invalid = headers.filter((header) => {
    const target = mappings[header];
    return target !== undefined && target !== SKIP_TARGET && target !== UNRESOLVED_TARGET && !isStandardFieldKey(target);
  });
  if (invalid.length) {
    issues.push({ type: 'invalid_target', message: `Invalid target fields selected for: ${invalid.join(', ')}.`, columns: invalid });
  }
  const unresolved = headers.filter((header) => !mappings[header]);
  if (unresolved.length) {
    issues.push({
      type: 'unresolved',
      message: `Choose a standard field or Skip for: ${unresolved.join(', ')}.`,
      columns: unresolved,
    });
  }
  const duplicates = findDuplicateTargets(mappings);
  duplicates.forEach((field) => {
    const columns = headers.filter((header) => mappings[header] === field);
    issues.push({
      type: 'duplicate_target',
      message: `${getStandardField(field).label} is mapped from more than one column: ${columns.join(', ')}.`,
      columns,
      field,
    });
  });
  const mappedTargets = new Set(Object.values(mappings));
  supplier.requiredFields.forEach((field) => {
    if (field === 'currency') {
      return;
    }
    if (!mappedTargets.has(field)) {
      issues.push({ type: 'missing_required', message: `${getStandardField(field).label} must be mapped to a source column.`, columns: [], field });
    }
  });
  if (!supplierProvidesCurrency(supplier, mappings)) {
    issues.push({ type: 'missing_currency', message: 'Map a Currency column. This supplier does not have an approved default currency.', columns: [], field: 'currency' });
  }
  const statuses = headers.map((header) => statusForTarget(mappings[header] ?? UNRESOLVED_TARGET));
  const duplicateColumns = new Set(issues.filter((issue) => issue.type === 'duplicate_target').flatMap((issue) => issue.columns));
  const matchedCount = headers.filter((header, index) => statuses[index] === 'matched' && !duplicateColumns.has(header)).length;
  const skippedCount = statuses.filter((status) => status === 'skipped').length;
  return {
    valid: issues.length === 0,
    issues,
    matchedCount,
    skippedCount,
    reviewCount: headers.length - matchedCount - skippedCount,
    totalColumns: headers.length,
    duplicateTargets: duplicates,
  };
}

export function isProfileCompatible(
  profile: { supplierCode: string; fileType: string; sourceColumns: string[] },
  file: { supplierCode: string; fileType: string; headers: string[] },
): boolean {
  if (profile.supplierCode !== file.supplierCode || profile.fileType !== file.fileType) {
    return false;
  }
  const fileColumns = new Set(file.headers.map((header) => normaliseColumnName(header)));
  const profileColumns = profile.sourceColumns.map((column) => normaliseColumnName(column));
  return profileColumns.length === fileColumns.size && profileColumns.every((column) => fileColumns.has(column));
}

export function applyProfileMappings(headers: string[], profileMappings: ColumnMappings): ColumnMappings {
  const byNormalised = new Map(Object.entries(profileMappings).map(([column, target]) => [normaliseColumnName(column), target]));
  const result: ColumnMappings = {};
  headers.forEach((header) => {
    const target = byNormalised.get(normaliseColumnName(header));
    result[header] = target !== undefined && (target === SKIP_TARGET || isStandardFieldKey(target)) ? target : UNRESOLVED_TARGET;
  });
  return result;
}
