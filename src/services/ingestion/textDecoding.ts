const WINDOWS_1252_EXTRAS: Record<number, number> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178,
};

export type DetectedEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

function pushCodePoint(parts: string[], buffer: number[], codePoint: number): void {
  if (codePoint > 0xffff) {
    const offset = codePoint - 0x10000;
    buffer.push(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
  } else {
    buffer.push(codePoint);
  }
  if (buffer.length >= 8192) {
    parts.push(String.fromCharCode(...buffer));
    buffer.length = 0;
  }
}

function decodeUtf8Strict(bytes: Uint8Array, start: number): string | null {
  const parts: string[] = [];
  const buffer: number[] = [];
  let index = start;
  while (index < bytes.length) {
    const byte = bytes[index];
    if (byte < 0x80) {
      pushCodePoint(parts, buffer, byte);
      index += 1;
      continue;
    }
    let needed = 0;
    let codePoint = 0;
    let minimum = 0;
    if (byte >= 0xc2 && byte <= 0xdf) {
      needed = 1;
      codePoint = byte & 0x1f;
      minimum = 0x80;
    } else if (byte >= 0xe0 && byte <= 0xef) {
      needed = 2;
      codePoint = byte & 0x0f;
      minimum = 0x800;
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      needed = 3;
      codePoint = byte & 0x07;
      minimum = 0x10000;
    } else {
      return null;
    }
    if (index + needed >= bytes.length) {
      return null;
    }
    for (let offset = 1; offset <= needed; offset += 1) {
      const next = bytes[index + offset];
      if ((next & 0xc0) !== 0x80) {
        return null;
      }
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    if (codePoint < minimum || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return null;
    }
    pushCodePoint(parts, buffer, codePoint);
    index += needed + 1;
  }
  parts.push(String.fromCharCode(...buffer));
  return parts.join('');
}

function decodeUtf16(bytes: Uint8Array, start: number, littleEndian: boolean): string {
  const parts: string[] = [];
  const buffer: number[] = [];
  for (let index = start; index + 1 < bytes.length; index += 2) {
    buffer.push(littleEndian ? bytes[index] | (bytes[index + 1] << 8) : (bytes[index] << 8) | bytes[index + 1]);
    if (buffer.length >= 8192) {
      parts.push(String.fromCharCode(...buffer));
      buffer.length = 0;
    }
  }
  parts.push(String.fromCharCode(...buffer));
  return parts.join('');
}

function decodeWindows1252(bytes: Uint8Array): string {
  const parts: string[] = [];
  const buffer: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    buffer.push(WINDOWS_1252_EXTRAS[byte] ?? byte);
    if (buffer.length >= 8192) {
      parts.push(String.fromCharCode(...buffer));
      buffer.length = 0;
    }
  }
  parts.push(String.fromCharCode(...buffer));
  return parts.join('');
}

export function decodeText(bytes: Uint8Array): { text: string; encoding: DetectedEncoding } {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: decodeUtf16(bytes, 2, true), encoding: 'utf-16le' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decodeUtf16(bytes, 2, false), encoding: 'utf-16be' };
  }
  const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const utf8 = decodeUtf8Strict(bytes, start);
  if (utf8 !== null) {
    return { text: utf8, encoding: 'utf-8' };
  }
  return { text: decodeWindows1252(bytes), encoding: 'windows-1252' };
}

export function encodeUtf8(text: string): Uint8Array {
  const output: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    let codePoint = text.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
        index += 1;
      }
    }
    if (codePoint < 0x80) {
      output.push(codePoint);
    } else if (codePoint < 0x800) {
      output.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      output.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      output.push(0xf0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3f), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    }
  }
  return Uint8Array.from(output);
}
