export type SqlValue = string | number | null | Uint8Array;
export type SqlParams = SqlValue[];

export interface RunResult {
  lastInsertRowId: number;
  changes: number;
}

export interface Db {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlParams): Promise<RunResult>;
  all<T>(sql: string, params?: SqlParams): Promise<T[]>;
  first<T>(sql: string, params?: SqlParams): Promise<T | null>;
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T>;
}

export interface RawConnection {
  exec(sql: string): Promise<void>;
  run(sql: string, params: SqlParams): Promise<RunResult>;
  all<T>(sql: string, params: SqlParams): Promise<T[]>;
  first<T>(sql: string, params: SqlParams): Promise<T | null>;
  close(): Promise<void>;
}
