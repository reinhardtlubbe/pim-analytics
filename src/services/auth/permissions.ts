import { ServiceError } from '../errors';

export type RoleName = 'Administrator' | 'Analyst' | 'Viewer';

export const ROLE_DEFINITIONS: { name: RoleName; description: string }[] = [
  { name: 'Administrator', description: 'Manage users, accounts, mappings and system configuration.' },
  { name: 'Analyst', description: 'Upload and process files, manage mappings, view results, export reports and forecast.' },
  { name: 'Viewer', description: 'View permitted reports and scenarios without modifying data.' },
];

export type Permission =
  | 'users.manage'
  | 'reference.manage'
  | 'currency.manage'
  | 'files.upload'
  | 'files.process'
  | 'mappings.manage'
  | 'quarantine.review'
  | 'results.view'
  | 'reports.export'
  | 'forecast.use'
  | 'scenarios.manage'
  | 'scenarios.view'
  | 'logs.view';

const ANALYST_PERMISSIONS: Permission[] = [
  'files.upload',
  'files.process',
  'mappings.manage',
  'quarantine.review',
  'results.view',
  'reports.export',
  'forecast.use',
  'scenarios.manage',
  'scenarios.view',
  'logs.view',
  'currency.manage',
];

export const ROLE_PERMISSIONS: Record<RoleName, Permission[]> = {
  Administrator: [...ANALYST_PERMISSIONS, 'users.manage', 'reference.manage'],
  Analyst: ANALYST_PERMISSIONS,
  Viewer: ['results.view', 'scenarios.view', 'forecast.use'],
};

export interface Actor {
  userId: number;
  email: string;
  displayName: string;
  roles: RoleName[];
}

export function hasPermission(actor: Actor | null | undefined, permission: Permission): boolean {
  if (!actor) {
    return false;
  }
  return actor.roles.some((role) => ROLE_PERMISSIONS[role]?.includes(permission));
}

export function requirePermission(actor: Actor | null | undefined, permission: Permission): asserts actor is Actor {
  if (!actor) {
    throw new ServiceError('UNAUTHENTICATED', 'Sign in to continue.');
  }
  if (!hasPermission(actor, permission)) {
    throw new ServiceError('FORBIDDEN', `Your role does not allow this action (${permission}).`);
  }
}

export function isRoleName(value: string): value is RoleName {
  return value === 'Administrator' || value === 'Analyst' || value === 'Viewer';
}
