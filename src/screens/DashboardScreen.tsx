import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Screen } from '../components/Screen';
import { AppButton, Banner, EmptyState, GlassCard, SectionTitle, StatTile } from '../components/ui';
import { RunStatusBadge } from '../components/RunStatusBadge';
import { RootStackParamList } from '../navigation/types';
import { getDashboardStats, getProcessingHistory } from '../services/reporting/historyService';
import { useApp, useServices } from '../state/AppProvider';
import { useAsyncData } from '../state/useAsyncData';
import { formatDateTime, formatInteger, formatZar } from '../ui/format';
import { colors, spacing, typography } from '../ui/theme';

const WORKFLOW = [
  { icon: 'cloud-upload' as const, label: 'Upload' },
  { icon: 'git-compare' as const, label: 'Map' },
  { icon: 'shield-checkmark' as const, label: 'Confirm' },
  { icon: 'cog' as const, label: 'Process' },
  { icon: 'stats-chart' as const, label: 'Results' },
];

export function DashboardScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { services } = useServices();
  const { actor, can } = useApp();
  const { data, loading, error, reload } = useAsyncData(async () => {
    const [stats, runs] = await Promise.all([getDashboardStats(services), getProcessingHistory(services, { limit: 5 })]);
    return { stats, runs };
  }, [services]);

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <View>
        <Text style={typography.caption}>Welcome back</Text>
        <Text style={typography.title}>{actor?.displayName}</Text>
        <Text style={typography.caption}>{actor?.roles.join(', ')}</Text>
      </View>

      {error ? <Banner tone="danger" message={error} /> : null}

      <View style={styles.grid}>
        <StatTile label="Uploaded files" value={formatInteger(data?.stats.files ?? 0)} icon="document-text" />
        <StatTile label="Clean records" value={formatInteger(data?.stats.activeRecords ?? 0)} icon="server" tone="success" />
      </View>
      <View style={styles.grid}>
        <StatTile label="Spend in active data" value={formatZar(data?.stats.totalSpendZar ?? 0)} icon="cash" />
        <StatTile
          label="Rows awaiting review"
          value={formatInteger(data?.stats.pendingQuarantine ?? 0)}
          icon="alert-circle"
          tone={(data?.stats.pendingQuarantine ?? 0) > 0 ? 'warning' : 'muted'}
        />
      </View>

      <GlassCard>
        <SectionTitle title="Import workflow" subtitle="Every step writes to the on-device SQLite database" />
        <View style={styles.workflow}>
          {WORKFLOW.map((step, index) => (
            <React.Fragment key={step.label}>
              <View style={styles.step}>
                <View style={styles.stepIcon}>
                  <Ionicons name={step.icon} size={18} color={colors.primary} />
                </View>
                <Text style={typography.caption}>{step.label}</Text>
              </View>
              {index < WORKFLOW.length - 1 ? <Ionicons name="chevron-forward" size={14} color={colors.textMuted} /> : null}
            </React.Fragment>
          ))}
        </View>
        {can('files.upload') ? (
          <AppButton label="Start a new import" icon="cloud-upload" onPress={() => navigation.navigate('Main', { screen: 'Upload' })} />
        ) : (
          <Banner tone="info" message="Your Viewer role can browse results and scenarios. Uploading and processing need an Analyst or Administrator." />
        )}
      </GlassCard>

      <SectionTitle
        title="Recent processing runs"
        right={<AppButton label="History" variant="ghost" compact icon="time" onPress={() => navigation.navigate('History')} />}
      />
      {data && data.runs.length === 0 ? (
        <EmptyState icon="file-tray" title="No runs yet" message="Import a Meta or TikTok export to see processing runs here." />
      ) : null}
      {data?.runs.map((run) => (
        <Pressable key={run.run_id} onPress={() => navigation.navigate('RunDetail', { runId: run.run_id })} accessibilityRole="button">
          <GlassCard>
            <View style={styles.runHeader}>
              <Text style={[typography.subheading, styles.flex]} numberOfLines={1}>
                {run.original_filename}
              </Text>
              <RunStatusBadge status={run.status} />
            </View>
            <Text style={typography.caption}>
              {run.supplier_name} · {run.account_name} · {formatDateTime(run.started_at)}
            </Text>
            <Text style={typography.body}>
              {formatInteger(run.accepted_rows)} accepted · {formatInteger(run.rejected_rows)} quarantined · {formatInteger(run.duplicate_rows)} duplicates
            </Text>
          </GlassCard>
        </Pressable>
      ))}

      {data?.stats.pendingQuarantine ? (
        <AppButton label="Review quarantined rows" variant="secondary" icon="shield" onPress={() => navigation.navigate('Quarantine')} />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', gap: spacing.md },
  workflow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  step: { alignItems: 'center', gap: 4 },
  stepIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  runHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  flex: { flex: 1 },
});
