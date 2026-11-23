import { Db } from '../../database/types';
import { ProcessingLogRow } from '../../database/models';

export type LogSeverity = 'info' | 'warning' | 'error';

export interface AuditEvent {
  eventType: string;
  message: string;
  severity?: LogSeverity;
  runId?: number | null;
  fileId?: number | null;
  userId?: number | null;
  entityType?: string | null;
  entityId?: number | null;
}

export async function recordAuditEvent(db: Db, event: AuditEvent, createdAt: string): Promise<number> {
  const result = await db.run(
    `INSERT INTO processing_logs (run_id, file_id, user_id, event_type, entity_type, entity_id, message, severity, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.runId ?? null,
      event.fileId ?? null,
      event.userId ?? null,
      event.eventType,
      event.entityType ?? null,
      event.entityId ?? null,
      event.message,
      event.severity ?? 'info',
      createdAt,
    ],
  );
  return result.lastInsertRowId;
}

export interface LogQuery {
  runId?: number;
  fileId?: number;
  severity?: LogSeverity;
  eventType?: string;
  limit?: number;
  offset?: number;
}

export interface LogView extends ProcessingLogRow {
  user_email: string | null;
}

export async function listAuditLogs(db: Db, query: LogQuery = {}): Promise<LogView[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (query.runId !== undefined) {
    where.push('l.run_id = ?');
    params.push(query.runId);
  }
  if (query.fileId !== undefined) {
    where.push('l.file_id = ?');
    params.push(query.fileId);
  }
  if (query.severity) {
    where.push('l.severity = ?');
    params.push(query.severity);
  }
  if (query.eventType) {
    where.push('l.event_type = ?');
    params.push(query.eventType);
  }
  params.push(query.limit ?? 200, query.offset ?? 0);
  return db.all<LogView>(
    `SELECT l.*, u.email AS user_email FROM processing_logs l
     LEFT JOIN users u ON u.user_id = l.user_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY l.log_id DESC LIMIT ? OFFSET ?`,
    params,
  );
}
