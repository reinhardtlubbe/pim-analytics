export type ServiceErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'DUPLICATE_FILE'
  | 'UNSUPPORTED_FILE'
  | 'FILE_TOO_LARGE'
  | 'PARSE_ERROR'
  | 'SUPPLIER_MISMATCH'
  | 'MAPPING_INVALID'
  | 'CONFLICT'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'INSUFFICIENT_DATA'
  | 'PROCESSING_FAILED';

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ServiceErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.details = details;
  }
}

export interface StructuredError {
  code: ServiceErrorCode | 'UNEXPECTED';
  message: string;
  details?: Record<string, unknown>;
}

export function toStructuredError(error: unknown): StructuredError {
  if (error instanceof ServiceError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof Error) {
    return { code: 'UNEXPECTED', message: error.message };
  }
  return { code: 'UNEXPECTED', message: 'An unexpected error occurred.' };
}
