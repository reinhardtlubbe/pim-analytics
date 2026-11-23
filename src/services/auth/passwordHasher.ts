import { APP_CONFIG } from '../../config/appConfig';
import { constantTimeEqual, pbkdf2Hex, toHex } from '../../utils/hashing';
import { RandomSource } from '../context';

export interface PasswordHash {
  hash: string;
  salt: string;
  iterations: number;
}

export function hashPassword(password: string, random: RandomSource, iterations = APP_CONFIG.passwordIterations): PasswordHash {
  const salt = toHex(random.bytes(16));
  return { hash: pbkdf2Hex(password, salt, iterations), salt, iterations };
}

export function verifyPassword(password: string, stored: PasswordHash): boolean {
  const candidate = pbkdf2Hex(password, stored.salt, stored.iterations);
  return constantTimeEqual(candidate, stored.hash);
}

export function validatePasswordStrength(password: string): string | null {
  if (password.length < 8) {
    return 'Password must be at least 8 characters long.';
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must include upper-case, lower-case and numeric characters.';
  }
  return null;
}
