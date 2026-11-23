import { APP_CONFIG } from '../../config/appConfig';
import { UserRow } from '../../database/models';
import { Db } from '../../database/types';
import { sha256Hex, toHex } from '../../utils/hashing';
import { recordAuditEvent } from '../audit/auditService';
import { isoNow, ServiceContext } from '../context';
import { ServiceError } from '../errors';
import { hashPassword, validatePasswordStrength, verifyPassword } from './passwordHasher';
import { Actor, isRoleName, requirePermission, RoleName } from './permissions';

export interface LoginResult {
  token: string;
  actor: Actor;
  expiresAt: string;
}

export interface UserSummary {
  userId: number;
  email: string;
  displayName: string;
  roles: RoleName[];
  isActive: boolean;
  isDemoAccount: boolean;
  lastLoginAt: string | null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function loadRoles(db: Db, userId: number): Promise<RoleName[]> {
  const rows = await db.all<{ role_name: string }>(
    `SELECT r.role_name FROM user_roles ur JOIN roles r ON r.role_id = ur.role_id WHERE ur.user_id = ? ORDER BY r.role_id`,
    [userId],
  );
  return rows.map((row) => row.role_name).filter(isRoleName);
}

function toActor(user: UserRow, roles: RoleName[]): Actor {
  return { userId: user.user_id, email: user.email, displayName: user.display_name, roles };
}

export async function login(ctx: ServiceContext, email: string, password: string): Promise<LoginResult> {
  const trimmedEmail = email.trim();
  if (!EMAIL_PATTERN.test(trimmedEmail)) {
    throw new ServiceError('VALIDATION', 'Enter a valid email address.', { field: 'email' });
  }
  if (!password) {
    throw new ServiceError('VALIDATION', 'Enter your password.', { field: 'password' });
  }
  const user = await ctx.db.first<UserRow>('SELECT * FROM users WHERE email = ?', [trimmedEmail]);
  const valid =
    user !== null &&
    user.is_active === 1 &&
    verifyPassword(password, { hash: user.password_hash, salt: user.password_salt, iterations: user.password_iterations });
  if (!user || !valid) {
    if (user) {
      await ctx.db.run('UPDATE users SET failed_login_count = failed_login_count + 1 WHERE user_id = ?', [user.user_id]);
    }
    await recordAuditEvent(
      ctx.db,
      { eventType: 'auth.login_failed', message: 'A sign-in attempt failed.', severity: 'warning', entityType: 'user', entityId: user?.user_id ?? null },
      isoNow(ctx),
    );
    throw new ServiceError('UNAUTHENTICATED', 'The email or password is incorrect.');
  }
  const roles = await loadRoles(ctx.db, user.user_id);
  const token = toHex(ctx.random.bytes(32));
  const now = ctx.clock.now();
  const expiresAt = new Date(now.getTime() + APP_CONFIG.sessionDurationDays * 86400000).toISOString();
  await ctx.db.transaction(async (tx) => {
    await tx.run('INSERT INTO user_sessions (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)', [
      user.user_id,
      sha256Hex(token),
      now.toISOString(),
      expiresAt,
    ]);
    await tx.run('UPDATE users SET last_login_at = ?, failed_login_count = 0 WHERE user_id = ?', [now.toISOString(), user.user_id]);
    await recordAuditEvent(
      tx,
      { eventType: 'auth.login', message: `${user.email} signed in.`, userId: user.user_id, entityType: 'user', entityId: user.user_id },
      now.toISOString(),
    );
  });
  return { token, actor: toActor(user, roles), expiresAt };
}

export async function restoreSession(ctx: ServiceContext, token: string | null): Promise<Actor | null> {
  if (!token) {
    return null;
  }
  const row = await ctx.db.first<UserRow & { expires_at: string; revoked_at: string | null }>(
    `SELECT u.*, s.expires_at, s.revoked_at FROM user_sessions s JOIN users u ON u.user_id = s.user_id WHERE s.token_hash = ?`,
    [sha256Hex(token)],
  );
  if (!row || row.revoked_at || row.is_active !== 1 || row.expires_at <= isoNow(ctx)) {
    return null;
  }
  return toActor(row, await loadRoles(ctx.db, row.user_id));
}

export async function logout(ctx: ServiceContext, token: string | null): Promise<void> {
  if (!token) {
    return;
  }
  const session = await ctx.db.first<{ session_id: number; user_id: number }>(
    'SELECT session_id, user_id FROM user_sessions WHERE token_hash = ? AND revoked_at IS NULL',
    [sha256Hex(token)],
  );
  if (!session) {
    return;
  }
  await ctx.db.run('UPDATE user_sessions SET revoked_at = ? WHERE session_id = ?', [isoNow(ctx), session.session_id]);
  await recordAuditEvent(
    ctx.db,
    { eventType: 'auth.logout', message: 'User signed out.', userId: session.user_id, entityType: 'user', entityId: session.user_id },
    isoNow(ctx),
  );
}

export async function listUsers(ctx: ServiceContext, actor: Actor): Promise<UserSummary[]> {
  requirePermission(actor, 'users.manage');
  const users = await ctx.db.all<UserRow>('SELECT * FROM users ORDER BY email');
  const result: UserSummary[] = [];
  for (const user of users) {
    result.push({
      userId: user.user_id,
      email: user.email,
      displayName: user.display_name,
      roles: await loadRoles(ctx.db, user.user_id),
      isActive: user.is_active === 1,
      isDemoAccount: user.is_demo_account === 1,
      lastLoginAt: user.last_login_at,
    });
  }
  return result;
}

export interface CreateUserInput {
  email: string;
  displayName: string;
  password: string;
  role: RoleName;
}

export async function createUser(ctx: ServiceContext, actor: Actor | null, input: CreateUserInput, options: { isDemo?: boolean; skipPermission?: boolean } = {}): Promise<number> {
  if (!options.skipPermission) {
    requirePermission(actor, 'users.manage');
  }
  const email = input.email.trim();
  if (!EMAIL_PATTERN.test(email)) {
    throw new ServiceError('VALIDATION', 'Enter a valid email address.', { field: 'email' });
  }
  if (!input.displayName.trim()) {
    throw new ServiceError('VALIDATION', 'Enter a display name.', { field: 'displayName' });
  }
  if (!options.isDemo) {
    const strength = validatePasswordStrength(input.password);
    if (strength) {
      throw new ServiceError('VALIDATION', strength, { field: 'password' });
    }
  }
  const existing = await ctx.db.first<{ user_id: number }>('SELECT user_id FROM users WHERE email = ?', [email]);
  if (existing) {
    throw new ServiceError('CONFLICT', 'A user with this email address already exists.');
  }
  const hashed = hashPassword(input.password, ctx.random);
  const now = isoNow(ctx);
  return ctx.db.transaction(async (tx) => {
    const result = await tx.run(
      `INSERT INTO users (email, display_name, password_hash, password_salt, password_iterations, is_demo_account, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [email, input.displayName.trim(), hashed.hash, hashed.salt, hashed.iterations, options.isDemo ? 1 : 0, now, now],
    );
    const userId = result.lastInsertRowId;
    await assignRole(tx, userId, input.role, now);
    await recordAuditEvent(
      tx,
      { eventType: 'user.created', message: `User ${email} created with role ${input.role}.`, userId: actor?.userId ?? null, entityType: 'user', entityId: userId },
      now,
    );
    return userId;
  });
}

async function assignRole(db: Db, userId: number, role: RoleName, now: string): Promise<void> {
  const roleRow = await db.first<{ role_id: number }>('SELECT role_id FROM roles WHERE role_name = ?', [role]);
  if (!roleRow) {
    throw new ServiceError('NOT_FOUND', `Role ${role} does not exist.`);
  }
  await db.run('DELETE FROM user_roles WHERE user_id = ?', [userId]);
  await db.run('INSERT INTO user_roles (user_id, role_id, assigned_at) VALUES (?, ?, ?)', [userId, roleRow.role_id, now]);
}

async function countActiveAdministrators(db: Db, excludingUserId: number): Promise<number> {
  const row = await db.first<{ total: number }>(
    `SELECT COUNT(*) AS total FROM users u JOIN user_roles ur ON ur.user_id = u.user_id JOIN roles r ON r.role_id = ur.role_id
     WHERE r.role_name = 'Administrator' AND u.is_active = 1 AND u.user_id <> ?`,
    [excludingUserId],
  );
  return row?.total ?? 0;
}

export async function updateUser(
  ctx: ServiceContext,
  actor: Actor,
  userId: number,
  changes: { displayName?: string; role?: RoleName; isActive?: boolean; password?: string },
): Promise<void> {
  requirePermission(actor, 'users.manage');
  const user = await ctx.db.first<UserRow>('SELECT * FROM users WHERE user_id = ?', [userId]);
  if (!user) {
    throw new ServiceError('NOT_FOUND', 'User not found.');
  }
  const removingAdmin = (changes.role !== undefined && changes.role !== 'Administrator') || changes.isActive === false;
  if (removingAdmin) {
    const currentRoles = await loadRoles(ctx.db, userId);
    if (currentRoles.includes('Administrator') && (await countActiveAdministrators(ctx.db, userId)) === 0) {
      throw new ServiceError('CONFLICT', 'At least one active administrator must remain.');
    }
  }
  if (changes.password !== undefined) {
    const strength = validatePasswordStrength(changes.password);
    if (strength) {
      throw new ServiceError('VALIDATION', strength, { field: 'password' });
    }
  }
  const now = isoNow(ctx);
  await ctx.db.transaction(async (tx) => {
    if (changes.displayName !== undefined) {
      if (!changes.displayName.trim()) {
        throw new ServiceError('VALIDATION', 'Enter a display name.');
      }
      await tx.run('UPDATE users SET display_name = ?, updated_at = ? WHERE user_id = ?', [changes.displayName.trim(), now, userId]);
    }
    if (changes.isActive !== undefined) {
      await tx.run('UPDATE users SET is_active = ?, updated_at = ? WHERE user_id = ?', [changes.isActive ? 1 : 0, now, userId]);
      if (!changes.isActive) {
        await tx.run('UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [now, userId]);
      }
    }
    if (changes.role !== undefined) {
      await assignRole(tx, userId, changes.role, now);
    }
    if (changes.password !== undefined) {
      const hashed = hashPassword(changes.password, ctx.random);
      await tx.run('UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?, updated_at = ? WHERE user_id = ?', [
        hashed.hash,
        hashed.salt,
        hashed.iterations,
        now,
        userId,
      ]);
    }
    await recordAuditEvent(
      tx,
      { eventType: 'user.updated', message: `User ${user.email} updated.`, userId: actor.userId, entityType: 'user', entityId: userId },
      now,
    );
  });
}

export async function deleteUser(ctx: ServiceContext, actor: Actor, userId: number): Promise<void> {
  requirePermission(actor, 'users.manage');
  if (userId === actor.userId) {
    throw new ServiceError('CONFLICT', 'You cannot delete your own account.');
  }
  const user = await ctx.db.first<UserRow>('SELECT * FROM users WHERE user_id = ?', [userId]);
  if (!user) {
    throw new ServiceError('NOT_FOUND', 'User not found.');
  }
  const roles = await loadRoles(ctx.db, userId);
  if (roles.includes('Administrator') && (await countActiveAdministrators(ctx.db, userId)) === 0) {
    throw new ServiceError('CONFLICT', 'At least one active administrator must remain.');
  }
  const now = isoNow(ctx);
  await ctx.db.transaction(async (tx) => {
    await tx.run('DELETE FROM users WHERE user_id = ?', [userId]);
    await recordAuditEvent(
      tx,
      { eventType: 'user.deleted', message: `User ${user.email} deleted.`, userId: actor.userId, entityType: 'user', entityId: userId },
      now,
    );
  });
}
