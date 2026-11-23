import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import * as Sharing from 'expo-sharing';
import { encodeUtf8 } from '../services/ingestion/textDecoding';
import { FileStore, RandomSource } from '../services/context';

const SESSION_KEY = 'planit_session_token';

function ensureDirectory(name: string): Directory {
  const directory = new Directory(Paths.document, name);
  if (!directory.exists) {
    directory.create({ intermediates: true, idempotent: true });
  }
  return directory;
}

export const expoFileStore: FileStore = {
  async saveImport(storedFilename: string, bytes: Uint8Array): Promise<string> {
    const file = new File(ensureDirectory('imports'), storedFilename);
    if (file.exists) {
      file.delete();
    }
    file.create();
    await file.write(bytes);
    return file.uri;
  },
  async readImport(storedUri: string): Promise<Uint8Array> {
    const file = new File(storedUri);
    if (!file.exists) {
      throw new Error('The stored copy of this upload is missing from app storage.');
    }
    return file.bytes();
  },
  async writeExport(filename: string, content: string | Uint8Array): Promise<string> {
    const file = new File(ensureDirectory('exports'), filename);
    if (file.exists) {
      file.delete();
    }
    file.create();
    await file.write(typeof content === 'string' ? encodeUtf8(content) : content);
    return file.uri;
  },
};

export const expoRandom: RandomSource = {
  bytes: (length: number) => Crypto.getRandomBytes(length),
};

// Read the file picked by the document picker using native fetch to reliably access local file:// URIs on Android.
// Then convert the array buffer into a Uint8Array for spreadsheet/CSV parsing.
export async function readPickedFile(uri: string): Promise<Uint8Array> {
  if (!uri) {
    throw new Error('The selected file URI is missing or invalid.');
  }
  try {
    const response = await fetch(uri);
    const arrayBuffer = await response.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    return uint8Array;
  } catch (caught) {
    throw new Error(`Failed to read picked file: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
}

export const sessionTokenStore = {
  get: () => SecureStore.getItemAsync(SESSION_KEY),
  set: (token: string) => SecureStore.setItemAsync(SESSION_KEY, token),
  clear: () => SecureStore.deleteItemAsync(SESSION_KEY),
};

export async function shareExportedFile(uri: string, mimeType: string, title: string): Promise<boolean> {
  if (!(await Sharing.isAvailableAsync())) {
    return false;
  }
  await Sharing.shareAsync(uri, { mimeType, dialogTitle: title, UTI: mimeType.includes('csv') ? 'public.comma-separated-values-text' : 'org.openxmlformats.spreadsheetml.sheet' });
  return true;
}
