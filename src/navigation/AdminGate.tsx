import { ReactNode } from 'react';
import { Screen } from '../components/Screen';
import { EmptyState } from '../components/ui';
import { Permission } from '../services/auth/permissions';
import { useApp } from '../state/AppProvider';

export function AdminGate({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { can } = useApp();
  if (!can(permission)) {
    return (
      <Screen>
        <EmptyState icon="lock-closed" title="Restricted" message="Your role does not have access to this area." />
      </Screen>
    );
  }
  return <>{children}</>;
}
