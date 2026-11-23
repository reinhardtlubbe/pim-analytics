import { Db, RawConnection, RunResult, SqlParams } from './types';

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release: () => void = () => undefined;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => next);
    await previous;
    return release;
  }
}

export interface ManagedDb extends Db {
  close(): Promise<void>;
}

export function createLockedDb(connection: RawConnection): ManagedDb {
  const mutex = new AsyncMutex();
  let savepointCounter = 0;

  const locked = async <T>(work: () => Promise<T>): Promise<T> => {
    const release = await mutex.acquire();
    try {
      return await work();
    } finally {
      release();
    }
  };

  const createScoped = (): Db => {
    const scoped: Db = {
      exec: (sql: string) => connection.exec(sql),
      run: (sql: string, params: SqlParams = []): Promise<RunResult> => connection.run(sql, params),
      all: <T>(sql: string, params: SqlParams = []) => connection.all<T>(sql, params),
      first: <T>(sql: string, params: SqlParams = []) => connection.first<T>(sql, params),
      transaction: async <T>(work: (tx: Db) => Promise<T>): Promise<T> => {
        savepointCounter += 1;
        const name = `sp_${savepointCounter}`;
        await connection.exec(`SAVEPOINT ${name}`);
        try {
          const result = await work(scoped);
          await connection.exec(`RELEASE SAVEPOINT ${name}`);
          return result;
        } catch (error) {
          await connection.exec(`ROLLBACK TO SAVEPOINT ${name}`);
          await connection.exec(`RELEASE SAVEPOINT ${name}`);
          throw error;
        }
      },
    };
    return scoped;
  };

  return {
    exec: (sql: string) => locked(() => connection.exec(sql)),
    run: (sql: string, params: SqlParams = []) => locked(() => connection.run(sql, params)),
    all: <T>(sql: string, params: SqlParams = []) => locked(() => connection.all<T>(sql, params)),
    first: <T>(sql: string, params: SqlParams = []) => locked(() => connection.first<T>(sql, params)),
    transaction: <T>(work: (tx: Db) => Promise<T>) =>
      locked(async () => {
        await connection.exec('BEGIN IMMEDIATE');
        try {
          const result = await work(createScoped());
          await connection.exec('COMMIT');
          return result;
        } catch (error) {
          await connection.exec('ROLLBACK');
          throw error;
        }
      }),
    close: () => locked(() => connection.close()),
  };
}
