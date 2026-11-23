import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { RunStatusBadge } from '../components/RunStatusBadge';
import { Screen } from '../components/Screen';
import { AppButton, Banner, Chip, Divider, EmptyState, GlassCard, KeyValue, SectionTitle, StatusBadge } from '../components/ui';
import { RootScreenProps } from '../navigation/types';
import { shareExportedFile } from '../platform/expoPlatform';
import { listAuditLogs, LogSeverity } from '../services/audit/auditService';
import { toStructuredError } from '../services/errors';
import { getUploadedFile, listUploadedFiles } from '../services/ingestion/ingestionService';
import { getMappingConfirmation } from '../services/mapping/confirmationService';
import { getValidationErrors } from '../services/processing/quarantineService';
import { exportProcessingReport, ExportFormat } from '../services/reporting/exportService';
import { getProcessingHistory, getProcessingRun, getRunReconciliation } from '../services/reporting/historyService';
import { useApp, useServices } from '../state/AppProvider';
import { useAsyncData } from '../state/useAsyncData';
import { formatBytes, formatDateTime, formatInteger } from '../ui/format';
import { spacing, typography } from '../ui/theme';

export function HistoryScreen({ navigation }: RootScreenProps<'History'>) {
  const { services } = useServices();
  const [view, setView] = useState<'runs' | 'files'>('runs');
  const { data, loading, error, reload } = useAsyncData(async () => {
    const [runs, files] = await Promise.all([getProcessingHistory(services), listUploadedFiles(services)]);
    return { runs, files };
  }, [services]);

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <View style={styles.row}>
        <Chip label="Processing runs" active={view === 'runs'} onPress={() => setView('runs')} icon="cog" />
        <Chip label="Uploaded files" active={view === 'files'} onPress={() => setView('files')} icon="document" />
        <Chip label="Audit log" onPress={() => navigation.navigate('Logs')} icon="list" />
      </View>
      {error ? <Banner tone="danger" message={error} /> : null}
      {view === 'runs' ? (
        <>
          {data && data.runs.length === 0 ? <EmptyState icon="time" title="No processing runs" message="Runs appear here after you confirm a mapping and process a file." /> : null}
          {data?.runs.map((run) => (
            <Pressable key={run.run_id} onPress={() => navigation.navigate('RunDetail', { runId: run.run_id })} accessibilityRole="button">
              <GlassCard>
                <View style={styles.row}>
                  <Text style={[typography.subheading, styles.flex]} numberOfLines={1}>
                    #{run.run_id} · {run.original_filename}
                  </Text>
                  <RunStatusBadge status={run.status} />
                </View>
                <Text style={typography.caption}>
                  {run.client_name} · {run.supplier_name} · {formatDateTime(run.started_at)}
                </Text>
                <Text style={typography.body}>
                  {formatInteger(run.accepted_rows)} accepted · {formatInteger(run.rejected_rows)} quarantined · {formatInteger(run.duplicate_rows)} duplicates
                  {run.is_active ? ' · active' : ''}
                </Text>
              </GlassCard>
            </Pressable>
          ))}
        </>
      ) : (
        <>
          {data && data.files.length === 0 ? <EmptyState icon="document" title="No uploaded files" message="Registered uploads will be listed here." /> : null}
          {data?.files.map((file) => (
            <GlassCard key={file.file_id}>
              <View style={styles.row}>
                <Text style={[typography.subheading, styles.flex]} numberOfLines={1}>
                  {file.original_filename}
                </Text>
                <RunStatusBadge status={file.status} />
              </View>
              <Text style={typography.caption}>
                {file.client_name} · {file.account_name} · {formatBytes(file.file_size_bytes)} · {formatDateTime(file.upload_date)}
              </Text>
              <View style={styles.row}>
                <AppButton label="Resume mapping" compact variant="secondary" icon="git-compare" onPress={() => navigation.navigate('Mapping', { fileId: file.file_id })} style={styles.flex} />
                {file.latest_run_id ? (
                  <AppButton label="Latest run" compact variant="secondary" icon="cog" onPress={() => navigation.navigate('RunDetail', { runId: file.latest_run_id as number })} style={styles.flex} />
                ) : null}
              </View>
            </GlassCard>
          ))}
        </>
      )}
    </Screen>
  );
}

export function RunDetailScreen({ route, navigation }: RootScreenProps<'RunDetail'>) {
  const { runId } = route.params;
  const { services, actor } = useServices();
  const { can } = useApp();
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { data, loading, error, reload } = useAsyncData(async () => {
    const run = await getProcessingRun(services, runId);
    const [reconciliation, errors, logs, file, confirmation] = await Promise.all([
      getRunReconciliation(services, runId),
      getValidationErrors(services, { runId, limit: 50 }),
      listAuditLogs(services.db, { runId, limit: 50 }),
      getUploadedFile(services.db, run.file_id),
      getMappingConfirmation(services, run.confirmation_id),
    ]);
    return { run, reconciliation, errors, logs, file, confirmation };
  }, [services, runId]);

  const exportReport = async (format: ExportFormat) => {
    setExporting(format);
    setActionError(null);
    try {
      const result = await exportProcessingReport(services, actor, runId, format);
      const shared = await shareExportedFile(result.uri, result.mimeType, 'Share processing report');
      setMessage(`${result.filename} created.${shared ? '' : ' Sharing is unavailable; saved in app storage.'}`);
    } catch (caught) {
      setActionError(toStructuredError(caught).message);
    } finally {
      setExporting(null);
    }
  };

  const run = data?.run;
  return (
    <Screen refreshing={loading} onRefresh={reload}>
      {error ? <Banner tone="danger" message={error} /> : null}
      {run && data ? (
        <>
          <GlassCard>
            <View style={styles.row}>
              <Text style={[typography.heading, styles.flex]}>Run #{run.run_id}</Text>
              <RunStatusBadge status={run.status} />
            </View>
            <Text style={typography.body}>{run.original_filename}</Text>
            <Text style={typography.caption}>
              {run.client_name} · {run.account_name} · {run.supplier_name}
            </Text>
            <KeyValue label="Started" value={formatDateTime(run.started_at)} />
            <KeyValue label="Completed" value={formatDateTime(run.completed_at)} />
            <KeyValue label="Duration" value={run.duration_ms !== null ? `${(run.duration_ms / 1000).toFixed(2)} s` : '—'} />
            <KeyValue label="Mapping confirmation" value={`#${data.confirmation.confirmationId}${data.confirmation.profileName ? ` (${data.confirmation.profileName})` : ''}`} />
            {run.error_message ? <Banner tone="danger" message={run.error_message} /> : null}
          </GlassCard>

          <GlassCard>
            <SectionTitle title="Reconciliation" />
            <KeyValue label="Total source rows" value={formatInteger(data.reconciliation.totalRows)} />
            <KeyValue label="Blank rows" value={formatInteger(data.reconciliation.blankRows)} />
            <KeyValue label="Summary rows excluded" value={formatInteger(data.reconciliation.summaryRows)} />
            <KeyValue label="Detail rows" value={formatInteger(data.reconciliation.detailRows)} />
            <Divider />
            <KeyValue label="Accepted" value={formatInteger(data.reconciliation.acceptedRows)} valueTone="success" />
            <KeyValue label="Quarantined" value={formatInteger(data.reconciliation.rejectedRows)} />
            <KeyValue label="Exact duplicates" value={formatInteger(data.reconciliation.duplicateRows)} />
            <KeyValue label="Stored records" value={formatInteger(data.reconciliation.storedRecords)} />
            <KeyValue label="Awaiting review" value={formatInteger(data.reconciliation.pendingQuarantine)} />
            <View style={styles.badges}>
              <StatusBadge label="Source totals" tone={data.reconciliation.sourceBalanced ? 'success' : 'danger'} />
              <StatusBadge label="Row outcomes" tone={data.reconciliation.outcomeBalanced ? 'success' : 'danger'} />
              <StatusBadge label="Stored = accepted" tone={data.reconciliation.storageBalanced ? 'success' : 'danger'} />
            </View>
          </GlassCard>

          <View style={styles.row}>
            <AppButton label="Results" icon="stats-chart" onPress={() => navigation.popTo('Main', { screen: 'Results', params: { runId } })} style={styles.flex} />
            <AppButton label="Quarantine" variant="secondary" icon="shield" onPress={() => navigation.navigate('Quarantine', { runId })} style={styles.flex} />
          </View>
          {can('files.process') ? (
            <AppButton
              label="Reprocess from new mapping"
              variant="secondary"
              icon="refresh"
              onPress={() => navigation.navigate('Mapping', { fileId: run.file_id })}
              accessibilityHint="Confirm a mapping again and create a new run; this run stays in history"
            />
          ) : null}
          {can('files.process') && (run.status === 'completed' || run.status === 'failed' || run.status === 'superseded') ? (
            <AppButton
              label="Reprocess with this confirmation"
              variant="secondary"
              icon="repeat"
              onPress={() => navigation.navigate('Processing', { fileId: run.file_id, confirmationId: run.confirmation_id })}
            />
          ) : null}
          {can('reports.export') ? (
            <View style={styles.row}>
              <AppButton label="Report CSV" variant="secondary" icon="download" loading={exporting === 'csv'} onPress={() => exportReport('csv')} style={styles.flex} />
              <AppButton label="Report XLSX" variant="secondary" icon="grid" loading={exporting === 'xlsx'} onPress={() => exportReport('xlsx')} style={styles.flex} />
            </View>
          ) : null}
          {message ? <Banner tone="success" message={message} /> : null}
          {actionError ? <Banner tone="danger" message={actionError} /> : null}

          <GlassCard>
            <SectionTitle title="Validation messages" subtitle={`${data.errors.length} shown`} />
            {data.errors.length === 0 ? <Text style={typography.body}>No validation errors or warnings.</Text> : null}
            {data.errors.map((item) => (
              <View key={item.error_id} style={styles.logRow}>
                <StatusBadge label={item.severity} tone={item.severity === 'error' ? 'danger' : 'warning'} />
                <Text style={[typography.body, styles.flex]}>
                  Row {item.source_row_number}
                  {item.field_name ? ` · ${item.field_name}` : ''}: {item.error_message}
                </Text>
              </View>
            ))}
          </GlassCard>

          <GlassCard>
            <SectionTitle title="Processing log" />
            {data.logs.map((log) => (
              <LogLine key={log.log_id} severity={log.severity} message={log.message} at={log.created_at} event={log.event_type} />
            ))}
          </GlassCard>
        </>
      ) : null}
    </Screen>
  );
}

function LogLine({ severity, message, at, event }: { severity: LogSeverity; message: string; at: string; event: string }) {
  return (
    <View style={styles.logRow}>
      <StatusBadge label={severity} tone={severity === 'error' ? 'danger' : severity === 'warning' ? 'warning' : 'info'} />
      <View style={styles.flex}>
        <Text style={typography.body}>{message}</Text>
        <Text style={typography.caption}>
          {event} · {formatDateTime(at)}
        </Text>
      </View>
    </View>
  );
}

export function LogsScreen({ route }: RootScreenProps<'Logs'>) {
  const { services } = useServices();
  const [severity, setSeverity] = useState<LogSeverity | null>(null);
  const runId = route.params?.runId;
  const { data, loading, error, reload } = useAsyncData(() => listAuditLogs(services.db, { runId, severity: severity ?? undefined, limit: 300 }), [services, runId, severity]);
  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <View style={styles.row}>
        <Chip label="All" active={severity === null} onPress={() => setSeverity(null)} />
        <Chip label="Info" active={severity === 'info'} onPress={() => setSeverity('info')} />
        <Chip label="Warnings" active={severity === 'warning'} onPress={() => setSeverity('warning')} />
        <Chip label="Errors" active={severity === 'error'} onPress={() => setSeverity('error')} />
      </View>
      {error ? <Banner tone="danger" message={error} /> : null}
      {data && data.length === 0 ? <EmptyState icon="list" title="No log entries" message="Audit events are recorded as you work." /> : null}
      <GlassCard>
        {data?.map((log) => (
          <View key={log.log_id}>
            <LogLine severity={log.severity} message={log.message} at={log.created_at} event={`${log.event_type}${log.user_email ? ` · ${log.user_email}` : ''}`} />
          </View>
        ))}
      </GlassCard>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  logRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', paddingVertical: 6 },
});
