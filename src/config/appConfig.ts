export const APP_CONFIG = {
  databaseName: 'planit_media.db',
  maxUploadBytes: 25 * 1024 * 1024,
  allowedExtensions: ['.csv', '.xlsx'] as const,
  allowedContentTypes: [
    'text/csv',
    'text/comma-separated-values',
    'application/csv',
    'text/plain',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream',
  ],
  headerScanRows: 15,
  sampleValueCount: 3,
  processingChunkSize: 500,
  insertBatchSize: 100,
  resultsPageSize: 25,
  sessionDurationDays: 7,
  passwordIterations: 20000,
  minimumHistoryMonths: 3,
  seasonalityMinimumMonths: 12,
  diminishingReturnsMinimumObservations: 6,
  diminishingReturnsThreshold: 0.25,
  defaultScenarioVariation: 0.2,
  dayFirstDates: true,
  demoAdmin: {
    email: 'admin@planitmedia.com',
    password: 'PlanIt2026!',
    displayName: 'Evaluation Administrator',
  },
};

export type AllowedExtension = (typeof APP_CONFIG.allowedExtensions)[number];
