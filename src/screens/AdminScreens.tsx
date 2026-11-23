import { useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { Screen } from '../components/Screen';
import { AppButton, Banner, GlassCard, KeyValue, SectionTitle, SelectField, StatusBadge, TextField } from '../components/ui';
import { AccountView, ClientRow, SupplierRow } from '../database/models';
import { createUser, deleteUser, listUsers, updateUser, UserSummary } from '../services/auth/authService';
import { RoleName } from '../services/auth/permissions';
import { toStructuredError } from '../services/errors';
import {
  deleteAccount,
  deleteClient,
  deleteCurrencyRate,
  listAccounts,
  listClients,
  listCurrencyRates,
  listSuppliers,
  saveAccount,
  saveClient,
  saveCurrencyRate,
} from '../services/reference/referenceService';
import { useServices } from '../state/AppProvider';
import { useAsyncData } from '../state/useAsyncData';
import { formatDateTime } from '../ui/format';
import { spacing, typography } from '../ui/theme';

function confirmDelete(title: string, message: string, action: () => Promise<void>) {
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => action() },
  ]);
}

export function ClientsAccountsScreen() {
  const { services, actor } = useServices();
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [clientName, setClientName] = useState('');
  const [editingClient, setEditingClient] = useState<ClientRow | null>(null);
  const [accountForm, setAccountForm] = useState<{ accountId?: number; clientId: number | null; supplierId: number | null; accountName: string; externalAccountId: string }>({
    clientId: null,
    supplierId: null,
    accountName: '',
    externalAccountId: '',
  });
  const { data, reload, loading } = useAsyncData(async () => {
    const [clients, accounts, suppliers] = await Promise.all([listClients(services), listAccounts(services), listSuppliers(services)]);
    return { clients, accounts, suppliers };
  }, [services]);

  const run = async (work: () => Promise<unknown>, success: string) => {
    setMessage(null);
    try {
      await work();
      setMessage({ tone: 'success', text: success });
      await reload();
    } catch (caught) {
      setMessage({ tone: 'danger', text: toStructuredError(caught).message });
    }
  };

  const editAccount = (account: AccountView) =>
    setAccountForm({ accountId: account.account_id, clientId: account.client_id, supplierId: account.supplier_id, accountName: account.account_name, externalAccountId: account.external_account_id });

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      {message ? <Banner tone={message.tone} message={message.text} /> : null}
      <GlassCard>
        <SectionTitle title={editingClient ? 'Edit client' : 'Add client'} />
        <TextField label="Client name" value={clientName} onChangeText={setClientName} />
        <View style={styles.row}>
          <AppButton
            label={editingClient ? 'Save client' : 'Add client'}
            icon="save"
            disabled={!clientName.trim()}
            style={styles.flex}
            onPress={() =>
              run(async () => {
                await saveClient(services, actor, { clientId: editingClient?.client_id, clientName });
                setClientName('');
                setEditingClient(null);
              }, 'Client saved.')
            }
          />
          {editingClient ? <AppButton label="Cancel" variant="secondary" onPress={() => { setEditingClient(null); setClientName(''); }} /> : null}
        </View>
      </GlassCard>

      {data?.clients.map((client) => (
        <GlassCard key={client.client_id}>
          <Text style={typography.subheading}>{client.client_name}</Text>
          {data.accounts
            .filter((account) => account.client_id === client.client_id)
            .map((account) => (
              <View key={account.account_id} style={styles.accountRow}>
                <StatusBadge label={account.supplier_name} tone="info" />
                <Text style={[typography.body, styles.flex]} numberOfLines={1}>
                  {account.account_name} ({account.external_account_id})
                </Text>
                <AppButton label="Edit" compact variant="ghost" onPress={() => editAccount(account)} />
                <AppButton
                  label="Delete"
                  compact
                  variant="ghost"
                  onPress={() => confirmDelete('Delete account', `Delete ${account.account_name}?`, () => run(() => deleteAccount(services, actor, account.account_id), 'Account deleted.'))}
                />
              </View>
            ))}
          <View style={styles.row}>
            <AppButton label="Rename" compact variant="secondary" style={styles.flex} onPress={() => { setEditingClient(client); setClientName(client.client_name); }} />
            <AppButton
              label="Delete"
              compact
              variant="danger"
              style={styles.flex}
              onPress={() => confirmDelete('Delete client', `Delete ${client.client_name}?`, () => run(() => deleteClient(services, actor, client.client_id), 'Client deleted.'))}
            />
          </View>
        </GlassCard>
      ))}

      <GlassCard>
        <SectionTitle title={accountForm.accountId ? 'Edit advertising account' : 'Add advertising account'} />
        <SelectField
          label="Client"
          value={accountForm.clientId}
          options={(data?.clients ?? []).map((client) => ({ value: client.client_id, label: client.client_name }))}
          onChange={(value) => setAccountForm((current) => ({ ...current, clientId: value }))}
        />
        <SelectField
          label="Supplier"
          value={accountForm.supplierId}
          options={(data?.suppliers ?? []).map((supplier: SupplierRow) => ({ value: supplier.supplier_id, label: supplier.supplier_name }))}
          onChange={(value) => setAccountForm((current) => ({ ...current, supplierId: value }))}
        />
        <TextField label="Account name" value={accountForm.accountName} onChangeText={(text) => setAccountForm((current) => ({ ...current, accountName: text }))} />
        <TextField
          label="Supplier account ID"
          value={accountForm.externalAccountId}
          onChangeText={(text) => setAccountForm((current) => ({ ...current, externalAccountId: text }))}
          autoCapitalize="characters"
        />
        <AppButton
          label="Save account"
          icon="save"
          disabled={!accountForm.clientId || !accountForm.supplierId}
          onPress={() =>
            run(async () => {
              await saveAccount(services, actor, {
                accountId: accountForm.accountId,
                clientId: accountForm.clientId as number,
                supplierId: accountForm.supplierId as number,
                accountName: accountForm.accountName,
                externalAccountId: accountForm.externalAccountId,
              });
              setAccountForm({ clientId: null, supplierId: null, accountName: '', externalAccountId: '' });
            }, 'Advertising account saved.')
          }
        />
      </GlassCard>
    </Screen>
  );
}

const ROLE_OPTIONS = (['Administrator', 'Analyst', 'Viewer'] as RoleName[]).map((role) => ({ value: role, label: role }));

export function UsersScreen() {
  const { services, actor } = useServices();
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [form, setForm] = useState({ email: '', displayName: '', password: '', role: 'Analyst' as RoleName });
  const { data, reload, loading } = useAsyncData(() => listUsers(services, actor), [services, actor]);

  const run = async (work: () => Promise<unknown>, success: string) => {
    setMessage(null);
    try {
      await work();
      setMessage({ tone: 'success', text: success });
      await reload();
    } catch (caught) {
      setMessage({ tone: 'danger', text: toStructuredError(caught).message });
    }
  };

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      {message ? <Banner tone={message.tone} message={message.text} /> : null}
      {data?.map((user: UserSummary) => (
        <GlassCard key={user.userId}>
          <View style={styles.row}>
            <Text style={[typography.subheading, styles.flex]}>{user.displayName}</Text>
            <StatusBadge label={user.isActive ? 'Active' : 'Disabled'} tone={user.isActive ? 'success' : 'muted'} />
            {user.isDemoAccount ? <StatusBadge label="Evaluation" tone="warning" /> : null}
          </View>
          <Text style={typography.caption}>{user.email}</Text>
          <KeyValue label="Last sign-in" value={formatDateTime(user.lastLoginAt)} />
          {user.userId !== actor.userId ? (
            <SelectField label="Role" value={user.roles[0] ?? null} options={ROLE_OPTIONS} onChange={(role) => run(() => updateUser(services, actor, user.userId, { role }), 'Role updated.')} />
          ) : (
            <KeyValue label="Role" value={`${user.roles.join(', ')} (your own role can be changed by another administrator)`} />
          )}
          {user.userId !== actor.userId ? (
            <View style={styles.row}>
              <AppButton
                label={user.isActive ? 'Disable' : 'Enable'}
                compact
                variant="secondary"
                style={styles.flex}
                onPress={() => run(() => updateUser(services, actor, user.userId, { isActive: !user.isActive }), user.isActive ? 'User disabled.' : 'User enabled.')}
              />
              <AppButton
                label="Delete"
                compact
                variant="danger"
                style={styles.flex}
                onPress={() => confirmDelete('Delete user', `Delete ${user.email}?`, () => run(() => deleteUser(services, actor, user.userId), 'User deleted.'))}
              />
            </View>
          ) : null}
        </GlassCard>
      ))}
      <GlassCard>
        <SectionTitle title="Add user" subtitle="Passwords are stored as salted PBKDF2 hashes" />
        <TextField label="Email" value={form.email} onChangeText={(email) => setForm((current) => ({ ...current, email }))} autoCapitalize="none" keyboardType="email-address" />
        <TextField label="Display name" value={form.displayName} onChangeText={(displayName) => setForm((current) => ({ ...current, displayName }))} />
        <TextField label="Temporary password" value={form.password} onChangeText={(password) => setForm((current) => ({ ...current, password }))} secureTextEntry hint="At least 8 characters with upper, lower case and a number" />
        <SelectField label="Role" value={form.role} options={ROLE_OPTIONS} onChange={(role) => setForm((current) => ({ ...current, role }))} />
        <AppButton
          label="Create user"
          icon="person-add"
          onPress={() =>
            run(async () => {
              await createUser(services, actor, form);
              setForm({ email: '', displayName: '', password: '', role: 'Analyst' });
            }, 'User created.')
          }
        />
      </GlassCard>
    </Screen>
  );
}

export function CurrencyRatesScreen() {
  const { services, actor } = useServices();
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [form, setForm] = useState({ currencyCode: 'USD', rate: '', rateDate: '', source: '' });
  const { data, reload, loading } = useAsyncData(() => listCurrencyRates(services), [services]);

  useEffect(() => {
    setForm((current) => ({ ...current, rateDate: current.rateDate || new Date().toISOString().slice(0, 10) }));
  }, []);

  const run = async (work: () => Promise<unknown>, success: string) => {
    setMessage(null);
    try {
      await work();
      setMessage({ tone: 'success', text: success });
      await reload();
    } catch (caught) {
      setMessage({ tone: 'danger', text: toStructuredError(caught).message });
    }
  };

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <Banner tone="info" message="Non-ZAR spend is converted with the latest rate dated on or before the end of the reporting month. Without a rate, records keep their original currency and are excluded from ZAR forecasting. Reprocess affected files after adding rates." />
      {message ? <Banner tone={message.tone} message={message.text} /> : null}
      <GlassCard>
        <SectionTitle title="Add conversion rate" />
        <View style={styles.row}>
          <View style={styles.flex}>
            <TextField label="Currency" value={form.currencyCode} onChangeText={(currencyCode) => setForm((current) => ({ ...current, currencyCode }))} autoCapitalize="characters" maxLength={3} />
          </View>
          <View style={styles.flex}>
            <TextField label="ZAR per unit" value={form.rate} onChangeText={(rate) => setForm((current) => ({ ...current, rate }))} keyboardType="decimal-pad" />
          </View>
        </View>
        <TextField label="Rate date (YYYY-MM-DD)" value={form.rateDate} onChangeText={(rateDate) => setForm((current) => ({ ...current, rateDate }))} />
        <TextField label="Source" value={form.source} onChangeText={(source) => setForm((current) => ({ ...current, source }))} placeholder="e.g. SARB month-end rate" />
        <AppButton
          label="Save rate"
          icon="save"
          onPress={() =>
            run(
              () => saveCurrencyRate(services, actor, { currencyCode: form.currencyCode, rateToZar: Number(form.rate), rateDate: form.rateDate, source: form.source }),
              'Conversion rate saved.',
            )
          }
        />
      </GlassCard>
      {data?.map((rate) => (
        <GlassCard key={rate.rate_id}>
          <View style={styles.row}>
            <Text style={[typography.subheading, styles.flex]}>
              {rate.currency_code} → ZAR {rate.rate_to_zar}
            </Text>
            <AppButton label="Delete" compact variant="ghost" onPress={() => confirmDelete('Delete rate', `Delete the ${rate.currency_code} rate dated ${rate.rate_date}?`, () => run(() => deleteCurrencyRate(services, actor, rate.rate_id), 'Rate deleted.'))} />
          </View>
          <Text style={typography.caption}>
            {rate.rate_date} · {rate.source}
          </Text>
        </GlassCard>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  accountRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
});
