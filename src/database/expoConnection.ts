import * as SQLite from 'expo-sqlite';
import { RawConnection, SqlParams } from './types';

export async function openExpoConnection(databaseName: string): Promise<RawConnection> {
  const database = await SQLite.openDatabaseAsync(databaseName);
  return {
    exec: (sql: string) => database.execAsync(sql),
    run: async (sql: string, params: SqlParams) => {
      const result = await database.runAsync(sql, params);
      return { lastInsertRowId: result.lastInsertRowId, changes: result.changes };
    },
    all: <T>(sql: string, params: SqlParams) => database.getAllAsync<T>(sql, params),
    first: async <T>(sql: string, params: SqlParams) => {
      const row = await database.getFirstAsync<T>(sql, params);
      return row ?? null;
    },
    close: () => database.closeAsync(),
  };
}
