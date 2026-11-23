import { Db } from '../database/types';

export interface Clock {
  now(): Date;
}

export interface RandomSource {
  bytes(length: number): Uint8Array;
}

export interface FileStore {
  saveImport(storedFilename: string, bytes: Uint8Array): Promise<string>;
  readImport(storedUri: string): Promise<Uint8Array>;
  writeExport(filename: string, content: string | Uint8Array): Promise<string>;
}

export interface ServiceContext {
  db: Db;
  clock: Clock;
  random: RandomSource;
  files: FileStore;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function isoNow(ctx: { clock: Clock }): string {
  return ctx.clock.now().toISOString();
}
