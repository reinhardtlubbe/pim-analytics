import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { APP_CONFIG } from '../config/appConfig';
import { openExpoConnection } from '../database/expoConnection';
import { initializeDatabase, InitializationResult } from '../database/initialize';
import { createLockedDb } from '../database/lockedDb';
import { expoFileStore, expoRandom, sessionTokenStore } from '../platform/expoPlatform';
import { login, logout, restoreSession } from '../services/auth/authService';
import { Actor, hasPermission, Permission } from '../services/auth/permissions';
import { ServiceContext, systemClock } from '../services/context';
import { toStructuredError } from '../services/errors';

type AppStatus = 'initializing' | 'ready' | 'error';

interface AppState {
  status: AppStatus;
  services: ServiceContext | null;
  actor: Actor | null;
  initialization: InitializationResult | null;
  initError: string | null;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  can(permission: Permission): boolean;
  retryInitialization(): void;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AppStatus>('initializing');
  const [services, setServices] = useState<ServiceContext | null>(null);
  const [actor, setActor] = useState<Actor | null>(null);
  const [initialization, setInitialization] = useState<InitializationResult | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setStatus('initializing');
        const connection = await openExpoConnection(APP_CONFIG.databaseName);
        const context: ServiceContext = { db: createLockedDb(connection), clock: systemClock, random: expoRandom, files: expoFileStore };
        await context.db.exec('PRAGMA journal_mode = WAL');
        const result = await initializeDatabase(context);
        const token = await sessionTokenStore.get();
        const restored = await restoreSession(context, token);
        if (!restored && token) {
          await sessionTokenStore.clear();
        }
        if (!cancelled) {
          setServices(context);
          setInitialization(result);
          setActor(restored);
          setStatus('ready');
        }
      } catch (error) {
        if (!cancelled) {
          setInitError(toStructuredError(error).message);
          setStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      if (!services) {
        throw new Error('The database is not ready yet.');
      }
      const result = await login(services, email, password);
      await sessionTokenStore.set(result.token);
      setActor(result.actor);
    },
    [services],
  );

  const signOut = useCallback(async () => {
    if (services) {
      const token = await sessionTokenStore.get();
      await logout(services, token);
    }
    await sessionTokenStore.clear();
    setActor(null);
  }, [services]);

  const value = useMemo<AppState>(
    () => ({
      status,
      services,
      actor,
      initialization,
      initError,
      signIn,
      signOut,
      can: (permission: Permission) => hasPermission(actor, permission),
      retryInitialization: () => setAttempt((current) => current + 1),
    }),
    [status, services, actor, initialization, initError, signIn, signOut],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const value = useContext(AppContext);
  if (!value) {
    throw new Error('useApp must be used inside AppProvider');
  }
  return value;
}

export function useServices(): { services: ServiceContext; actor: Actor } {
  const { services, actor } = useApp();
  if (!services || !actor) {
    throw new Error('A signed-in session is required.');
  }
  return { services, actor };
}
