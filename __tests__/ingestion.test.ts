import { APP_CONFIG } from '../src/config/appConfig';
import { inspectSupplierFile, resumeUploadedFile, changeFileLayout, listUploadedFiles } from '../src/services/ingestion/ingestionService';
import { parseCsvBytes } from '../src/services/ingestion/fileParser';
import { buildMetaXlsx, buildTikTokCsv, buildTikTokRows } from './helpers/fixtures';
import { adminActor, createInitializedContext, getAccountId, TestContext, viewerActor } from './helpers/testContext';
import { uploadBytes } from './helpers/workflow';

describe('file ingestion and inspection', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createInitializedContext();
  });

  afterEach(async () => {
    await ctx.db.close();
  });

  it('inspects a valid CSV, excludes the summary row and registers the file', async () => {
    const accountId = await getAccountId(ctx, 'tiktok');
    const bytes = buildTikTokCsv();
    const inspection = await uploadBytes(ctx, accountId, 'synthetic_tiktok.csv', bytes);
    expect(inspection.detectedSupplierCode).toBe('tiktok');
    expect(inspection.detailRows).toBe(buildTikTokRows().length);
    expect(inspection.summaryRows).toBe(1);
    expect(inspection.totalRows).toBe(inspection.detailRows + inspection.summaryRows + inspection.blankRows);
    expect(inspection.headers).toHaveLength(9);
    expect(inspection.samples['Spend'][0]).toBe('1000.00');
    expect(inspection.message).toContain(`${inspection.detailRows} detail rows and 9 columns`);
    const stored = await ctx.db.first<{ record_count: number; file_hash: string; status: string }>('SELECT * FROM uploaded_files WHERE file_id = ?', [inspection.fileId]);
    expect(stored).toMatchObject({ record_count: inspection.detailRows, status: 'registered' });
    expect(stored?.file_hash).toMatch(/^[0-9a-f]{64}$/);
    const log = await ctx.db.first<{ event_type: string }>("SELECT event_type FROM processing_logs WHERE event_type = 'file.registered'");
    expect(log).not.toBeNull();
  });

  it('inspects a valid XLSX, picks the data worksheet and excludes the Meta total row', async () => {
    const accountId = await getAccountId(ctx, 'meta');
    const inspection = await uploadBytes(ctx, accountId, 'synthetic_meta.xlsx', buildMetaXlsx({ extraSheet: true, missingClickEvery: 4 }));
    expect(inspection.worksheetNames).toEqual(['Notes', 'Raw Data Report']);
    expect(inspection.worksheetName).toBe('Raw Data Report');
    expect(inspection.detectedSupplierCode).toBe('meta');
    expect(inspection.detailRows).toBe(9);
    expect(inspection.summaryRows).toBe(1);
    expect(inspection.summaryRowNumbers).toEqual([2]);
  });

  it('rejects unsupported file types', async () => {
    const accountId = await getAccountId(ctx, 'meta');
    await expect(
      inspectSupplierFile(ctx, adminActor, {
        accountId,
        originalFilename: 'report.pdf',
        contentType: 'application/pdf',
        sizeBytes: 10,
        readBytes: async () => new Uint8Array(10),
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
  });

  it('rejects files larger than 25 MB before reading them', async () => {
    const accountId = await getAccountId(ctx, 'meta');
    const readBytes = jest.fn(async () => new Uint8Array(1));
    await expect(
      inspectSupplierFile(ctx, adminActor, {
        accountId,
        originalFilename: 'huge.csv',
        contentType: 'text/csv',
        sizeBytes: APP_CONFIG.maxUploadBytes + 1,
        readBytes,
      }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(readBytes).not.toHaveBeenCalled();
  });

  it('detects a repeated upload for the same account and offers to resume it', async () => {
    const accountId = await getAccountId(ctx, 'tiktok');
    const bytes = buildTikTokCsv();
    const first = await uploadBytes(ctx, accountId, 'first.csv', bytes);
    const second = await inspectSupplierFile(ctx, adminActor, {
      accountId,
      originalFilename: 'renamed-copy.csv',
      contentType: 'text/csv',
      sizeBytes: bytes.length,
      readBytes: async () => bytes,
    });
    expect(second.outcome).toBe('already_registered');
    if (second.outcome === 'already_registered') {
      expect(second.existingFile.file_id).toBe(first.fileId);
      expect(second.message).toContain('Resume');
    }
    const files = await listUploadedFiles(ctx);
    expect(files).toHaveLength(1);
    const resumed = await resumeUploadedFile(ctx, first.fileId);
    expect(resumed.fileId).toBe(first.fileId);
    expect(resumed.detailRows).toBe(first.detailRows);
  });

  it('rejects a file whose detected supplier does not match the advertising account', async () => {
    const metaAccount = await getAccountId(ctx, 'meta');
    await expect(uploadBytes(ctx, metaAccount, 'tiktok.csv', buildTikTokCsv())).rejects.toMatchObject({ code: 'SUPPLIER_MISMATCH' });
  });

  it('blocks viewers from uploading', async () => {
    const accountId = await getAccountId(ctx, 'tiktok');
    await expect(uploadBytes(ctx, accountId, 'viewer.csv', buildTikTokCsv(), viewerActor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('decodes Windows-1252 CSV content when UTF-8 decoding fails', () => {
    const header = Array.from('Campaign name,Spend\r\nCaf');
    const bytes = new Uint8Array([...header.map((char) => char.charCodeAt(0)), 0xe9, ...Array.from(',10').map((char) => char.charCodeAt(0))]);
    const parsed = parseCsvBytes(bytes);
    expect(parsed.encoding).toBe('windows-1252');
    expect(parsed.sheets[0].rows[1][0]).toBe('Café');
  });

  it('allows the header row to be changed and recounts the rows', async () => {
    const accountId = await getAccountId(ctx, 'meta');
    const inspection = await uploadBytes(ctx, accountId, 'meta.xlsx', buildMetaXlsx());
    const changed = await changeFileLayout(ctx, adminActor, inspection.fileId, { headerRowNumber: 1 });
    expect(changed.headerRowNumber).toBe(1);
    expect(changed.detailRows).toBe(inspection.detailRows);
  });
});
