import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Screen } from '../components/Screen';
import { AppButton, Banner, Divider, GlassCard, KeyValue, SectionTitle, StatusBadge } from '../components/ui';
import { RootScreenProps } from '../navigation/types';
import { toStructuredError } from '../services/errors';
import { ConfirmedMapping, getMappingConfirmation } from '../services/mapping/confirmationService';
import { processUploadedFile, ProcessingProgress, ProcessingStage, ProcessingSummary } from '../services/processing/processingService';
import { useApp, useServices } from '../state/AppProvider';
import { formatInteger } from '../ui/format';
import { colors, spacing, typography } from '../ui/theme';

const STAGES: { key: ProcessingStage; title: string; description: string }[] = [
  { key: 'loading', title: 'Read stored file', description: 'Verify SHA-256 and apply the confirmed snapshot' },
  { key: 'transforming', title: 'Clean, validate and deduplicate', description: 'Normalise months, numbers, currency and objectives' },
  { key: 'persisting', title: 'Persist to SQLite', description: 'Single transaction for records, errors and quarantine' },
  { key: 'completed', title: 'Reconcile', description: 'Row totals checked against stored records' },
];

export function ProcessingScreen({ route, navigation }: RootScreenProps<'Processing'>) {
  const { fileId, confirmationId } = route.params;
  const { services, actor } = useServices();
  const { can } = useApp();
  const [confirmation, setConfirmation] = useState<ConfirmedMapping | null>(null);
  const [progress, setProgress] = useState<ProcessingProgress | null>(null);
  const [summary, setSummary] = useState<ProcessingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    getMappingConfirmation(services, confirmationId)
      .then(setConfirmation)
      .catch((caught) => setError(toStructuredError(caught).message));
  }, [services, confirmationId]);

  const start = async () => {
    setRunning(true);
    setError(null);
    setSummary(null);
    try {
      const result = await processUploadedFile(services, actor, { fileId, confirmationId }, setProgress);
      setSummary(result);
    } catch (caught) {
      setError(toStructuredError(caught).message);
    } finally {
      setRunning(false);
    }
  };

  useEffect(() => {
    if (!started.current && can('files.process')) {
      started.current = true;
      start();
    }
  });

  const stageIndex = progress ? STAGES.findIndex((stage) => stage.key === progress.stage) : -1;

  return (
    <Screen>
      <GlassCard>
        <SectionTitle title="Processing" subtitle={confirmation ? `Confirmation #${confirmation.confirmationId} · ${confirmation.supplierName}` : 'Loading confirmation…'} />
        {STAGES.map((stage, index) => {
          const done = summary ? true : index < stageIndex;
          const current = !summary && index === stageIndex && running;
          return (
            <View key={stage.key} style={styles.stage}>
              <View style={[styles.stageIcon, done && styles.stageDone, current && styles.stageCurrent]}>
                {current ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <Ionicons name={done ? 'checkmark' : 'ellipse-outline'} size={16} color={done ? '#022c22' : colors.textMuted} />
                )}
              </View>
              <View style={styles.flex}>
                <Text style={typography.subheading}>{stage.title}</Text>
                <Text style={typography.caption}>{current && progress ? progress.message : stage.description}</Text>
              </View>
            </View>
          );
        })}
        {progress && progress.totalRows > 0 && !summary ? (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.round((progress.processedRows / progress.totalRows) * 100)}%` }]} />
          </View>
        ) : null}
      </GlassCard>

      {error ? (
        <GlassCard>
          <Banner tone="danger" title="Processing failed" message={error} />
          <Text style={typography.caption}>The failed run is recorded in processing history. No partial records were kept.</Text>
          <AppButton label="Try again" icon="refresh" onPress={start} disabled={running} />
          <AppButton label="Back to mapping" variant="secondary" icon="git-compare" onPress={() => navigation.replace('Mapping', { fileId })} />
        </GlassCard>
      ) : null}

      {summary ? (
        <GlassCard>
          <View style={styles.row}>
            <Text style={[typography.heading, styles.flex]}>Run #{summary.runId}</Text>
            <StatusBadge label={summary.reconciled ? 'Reconciled' : 'Check totals'} tone={summary.reconciled ? 'success' : 'warning'} />
          </View>
          <KeyValue label="Total source rows" value={formatInteger(summary.totalRows)} />
          <KeyValue label="Blank rows skipped" value={formatInteger(summary.blankRows)} />
          <KeyValue label="Summary rows excluded" value={formatInteger(summary.summaryRows)} />
          <KeyValue label="Detail rows processed" value={formatInteger(summary.detailRows)} />
          <Divider />
          <KeyValue label="Accepted" value={formatInteger(summary.acceptedRows)} valueTone="success" />
          <KeyValue label="Quarantined" value={formatInteger(summary.rejectedRows)} valueTone={summary.rejectedRows ? 'warning' : undefined} />
          <KeyValue label="Exact duplicates" value={formatInteger(summary.duplicateRows)} valueTone={summary.duplicateRows ? 'warning' : undefined} />
          <KeyValue label="Potential duplicates (kept)" value={formatInteger(summary.potentialDuplicateRows)} />
          <KeyValue label="Accepted with missing clicks" value={formatInteger(summary.missingClickRows)} />
          <KeyValue label="Warnings logged" value={formatInteger(summary.warningCount)} />
          <KeyValue label="Duration" value={`${(summary.durationMs / 1000).toFixed(2)} s`} />
          <Text style={typography.caption}>
            Total = blank + summary + detail. Detail = accepted + quarantined + duplicates.{summary.supersededRunId ? ` Run #${summary.supersededRunId} was superseded and kept in history.` : ''}
          </Text>
          <AppButton label="View results" icon="stats-chart" onPress={() => navigation.popTo('Main', { screen: 'Results', params: { runId: summary.runId, title: `Run #${summary.runId}` } })} />
          {summary.rejectedRows + summary.duplicateRows > 0 ? (
            <AppButton label="Review quarantined rows" variant="secondary" icon="shield" onPress={() => navigation.navigate('Quarantine', { runId: summary.runId })} />
          ) : null}
          <AppButton label="Run details and report" variant="secondary" icon="document-text" onPress={() => navigation.navigate('RunDetail', { runId: summary.runId })} />
        </GlassCard>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stage: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 6 },
  stageIcon: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: colors.glassBorder, alignItems: 'center', justifyContent: 'center' },
  stageDone: { backgroundColor: colors.success, borderColor: colors.success },
  stageCurrent: { borderColor: colors.primary },
  progressTrack: { height: 6, borderRadius: 3, backgroundColor: colors.glassHighlight, overflow: 'hidden' },
  progressFill: { height: 6, backgroundColor: colors.primary },
});
