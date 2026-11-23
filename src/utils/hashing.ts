import { sha256 } from '@noble/hashes/sha256';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

export function sha256Hex(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? utf8ToBytes(input) : input;
  return bytesToHex(sha256(bytes));
}

export function pbkdf2Hex(password: string, saltHex: string, iterations: number): string {
  return bytesToHex(pbkdf2(sha256, utf8ToBytes(password), hexToBytes(saltHex), { c: iterations, dkLen: 32 }));
}

export function toHex(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}
