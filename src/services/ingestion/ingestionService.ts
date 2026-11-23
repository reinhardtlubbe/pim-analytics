import { APP_CONFIG } from '../../config/appConfig';
import { SupplierCode } from '../../config/suppliers';
import { UploadedFileRow, UploadedFileView } from '../../database/models';
import { Db } from '../../database/types';
import { parseJson } from '../../utils/async';
import { sha256Hex } from '../../utils/hashing';
import { recordAuditEvent } from '../audit/auditService';
import { Actor, requirePermission } from '../auth/permissions';
import { isoNow, ServiceContext } from '../context';
import { ServiceError } from '../errors';
import { collectSampleValues, ColumnMappingSuggestion, detectSupplier, suggestColumnMappings } from '../mapping/mappingEngine';
import { getAccount } from '../reference/referenceService';
import { ExtractedTable, extractTable, FileType, getFileType, parseWorkbook, ParsedWorkbook, selectSheet } from './fileParser';

export interface SelectedFileInput {
  accountId: number;
  originalFilename: string;
  contentType: string | null;
  sizeBytes: number | null;
  readBytes: () => Promise<Uint8Array>;
}

export interface InspectionMetadata {
  fileId: number;
  originalFilename: string;
  fileType: FileType;
  fileSizeBytes: number;
  fileHash: string;
  supplierId: number;
  supplierCode: SupplierCode;
  supplierName: string;
  detectedSupplierCode: SupplierCode | null;
  accountId: number;
  accountName: string;
  clientName: string;
  headers: string[];
  headerRowNumber: number;
  worksheetName: string | null;
  worksheetNames: string[];
  totalRows: number;
  detailRows: number;
  summaryRows: number;
  blankRows: number;
  summaryRowNumbers: number[];
  encoding: string | null;
  samples: Record<string, string[]>;
  suggestions: ColumnMappingSuggestion[];
  status: string;
  message: string;
}

export type InspectionOutcome =
  | { outcome: 'registered'; inspection: InspectionMetadata }
  | { outcome: 'already_registered'; existingFile: UploadedFileView; message: string };

export function validateSelectedFile(input: { originalFilename: string; contentType: string | null; sizeBytes: number | null }): FileType {
  const fileType = getFileType(input.originalFilename);
  if (!fileType) {
    throw new ServiceError('UNSUPPORTED_FILE', `"${input.originalFilename}" is not supported. Choose a .csv or .xlsx file.`);
  }
  const contentType = input.contentType?.toLowerCase() ?? null;
  if (contentType && !contentType.startsWith('text/') && !APP_CONFIG.allowedContentTypes.includes(contentType)) {
    throw new ServiceError('UNSUPPORTED_FILE', `The file content type "${input.contentType}" is not a CSV or Excel workbook.`);
  }
  if (input.sizeBytes !== null && input.sizeBytes > APP_CONFIG.maxUploadBytes) {
    throw new ServiceError('FILE_TOO_LARGE', `The file is ${(input.sizeBytes / 1048576).toFixed(1)} MB. The maximum supported size is 25 MB.`);
  }
  if (input.sizeBytes === 0) {
    throw new ServiceError('UNSUPPORTED_FILE', 'The selected file is empty.');
  }
  return fileType;
}

function assertSignature(bytes: Uint8Array, fileType: FileType): void {
  if (fileType === 'xlsx') {
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      throw new ServiceError('UNSUPPORTED_FILE', 'The file has an .xlsx extension but is not a valid Excel workbook.');
    }
  } else {
    const probe = bytes.subarray(0, Math.min(bytes.length, 512));
    if (probe.length >= 2 && probe[0] === 0x50 && probe[1] === 0x4b) {
      throw new ServiceError('UNSUPPORTED_FILE', 'The file has a .csv extension but contains a compressed workbook. Save it as CSV or rename it to .xlsx.');
    }
  }
}

const FILE_VIEW_SQL = `SELECT f.*, a.account_name, a.client_id, c.client_name, s.supplier_name, s.supplier_code,
    (SELECT r.run_id FROM processing_runs r WHERE r.file_id = f.file_id ORDER BY r.run_id DESC LIMIT 1) AS latest_run_id,
    (SELECT r.status FROM processing_runs r WHERE r.file_id = f.file_id ORDER BY r.run_id DESC LIMIT 1) AS latest_run_status,
    (SELECT m.confirmation_id FROM mapping_confirmations m WHERE m.file_id = f.file_id ORDER BY m.confirmation_id DESC LIMIT 1) AS latest_confirmation_id
  FROM uploaded_files f
  JOIN advertising_accounts a ON a.account_id = f.account_id
  JOIN clients c ON c.client_id = a.client_id
  JOIN suppliers s ON s.supplier_id = f.supplier_id`;

export async function getUploadedFile(db: Db, fileId: number): Promise<UploadedFileView> {
  const file = await db.first<UploadedFileView>(`${FILE_VIEW_SQL} WHERE f.file_id = ?`, [fileId]);
  if (!file) {
    throw new ServiceError('NOT_FOUND', 'Uploaded file not found.');
  }
  return file;
}

export async function listUploadedFiles(ctx: ServiceContext, filter: { accountId?: number; clientId?: number } = {}): Promise<UploadedFileView[]> {
  const where: string[] = [];
  const params: number[] = [];
  if (filter.accountId !== undefined) {
    where.push('f.account_id = ?');
    params.push(filter.accountId);
  }
  if (filter.clientId !== undefined) {
    where.push('a.client_id = ?');
    params.push(filter.clientId);
  }
  return ctx.db.all<UploadedFileView>(`${FILE_VIEW_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY f.file_id DESC`, params);
}

export interface LoadedTable {
  file: UploadedFileView;
  workbook: ParsedWorkbook;
  table: ExtractedTable;
}

export async function loadStoredTable(ctx: ServiceContext, fileId: number, worksheetName?: string | null, headerRowNumber?: number): Promise<LoadedTable> {
  const file = await getUploadedFile(ctx.db, fileId);
  const bytes = await ctx.files.readImport(file.stored_uri);
  if (sha256Hex(bytes) !== file.file_hash) {
    throw new ServiceError('CONFLICT', 'The stored copy of this file no longer matches the registered hash. Upload the file again.');
  }
  const workbook = parseWorkbook(bytes, file.file_type);
  const sheetName = worksheetName === undefined ? file.worksheet_name : worksheetName;
  const sheet = selectSheet(workbook, sheetName);
  const table = extractTable(sheet, workbook.fileType === 'xlsx' ? sheet.name : null, headerRowNumber !== undefined ? headerRowNumber - 1 : file.header_row_number - 1);
  return { file, workbook, table };
}

function buildInspection(file: UploadedFileView, workbook: ParsedWorkbook, table: ExtractedTable, message: string): InspectionMetadata {
  const samples = collectSampleValues(table.headers, table.detailRows, APP_CONFIG.sampleValueCount);
  const supplierCode = file.supplier_code as SupplierCode;
  return {
    fileId: file.file_id,
    originalFilename: file.original_filename,
    fileType: file.file_type,
    fileSizeBytes: file.file_size_bytes,
    fileHash: file.file_hash,
    supplierId: file.supplier_id,
    supplierCode,
    supplierName: file.supplier_name,
    detectedSupplierCode: (file.detected_supplier_code as SupplierCode | null) ?? null,
    accountId: file.account_id,
    accountName: file.account_name,
    clientName: file.client_name,
    headers: table.headers,
    headerRowNumber: table.headerRowNumber,
    worksheetName: table.worksheetName,
    worksheetNames: workbook.fileType === 'xlsx' ? workbook.sheets.map((sheet) => sheet.name) : [],
    totalRows: table.totalRowCount,
    detailRows: table.detailRows.length,
    summaryRows: table.summaryRows.length,
    blankRows: table.blankRowCount,
    summaryRowNumbers: table.summaryRows.map((row) => row.sourceRowNumber),
    encoding: workbook.encoding,
    samples,
    suggestions: suggestColumnMappings(table.headers, supplierCode, samples),
    status: file.status,
    message,
  };
}

function describeLoad(file: { original_filename: string }, table: ExtractedTable): string {
  const summary = table.summaryRows.length ? `, ${table.summaryRows.length} summary row${table.summaryRows.length === 1 ? '' : 's'} excluded` : '';
  return `Loaded "${file.original_filename}": ${table.detailRows.length} detail row${table.detailRows.length === 1 ? '' : 's'} and ${table.headers.length} column${table.headers.length === 1 ? '' : 's'}${summary}.`;
}

export async function inspectSupplierFile(ctx: ServiceContext, actor: Actor, input: SelectedFileInput): Promise<InspectionOutcome> {
  requirePermission(actor, 'files.upload');
  const fileType = validateSelectedFile(input);
  const account = await getAccount(ctx, input.accountId);
  const bytes = await input.readBytes();
  if (bytes.length > APP_CONFIG.maxUploadBytes) {
    throw new ServiceError('FILE_TOO_LARGE', `The file is ${(bytes.length / 1048576).toFixed(1)} MB. The maximum supported size is 25 MB.`);
  }
  if (bytes.length === 0) {
    throw new ServiceError('UNSUPPORTED_FILE', 'The selected file is empty.');
  }
  assertSignature(bytes, fileType);
  const fileHash = sha256Hex(bytes);
  const existing = await ctx.db.first<{ file_id: number }>('SELECT file_id FROM uploaded_files WHERE account_id = ? AND file_hash = ?', [
    input.accountId,
    fileHash,
  ]);
  if (existing) {
    const existingFile = await getUploadedFile(ctx.db, existing.file_id);
    return {
      outcome: 'already_registered',
      existingFile,
      message: `This file was already uploaded to ${account.account_name} on ${existingFile.upload_date.slice(0, 10)} as "${existingFile.original_filename}". Resume the existing upload instead of importing it again.`,
    };
  }
  const workbook = parseWorkbook(bytes, fileType);
  const sheet = selectSheet(workbook);
  const table = extractTable(sheet, fileType === 'xlsx' ? sheet.name : null);
  const detection = detectSupplier(table.headers);
  if (detection.code && detection.code !== account.supplier_code) {
    throw new ServiceError(
      'SUPPLIER_MISMATCH',
      `This file looks like a ${detection.code === 'meta' ? 'Meta' : detection.code === 'tiktok' ? 'TikTok' : 'Google Ads'} export, but ${account.account_name} is a ${account.supplier_name} account. Choose the matching advertising account.`,
      { detectedSupplier: detection.code, accountSupplier: account.supplier_code },
    );
  }
  const now = isoNow(ctx);
  const storedFilename = `${fileHash.slice(0, 16)}_${input.accountId}.${fileType}`;
  const storedUri = await ctx.files.saveImport(storedFilename, bytes);
  const fileId = await ctx.db.transaction(async (tx) => {
    const result = await tx.run(
      `INSERT INTO uploaded_files (account_id, supplier_id, original_filename, stored_filename, stored_uri, file_type, content_type,
         file_size_bytes, file_hash, record_count, total_rows, summary_rows, blank_rows, header_row_number, worksheet_name,
         worksheet_names_json, source_columns_json, detected_supplier_code, status, uploaded_by, upload_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'registered', ?, ?)`,
      [
        input.accountId,
        account.supplier_id,
        input.originalFilename,
        storedFilename,
        storedUri,
        fileType,
        input.contentType,
        bytes.length,
        fileHash,
        table.detailRows.length,
        table.totalRowCount,
        table.summaryRows.length,
        table.blankRowCount,
        table.headerRowNumber,
        table.worksheetName,
        JSON.stringify(workbook.fileType === 'xlsx' ? workbook.sheets.map((item) => item.name) : []),
        JSON.stringify(table.headers),
        detection.code,
        actor.userId,
        now,
      ],
    );
    await recordAuditEvent(
      tx,
      {
        eventType: 'file.registered',
        message: `Registered "${input.originalFilename}" (${table.detailRows.length} detail rows, ${table.summaryRows.length} summary rows) for ${account.account_name}.`,
        fileId: result.lastInsertRowId,
        userId: actor.userId,
        entityType: 'file',
        entityId: result.lastInsertRowId,
      },
      now,
    );
    return result.lastInsertRowId;
  });
  const file = await getUploadedFile(ctx.db, fileId);
  return { outcome: 'registered', inspection: buildInspection(file, workbook, table, describeLoad(file, table)) };
}

export async function resumeUploadedFile(ctx: ServiceContext, fileId: number): Promise<InspectionMetadata> {
  const { file, workbook, table } = await loadStoredTable(ctx, fileId);
  return buildInspection(file, workbook, table, `Resumed "${file.original_filename}": ${table.detailRows.length} detail rows and ${table.headers.length} columns.`);
}

export async function changeFileLayout(
  ctx: ServiceContext,
  actor: Actor,
  fileId: number,
  layout: { worksheetName?: string | null; headerRowNumber?: number },
): Promise<InspectionMetadata> {
  requirePermission(actor, 'files.upload');
  const current = await getUploadedFile(ctx.db, fileId);
  const worksheetChanged = layout.worksheetName !== undefined && layout.worksheetName !== current.worksheet_name;
  const { file, workbook } = await loadStoredTable(ctx, fileId);
  const sheet = selectSheet(workbook, layout.worksheetName === undefined ? current.worksheet_name : layout.worksheetName);
  const headerIndex = layout.headerRowNumber !== undefined ? layout.headerRowNumber - 1 : worksheetChanged ? undefined : current.header_row_number - 1;
  const table = extractTable(sheet, workbook.fileType === 'xlsx' ? sheet.name : null, headerIndex);
  const now = isoNow(ctx);
  await ctx.db.transaction(async (tx) => {
    await tx.run(
      `UPDATE uploaded_files SET worksheet_name = ?, header_row_number = ?, record_count = ?, total_rows = ?, summary_rows = ?, blank_rows = ?,
        source_columns_json = ? WHERE file_id = ?`,
      [table.worksheetName, table.headerRowNumber, table.detailRows.length, table.totalRowCount, table.summaryRows.length, table.blankRowCount, JSON.stringify(table.headers), fileId],
    );
    await recordAuditEvent(
      tx,
      {
        eventType: 'file.layout_changed',
        message: `Layout for "${file.original_filename}" set to ${table.worksheetName ? `worksheet "${table.worksheetName}", ` : ''}header row ${table.headerRowNumber}.`,
        fileId,
        userId: actor.userId,
        entityType: 'file',
        entityId: fileId,
      },
      now,
    );
  });
  const updated = await getUploadedFile(ctx.db, fileId);
  return buildInspection(updated, workbook, table, describeLoad(updated, table));
}

export function fileSourceColumns(file: UploadedFileRow): string[] {
  return parseJson<string[]>(file.source_columns_json, []);
}
