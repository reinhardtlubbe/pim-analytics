import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Screen } from '../components/Screen';
import { AppButton, Banner, Chip, EmptyState, GlassCard, KeyValue, SectionTitle, StatusBadge, TextField } from '../components/ui';
import { QuarantineStatus } from '../database/models';
import { RootScreenProps } from '../navigation/types';
import { parseJson } from '../utils/async';
import { toStructuredError } from '../services/errors';
import { CellValue } from '../services/ingestion/fileParser';
import { getMappingConfirmation } from '../services/mapping/confirmationService';
import { dismissQuarantinedRecord, getQuarantinedRecord, getQuarantinedRecords, getValidationErrors, QuarantineView, reprocessQuarantinedRecord } from '../services/processing/quarantineService';
import { getProcessingRun } from '../services/reporting/historyService';
import { useApp, useServices } from '../state/AppProvider';
import { useAsyncData } from '../state/useAsyncData';
import { formatDateTime } from '../ui/format';
import { spacing, typography } from '../ui/theme';

const STATUS_TONE: Record<QuarantineStatus, 'warning' | 'success' | 'muted'> = { pending_review: 'warning', resolved: 'success', dismissed: 'muted' };
const STATUS_LABEL: Record<QuarantineStatus, string> = { pending_review: 'Pending review', resolved: 'Resolved', dismissed: 'Dismissed' };

export function QuarantineScreen({ route, navigation }: RootScreenProps<'Quarantine'>) {
  const { services } = useServices();
  const runId = route.params?.runId;
  const [status, setStatus] = useState<QuarantineStatus | null>('pending_review');
  const { data, loading, error, reload } = useAsyncData(() => getQuarantinedRecords(services, { runId, status: status ?? undefined }), [services, runId, status]);

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      {runId ? <Banner tone="info" message={`Rows from run #${runId}.`} /> : null}
      <View style={styles.row}>
        <Chip label="Pending" active={status === 'pending_review'} onPress={() => setStatus('pending_review')} />
        <Chip label="Resolved" active={status === 'resolved'} onPress={() => setStatus('resolved')} />
        <Chip label="Dismissed" active={status === 'dismissed'} onPress={() => setStatus('dismissed')} />
        <Chip label="All" active={status === null} onPress={() => setStatus(null)} />
      </View>
      {error ? <Banner tone="danger" message={error} /> : null}
      {data && data.length === 0 ? <EmptyState icon="shield-checkmark" title="Nothing here" message="No quarantined rows match this filter." /> : null}
      {data?.map((entry) => (
        <Pressable key={entry.quarantine_id} onPress={() => navigation.navigate('QuarantineDetail', { quarantineId: entry.quarantine_id })} accessibilityRole="button">
          <GlassCard>
            <View style={styles.row}>
              <Text style={[typography.subheading, styles.flex]}>
                Row {entry.source_row_number} · run #{entry.run_id}
              </Text>
              <StatusBadge label={STATUS_LABEL[entry.status]} tone={STATUS_TONE[entry.status]} />
            </View>
            <StatusBadge label={entry.reason_type === 'exact_duplicate' ? 'Exact duplicate' : 'Validation failure'} tone={entry.reason_type === 'exact_duplicate' ? 'info' : 'danger'} />
            <Text style={typography.body} numberOfLines={3}>
              {entry.reason}
            </Text>
            <Text style={typography.caption}>{entry.original_filename}</Text>
          </GlassCard>
        </Pressable>
      ))}
    </Screen>
  );
}

export function QuarantineDetailScreen({ route, navigation }: RootScreenProps<'QuarantineDetail'>) {
  const { quarantineId } = route.params;
  const { services, actor } = useServices();
  const { can } = useApp();
  const [entry, setEntry] = useState<QuarantineView | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [mappedColumns, setMappedColumns] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'danger' | 'success'; text: string } | null>(null);
  const [note, setNote] = useState('');

  const { data, error } = useAsyncData(() => getQuarantinedRecord(services, quarantineId), [services, quarantineId]);

  useEffect(() => {
    if (!data) {
      return;
    }
    setEntry(data);
    const source = parseJson<Record<string, CellValue>>(data.source_data_json, {});
    setValues(Object.fromEntries(Object.entries(source).map(([key, value]) => [key, value === null ? '' : String(value)])));
    (async () => {
      const run = await getProcessingRun(services, data.run_id);
      const confirmation = await getMappingConfirmation(services, run.confirmation_id);
      setMappedColumns(confirmation.columnMappings as Record<string, string>);
      const rowErrors = await getValidationErrors(services, { runId: data.run_id, sourceRowNumber: data.source_row_number });
      setErrors(rowErrors.map((item) => `${item.severity}: ${item.field_name ? `${item.field_name} – ` : ''}${item.error_message}`));
    })().catch(() => undefined);
  }, [data, services]);

  const original = entry ? parseJson<Record<string, CellValue>>(entry.source_data_json, {}) : {};
  const editable = Boolean(entry && entry.status === 'pending_review' && entry.run_is_active === 1 && can('quarantine.review'));

  const submit = async () => {
    if (!entry) {
      return;
    }
    const corrections: Record<string, CellValue> = {};
    Object.entries(values).forEach(([key, value]) => {
      const before = original[key] === null || original[key] === undefined ? '' : String(original[key]);
      if (value !== before) {
        corrections[key] = value.trim() === '' ? null : value;
      }
    });
    setBusy(true);
    setMessage(null);
    try {
      const result = await reprocessQuarantinedRecord(services, actor, entry.quarantine_id, corrections);
      setMessage({ tone: 'success', text: `Row imported as record #${result.recordId}. The original values remain in the audit trail.` });
      setEntry({ ...entry, status: 'resolved' });
    } catch (caught) {
      setMessage({ tone: 'danger', text: toStructuredError(caught).message });
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    if (!entry) {
      return;
    }
    Alert.alert('Dismiss row', 'Mark this row as reviewed without importing it? It stays in quarantine history.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Dismiss',
        style: 'destructive',
        onPress: async () => {
          try {
            await dismissQuarantinedRecord(services, actor, entry.quarantine_id, note);
            navigation.goBack();
          } catch (caught) {
            setMessage({ tone: 'danger', text: toStructuredError(caught).message });
          }
        },
      },
    ]);
  };

  return (
    <Screen>
      {error ? <Banner tone="danger" message={error} /> : null}
      {entry ? (
        <>
          <GlassCard>
            <View style={styles.row}>
              <Text style={[typography.heading, styles.flex]}>Row {entry.source_row_number}</Text>
              <StatusBadge label={STATUS_LABEL[entry.status]} tone={STATUS_TONE[entry.status]} />
            </View>
            <KeyValue label="File" value={entry.original_filename} />
            <KeyValue label="Run" value={`#${entry.run_id}${entry.run_is_active ? ' (active)' : ''}`} />
            <KeyValue label="Quarantined" value={formatDateTime(entry.created_at)} />
            <Banner tone={entry.reason_type === 'exact_duplicate' ? 'info' : 'danger'} message={entry.reason} />
            {errors.map((item, index) => (
              <Text key={index} style={typography.caption}>
                {item}
              </Text>
            ))}
            {entry.run_is_active !== 1 ? <Banner tone="warning" message="This row belongs to a superseded or failed run and is read-only." /> : null}
          </GlassCard>

          <GlassCard>
            <SectionTitle title={editable && entry.reason_type === 'validation' ? 'Correct source values' : 'Source values'} subtitle="Mapped field shown under each column" />
            {Object.keys(values).map((column) => (
              <TextField
                key={column}
                label={column}
                hint={mappedColumns[column] ? `→ ${mappedColumns[column] === 'skip' ? 'skipped' : mappedColumns[column]}` : undefined}
                value={values[column]}
                editable={editable && entry.reason_type === 'validation'}
                onChangeText={(text) => setValues((current) => ({ ...current, [column]: text }))}
              />
            ))}
          </GlassCard>

          {message ? <Banner tone={message.tone} message={message.text} /> : null}
          {editable ? (
            <>
              {entry.reason_type === 'validation' ? <AppButton label="Validate and import corrected row" icon="checkmark-done" loading={busy} onPress={submit} /> : null}
              <TextField label="Dismissal note (optional)" value={note} onChangeText={setNote} />
              <AppButton label="Dismiss row" variant="danger" icon="close" onPress={dismiss} />
            </>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
});
