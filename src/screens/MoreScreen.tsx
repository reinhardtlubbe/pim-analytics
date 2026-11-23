import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Screen } from '../components/Screen';
import { AppButton, GlassCard, KeyValue, SectionTitle } from '../components/ui';
import { RootStackParamList } from '../navigation/types';
import { Permission } from '../services/auth/permissions';
import { useApp } from '../state/AppProvider';
import { colors, spacing, typography } from '../ui/theme';

type Destination = { route: keyof RootStackParamList; label: string; description: string; icon: keyof typeof Ionicons.glyphMap; permission: Permission };

const DESTINATIONS: Destination[] = [
  { route: 'History', label: 'Processing history', description: 'Uploads, runs, reconciliation and reprocessing', icon: 'time', permission: 'results.view' },
  { route: 'Quarantine', label: 'Validation & quarantine', description: 'Review, correct or dismiss rejected rows', icon: 'shield', permission: 'results.view' },
  { route: 'Logs', label: 'Audit log', description: 'Every significant processing and data event', icon: 'list', permission: 'logs.view' },
  { route: 'Profiles', label: 'Mapping profiles', description: 'Create, edit and delete reusable mappings', icon: 'git-compare', permission: 'results.view' },
  { route: 'Scenarios', label: 'Saved forecast scenarios', description: 'Open, compare and delete scenarios', icon: 'calculator', permission: 'scenarios.view' },
  { route: 'CurrencyRates', label: 'Currency rates', description: 'Dated conversion rates to ZAR', icon: 'swap-horizontal', permission: 'currency.manage' },
  { route: 'ClientsAccounts', label: 'Clients & accounts', description: 'Manage clients and advertising accounts', icon: 'business', permission: 'reference.manage' },
  { route: 'Users', label: 'Users & roles', description: 'Administrator, Analyst and Viewer access', icon: 'people', permission: 'users.manage' },
];

export function MoreScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { actor, can, signOut, initialization } = useApp();

  const confirmSignOut = () =>
    Alert.alert('Sign out', 'End this session on this device?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => signOut() },
    ]);

  return (
    <Screen>
      <GlassCard>
        <SectionTitle title={actor?.displayName ?? ''} subtitle={actor?.email} />
        <KeyValue label="Role" value={actor?.roles.join(', ') ?? ''} />
        <KeyValue label="Database schema" value={`v${initialization?.schemaVersion ?? '?'}`} />
        <AppButton label="Sign out" variant="danger" icon="log-out" onPress={confirmSignOut} />
      </GlassCard>
      {DESTINATIONS.filter((item) => can(item.permission)).map((item) => (
        <Pressable key={item.route} onPress={() => navigation.navigate(item.route as never)} accessibilityRole="button" accessibilityLabel={item.label}>
          <GlassCard style={styles.item}>
            <View style={styles.icon}>
              <Ionicons name={item.icon} size={20} color={colors.primary} />
            </View>
            <View style={styles.flex}>
              <Text style={typography.subheading}>{item.label}</Text>
              <Text style={typography.caption}>{item.description}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
          </GlassCard>
        </Pressable>
      ))}
      <Text style={[typography.caption, styles.footnote]}>
        Data is stored in a private SQLite database on this device. Authentication is local to this device and intended for evaluation; a shared multi-user deployment
        needs a server-side identity provider and access control.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  item: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  icon: { width: 40, height: 40, borderRadius: 12, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  footnote: { textAlign: 'center', marginTop: spacing.md },
});
