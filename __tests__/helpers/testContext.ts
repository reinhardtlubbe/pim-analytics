import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase } from '../../src/database/initialize';
import { createLockedDb, ManagedDb } from '../../src/database/lockedDb';
import { RawConnection, SqlParams } from '../../src/database/types';
import { Actor } from '../../src/services/auth/permissions';
import { FileStore, ServiceContext } from '../../src/services/context';

export function openNodeConnection(path: string): RawConnection {
  const database = new DatabaseSync(path);
  const bind = (params: SqlParams) => params as unknown as (string | number | null | Uint8Array)[];
  return {
    exec: async (sql: string) => {
      database.exec(sql);
    },
    run: async (sql: string, params: SqlParams) => {
      const result = database.prepare(sql).run(...bind(params));
      return { lastInsertRowId: Number(result.lastInsertRowid), changes: Number(result.changes) };
    },
    all: async <T>(sql: string, params: SqlParams) => database.prepare(sql).all(...bind(params)) as unknown as T[],
    first: async <T>(sql: string, params: SqlParams) => {
      const row = database.prepare(sql).get(...bind(params));
      return (row ?? null) as T | null;
    },
    close: async () => {
      database.close();
    },
  };
}

export class MemoryFileStore implements FileStore {
  readonly imports = new Map<string, Uint8Array>();
  readonly exports = new Map<string, string | Uint8Array>();

  async saveImport(storedFilename: string, bytes: Uint8Array): Promise<string> {
    const uri = `memory://imports/${storedFilename}`;
    this.imports.set(uri, bytes);
    return uri;
  }

  async readImport(storedUri: string): Promise<Uint8Array> {
    const bytes = this.imports.get(storedUri);
    if (!bytes) {
      throw new Error(`Missing stored import ${storedUri}`);
    }
    return bytes;
  }

  async writeExport(filename: string, content: string | Uint8Array): Promise<string> {
    const uri = `memory://exports/${filename}`;
    this.exports.set(uri, content);
    return uri;
  }
}

export interface TestContext extends ServiceContext {
  db: ManagedDb;
  files: MemoryFileStore;
  setNow(value: string): void;
}

export function createTestContext(path = ':memory:', files = new MemoryFileStore()): TestContext {
  let current = new Date('2026-10-01T08:00:00.000Z');
  const db = createLockedDb(openNodeConnection(path));
  return {
    db,
    files,
    clock: { now: () => new Date(current.getTime()) },
    random: { bytes: (length: number) => new Uint8Array(randomBytes(length)) },
    setNow(value: string) {
      current = new Date(value);
    },
  };
}

export async function createInitializedContext(path = ':memory:'): Promise<TestContext> {
  const ctx = createTestContext(path);
  await initializeDatabase(ctx);
  return ctx;
}

export const adminActor: Actor = { userId: 1, email: 'admin@planitmedia.com', displayName: 'Admin', roles: ['Administrator'] };
export const analystActor: Actor = { userId: 1, email: 'analyst@example.com', displayName: 'Analyst', roles: ['Analyst'] };
export const viewerActor: Actor = { userId: 1, email: 'viewer@example.com', displayName: 'Viewer', roles: ['Viewer'] };

export async function getAccountId(ctx: ServiceContext, supplierCode: 'meta' | 'tiktok'): Promise<number> {
  const row = await ctx.db.first<{ account_id: number }>(
    'SELECT a.account_id FROM advertising_accounts a JOIN suppliers s ON s.supplier_id = a.supplier_id WHERE s.supplier_code = ? ORDER BY a.account_id LIMIT 1',
    [supplierCode],
  );
  if (!row) {
    throw new Error('Evaluation account missing');
  }
  return row.account_id;
}
