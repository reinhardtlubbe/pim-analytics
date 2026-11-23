import { Actor } from '../../src/services/auth/permissions';
import { inspectSupplierFile, InspectionMetadata } from '../../src/services/ingestion/ingestionService';
import { confirmMapping } from '../../src/services/mapping/confirmationService';
import { mappingsFromSuggestions } from '../../src/services/mapping/mappingEngine';
import { processUploadedFile, ProcessingSummary } from '../../src/services/processing/processingService';
import { adminActor, TestContext } from './testContext';

export async function uploadBytes(
  ctx: TestContext,
  accountId: number,
  filename: string,
  bytes: Uint8Array,
  actor: Actor = adminActor,
): Promise<InspectionMetadata> {
  const outcome = await inspectSupplierFile(ctx, actor, {
    accountId,
    originalFilename: filename,
    contentType: filename.endsWith('.csv') ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    sizeBytes: bytes.length,
    readBytes: async () => bytes,
  });
  if (outcome.outcome !== 'registered') {
    throw new Error(outcome.message);
  }
  return outcome.inspection;
}

export async function importAndProcess(
  ctx: TestContext,
  accountId: number,
  filename: string,
  bytes: Uint8Array,
): Promise<{ inspection: InspectionMetadata; summary: ProcessingSummary; confirmationId: number }> {
  const inspection = await uploadBytes(ctx, accountId, filename, bytes);
  const confirmation = await confirmMapping(ctx, adminActor, {
    fileId: inspection.fileId,
    columnMappings: mappingsFromSuggestions(inspection.suggestions),
  });
  const summary = await processUploadedFile(ctx, adminActor, { fileId: inspection.fileId, confirmationId: confirmation.confirmationId });
  return { inspection, summary, confirmationId: confirmation.confirmationId };
}
