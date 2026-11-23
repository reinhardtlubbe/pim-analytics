import { MappingTarget } from '../../config/standardFields';
import { SupplierCode } from '../../config/suppliers';
import { MappingProfileRow } from '../../database/models';
import { parseJson } from '../../utils/async';
import { recordAuditEvent } from '../audit/auditService';
import { Actor, requirePermission } from '../auth/permissions';
import { isoNow, ServiceContext } from '../context';
import { ServiceError } from '../errors';
import { FileType } from '../ingestion/fileParser';
import { ColumnMappings, findDuplicateTargets, isProfileCompatible } from './mappingEngine';

export interface MappingProfile {
  profileId: number;
  supplierId: number;
  supplierCode: SupplierCode;
  supplierName: string;
  profileName: string;
  fileType: FileType;
  columnMappings: ColumnMappings;
  sourceColumns: string[];
  headerRowNumber: number;
  worksheetName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MappingProfileInput {
  supplierId: number;
  profileName: string;
  fileType: FileType;
  columnMappings: ColumnMappings;
  headerRowNumber?: number;
  worksheetName?: string | null;
}

type ProfileJoinRow = MappingProfileRow & { supplier_code: string; supplier_name: string };

function toProfile(row: ProfileJoinRow): MappingProfile {
  return {
    profileId: row.profile_id,
    supplierId: row.supplier_id,
    supplierCode: row.supplier_code as SupplierCode,
    supplierName: row.supplier_name,
    profileName: row.profile_name,
    fileType: row.file_type,
    columnMappings: parseJson<ColumnMappings>(row.column_mappings_json, {}),
    sourceColumns: parseJson<string[]>(row.source_columns_json, []),
    headerRowNumber: row.header_row_number,
    worksheetName: row.worksheet_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PROFILE_SQL = `SELECT p.*, s.supplier_code, s.supplier_name FROM mapping_profiles p JOIN suppliers s ON s.supplier_id = p.supplier_id`;

function validateProfileInput(input: MappingProfileInput): void {
  if (!input.profileName.trim()) {
    throw new ServiceError('VALIDATION', 'Enter a profile name.', { field: 'profileName' });
  }
  if (input.profileName.trim().length > 80) {
    throw new ServiceError('VALIDATION', 'Profile names must be 80 characters or fewer.', { field: 'profileName' });
  }
  if (input.fileType !== 'csv' && input.fileType !== 'xlsx') {
    throw new ServiceError('VALIDATION', 'Profiles must target CSV or XLSX files.');
  }
  const columns = Object.keys(input.columnMappings);
  if (columns.length === 0) {
    throw new ServiceError('VALIDATION', 'A profile needs at least one column mapping.');
  }
  const duplicates = findDuplicateTargets(input.columnMappings);
  if (duplicates.length) {
    throw new ServiceError('MAPPING_INVALID', `Each standard field can only be mapped once. Duplicated: ${duplicates.join(', ')}.`);
  }
}

async function assertUniqueName(ctx: ServiceContext, supplierId: number, name: string, excludingId: number): Promise<void> {
  const clash = await ctx.db.first<{ profile_id: number }>(
    'SELECT profile_id FROM mapping_profiles WHERE supplier_id = ? AND profile_name = ? AND profile_id <> ?',
    [supplierId, name, excludingId],
  );
  if (clash) {
    throw new ServiceError('CONFLICT', `A profile named "${name}" already exists for this supplier.`);
  }
}

export async function createMappingProfile(ctx: ServiceContext, actor: Actor, input: MappingProfileInput): Promise<MappingProfile> {
  requirePermission(actor, 'mappings.manage');
  validateProfileInput(input);
  const name = input.profileName.trim();
  const supplier = await ctx.db.first<{ supplier_id: number }>('SELECT supplier_id FROM suppliers WHERE supplier_id = ?', [input.supplierId]);
  if (!supplier) {
    throw new ServiceError('VALIDATION', 'Choose a valid supplier for the profile.');
  }
  await assertUniqueName(ctx, input.supplierId, name, -1);
  const now = isoNow(ctx);
  const profileId = await ctx.db.transaction(async (tx) => {
    const result = await tx.run(
      `INSERT INTO mapping_profiles (supplier_id, profile_name, file_type, column_mappings_json, source_columns_json, header_row_number, worksheet_name, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.supplierId,
        name,
        input.fileType,
        JSON.stringify(input.columnMappings),
        JSON.stringify(Object.keys(input.columnMappings)),
        input.headerRowNumber ?? 1,
        input.worksheetName ?? null,
        actor.userId,
        now,
        now,
      ],
    );
    await recordAuditEvent(
      tx,
      { eventType: 'profile.created', message: `Mapping profile "${name}" created.`, userId: actor.userId, entityType: 'mapping_profile', entityId: result.lastInsertRowId },
      now,
    );
    return result.lastInsertRowId;
  });
  return getMappingProfile(ctx, profileId);
}

export async function getMappingProfile(ctx: ServiceContext, profileId: number): Promise<MappingProfile> {
  const row = await ctx.db.first<ProfileJoinRow>(`${PROFILE_SQL} WHERE p.profile_id = ?`, [profileId]);
  if (!row) {
    throw new ServiceError('NOT_FOUND', 'Mapping profile not found.');
  }
  return toProfile(row);
}

export async function listMappingProfiles(ctx: ServiceContext, filter: { supplierId?: number } = {}): Promise<MappingProfile[]> {
  const rows = await ctx.db.all<ProfileJoinRow>(
    `${PROFILE_SQL} ${filter.supplierId !== undefined ? 'WHERE p.supplier_id = ?' : ''} ORDER BY s.supplier_name, p.profile_name`,
    filter.supplierId !== undefined ? [filter.supplierId] : [],
  );
  return rows.map(toProfile);
}

export async function listCompatibleProfiles(
  ctx: ServiceContext,
  file: { supplierCode: SupplierCode; fileType: FileType; headers: string[] },
): Promise<MappingProfile[]> {
  const profiles = await listMappingProfiles(ctx);
  return profiles.filter((profile) => isProfileCompatible(profile, file));
}

export async function updateMappingProfile(
  ctx: ServiceContext,
  actor: Actor,
  profileId: number,
  changes: { profileName?: string; columnMappings?: ColumnMappings; headerRowNumber?: number; worksheetName?: string | null },
): Promise<MappingProfile> {
  requirePermission(actor, 'mappings.manage');
  const existing = await getMappingProfile(ctx, profileId);
  const merged: MappingProfileInput = {
    supplierId: existing.supplierId,
    profileName: changes.profileName ?? existing.profileName,
    fileType: existing.fileType,
    columnMappings: changes.columnMappings ?? existing.columnMappings,
    headerRowNumber: changes.headerRowNumber ?? existing.headerRowNumber,
    worksheetName: changes.worksheetName === undefined ? existing.worksheetName : changes.worksheetName,
  };
  validateProfileInput(merged);
  const name = merged.profileName.trim();
  await assertUniqueName(ctx, existing.supplierId, name, profileId);
  const now = isoNow(ctx);
  await ctx.db.transaction(async (tx) => {
    await tx.run(
      `UPDATE mapping_profiles SET profile_name = ?, column_mappings_json = ?, source_columns_json = ?, header_row_number = ?, worksheet_name = ?, updated_at = ?
       WHERE profile_id = ?`,
      [
        name,
        JSON.stringify(merged.columnMappings),
        JSON.stringify(Object.keys(merged.columnMappings)),
        merged.headerRowNumber ?? 1,
        merged.worksheetName ?? null,
        now,
        profileId,
      ],
    );
    const renamed = name !== existing.profileName ? ` (renamed from "${existing.profileName}")` : '';
    await recordAuditEvent(
      tx,
      { eventType: 'profile.updated', message: `Mapping profile "${name}" updated${renamed}.`, userId: actor.userId, entityType: 'mapping_profile', entityId: profileId },
      now,
    );
  });
  return getMappingProfile(ctx, profileId);
}

export async function deleteMappingProfile(ctx: ServiceContext, actor: Actor, profileId: number): Promise<void> {
  requirePermission(actor, 'mappings.manage');
  const existing = await getMappingProfile(ctx, profileId);
  const now = isoNow(ctx);
  await ctx.db.transaction(async (tx) => {
    await tx.run('DELETE FROM mapping_profiles WHERE profile_id = ?', [profileId]);
    await recordAuditEvent(
      tx,
      { eventType: 'profile.deleted', message: `Mapping profile "${existing.profileName}" deleted. Confirmed import snapshots are unaffected.`, userId: actor.userId, entityType: 'mapping_profile', entityId: profileId },
      now,
    );
  });
}

export function describeTarget(target: MappingTarget): string {
  return target === '' ? 'Unresolved' : target === 'skip' ? 'Skipped' : target;
}
