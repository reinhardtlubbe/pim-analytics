import { createUser, deleteUser, listUsers, login, logout, restoreSession, updateUser } from '../src/services/auth/authService';
import { hasPermission } from '../src/services/auth/permissions';
import { saveClient } from '../src/services/reference/referenceService';
import { adminActor, analystActor, createInitializedContext, TestContext, viewerActor } from './helpers/testContext';

describe('authentication and roles', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createInitializedContext();
  });

  afterEach(async () => {
    await ctx.db.close();
  });

  it('signs in with the evaluation administrator and restores the session', async () => {
    const result = await login(ctx, 'admin@planitmedia.com', 'PlanIt2026!');
    expect(result.actor.roles).toEqual(['Administrator']);
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    const stored = await ctx.db.first<{ token_hash: string }>('SELECT token_hash FROM user_sessions');
    expect(stored!.token_hash).not.toBe(result.token);
    const restored = await restoreSession(ctx, result.token);
    expect(restored?.email).toBe('admin@planitmedia.com');
  });

  it('rejects invalid credentials without revealing which part was wrong', async () => {
    await expect(login(ctx, 'admin@planitmedia.com', 'wrong-password')).rejects.toMatchObject({ code: 'UNAUTHENTICATED', message: 'The email or password is incorrect.' });
    await expect(login(ctx, 'nobody@planitmedia.com', 'PlanIt2026!')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(login(ctx, 'not-an-email', 'x')).rejects.toMatchObject({ code: 'VALIDATION' });
    const logs = await ctx.db.all<{ message: string }>("SELECT message FROM processing_logs WHERE event_type = 'auth.login_failed'");
    expect(logs).toHaveLength(2);
    expect(logs.every((log) => !log.message.includes('wrong-password'))).toBe(true);
  });

  it('logs out by revoking the session', async () => {
    const { token } = await login(ctx, 'admin@planitmedia.com', 'PlanIt2026!');
    await logout(ctx, token);
    expect(await restoreSession(ctx, token)).toBeNull();
  });

  it('expires sessions', async () => {
    const { token } = await login(ctx, 'admin@planitmedia.com', 'PlanIt2026!');
    ctx.setNow('2026-12-31T00:00:00.000Z');
    expect(await restoreSession(ctx, token)).toBeNull();
  });

  it('applies role permissions consistently', () => {
    expect(hasPermission(adminActor, 'users.manage')).toBe(true);
    expect(hasPermission(analystActor, 'users.manage')).toBe(false);
    expect(hasPermission(analystActor, 'files.upload')).toBe(true);
    expect(hasPermission(viewerActor, 'files.upload')).toBe(false);
    expect(hasPermission(viewerActor, 'mappings.manage')).toBe(false);
    expect(hasPermission(viewerActor, 'results.view')).toBe(true);
    expect(hasPermission(null, 'results.view')).toBe(false);
  });

  it('lets administrators manage users and stops others', async () => {
    const userId = await createUser(ctx, adminActor, { email: 'analyst@planitmedia.com', displayName: 'Analyst', password: 'Analyst2026', role: 'Analyst' });
    await expect(createUser(ctx, analystActor, { email: 'x@planitmedia.com', displayName: 'X', password: 'Password1', role: 'Viewer' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(createUser(ctx, adminActor, { email: 'weak@planitmedia.com', displayName: 'Weak', password: 'weak', role: 'Viewer' })).rejects.toMatchObject({ code: 'VALIDATION' });
    const analyst = await login(ctx, 'analyst@planitmedia.com', 'Analyst2026');
    expect(analyst.actor.roles).toEqual(['Analyst']);
    await expect(saveClient(ctx, analyst.actor, { clientName: 'Not allowed' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await updateUser(ctx, adminActor, userId, { role: 'Viewer' });
    expect((await listUsers(ctx, adminActor)).find((user) => user.userId === userId)?.roles).toEqual(['Viewer']);
    await updateUser(ctx, adminActor, userId, { isActive: false });
    expect(await restoreSession(ctx, analyst.token)).toBeNull();
    await deleteUser(ctx, adminActor, userId);
    expect(await listUsers(ctx, adminActor)).toHaveLength(1);
  });

  it('keeps at least one active administrator', async () => {
    const admin = await ctx.db.first<{ user_id: number }>('SELECT user_id FROM users');
    const otherAdmin = { ...adminActor, userId: 999 };
    await expect(updateUser(ctx, otherAdmin, admin!.user_id, { role: 'Viewer' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(deleteUser(ctx, otherAdmin, admin!.user_id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
