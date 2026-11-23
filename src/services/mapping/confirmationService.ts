import { getSupplierConfig, SupplierCode, SupplierDefaults } from '../../config/suppliers';
import { MappingConfirmationRow } from '../../database/models';
import { parseJson } from '../../utils/async';
import { recordAuditEvent } from '../audit/auditService';
import { Actor, requirePermission } from '../auth/permissions';
import { isoNow, ServiceContext } from '../context';
import { ServiceError } from '../errors';
import { loadStoredTable } from '../ingestion/ingestionService';
import { ColumnMappings, validateColumnMappings } from './mappingEngine';

export interface ConfirmedMapping {
  confirmationId: number;
  fileId: number;
  sourceFileHash: string;
  supplierName: string;
  supplierCode: SupplierCode;
  profileId: number | null;
  profileName: string | null;
  sourceColumns: string[];
  columnMappings: ColumnMappings;
  supplierDefaults: SupplierDefaults & { supplierCode: SupplierCode; currencySource: 'column' | 'default' };
  headerRowNumber: number;
  worksheetName: string | null;
  confirmedAt: string;
}

export function toConfirmedMapping(row: MappingConfirmationRow): ConfirmedMapping {
  const defaults = parseJson<ConfirmedMapping['supplierDefaults']>(row.supplier_defaults_json, {
    platform: row.supplier_name,
    currency: null,
    clickMetricType: 'click',
    supplierCode: 'meta',
    currencySource: 'column',
  });
  return {
    confirmationId: row.confirmation_id,
    fileId: row.file_id,
    sourceFileHash: row.source_file_hash,
    supplierName: row.supplier_name,
    supplierCode: defaults.supplierCode,
    profileId: row.profile_id,
    profileName: row.profile_name,
    sourceColumns: parseJson<string[]>(row.source_columns_json, []),
    columnMappings: parseJson<ColumnMappings>(row.column_mappings_json, {}),
    supplierDefaults: defaults,
    headerRowNumber: row.header_row_number,
    worksheetName: row.worksheet_name,
    confirmedAt: row.confirmed_at,
  };
}

export async function getMappingConfirmation(ctx: ServiceContext, confirmationId: number): Promise<ConfirmedMapping> {
  const row = await ctx.db.first<MappingConfirmationRow>('SELECT * FROM mapping_confirmations WHERE confirmation_id = ?', [confirmationId]);
  if (!row) {
    throw new ServiceError('NOT_FOUND', 'Mapping confirmation not found.');
  }
  return toConfirmedMapping(row);
}

export async function listMappingConfirmations(ctx: ServiceContext, fileId: number): Promise<ConfirmedMapping[]> {
  const rows = await ctx.db.all<MappingConfirmationRow>('SELECT * FROM mapping_confirmations WHERE file_id = ? ORDER BY confirmation_id DESC', [fileId]);
  return rows.map(toConfirmedMapping);
}

export async function confirmMapping(
  ctx: ServiceContext,
  actor: Actor,
  input: { fileId: number; columnMappings: ColumnMappings; profileId?: number | null },
): Promise<ConfirmedMapping> {
  requirePermission(actor, 'files.process');
  const { file, table } = await loadStoredTable(ctx, input.fileId);
  const supplierCode = file.supplier_code as SupplierCode;
  const validation = validateColumnMappings(table.headers, input.columnMappings, supplierCode);
  if (!validation.valid) {
    throw new ServiceError('MAPPING_INVALID', validation.issues.map((issue) => issue.message).join(' '), { issues: validation.issues });
  }
  let profileName: string | null = null;
  if (input.profileId) {
    const profile = await ctx.db.first<{ profile_name: string; supplier_id: number }>('SELECT profile_name, supplier_id FROM mapping_profiles WHERE profile_id = ?', [
      input.profileId,
    ]);
    if (!profile || profile.supplier_id !== file.supplier_id) {
      throw new ServiceError('VALIDATION', 'The selected mapping profile does not belong to this supplier.');
    }
    profileName = profile.profile_name;
  }
  const supplier = getSupplierConfig(supplierCode);
  const defaults = { ...supplier.defaults, supplierCode, currencySource: supplier.currencySource };
  const orderedMappings: ColumnMappings = {};
  table.headers.forEach((header) => {
    orderedMappings[header] = input.columnMappings[header];
  });
  const now = isoNow(ctx);
  const confirmationId = await ctx.db.transaction(async (tx) => {
    const result = await tx.run(
      `INSERT INTO mapping_confirmations (file_id, source_file_hash, supplier_name, profile_id, profile_name, source_columns_json, column_mappings_json,
        supplier_defaults_json, header_row_number, worksheet_name, confirmed_by, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        file.file_id,
        file.file_hash,
        file.supplier_name,
        input.profileId ?? null,
        profileName,
        JSON.stringify(table.headers),
        JSON.stringify(orderedMappings),
        JSON.stringify(defaults),
        table.headerRowNumber,
        table.worksheetName,
        actor.userId,
        now,
      ],
    );
    await tx.run("UPDATE uploaded_files SET status = CASE WHEN status = 'processed' THEN status ELSE 'mapped' END WHERE file_id = ?", [file.file_id]);
    await recordAuditEvent(
      tx,
      {
        eventType: 'mapping.confirmed',
        message: `Mapping confirmed for "${file.original_filename}" (${validation.matchedCount} matched, ${validation.skippedCount} skipped${profileName ? `, profile "${profileName}"` : ''}).`,
        fileId: file.file_id,
        userId: actor.userId,
        entityType: 'mapping_confirmation',
        entityId: result.lastInsertRowId,
      },
      now,
    );
    return result.lastInsertRowId;
  });
  return getMappingConfirmation(ctx, confirmationId);
}
