import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as DocumentPicker from 'expo-document-picker';
import { useEffect, useMemo, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { RunStatusBadge } from '../components/RunStatusBadge';
import { Screen } from '../components/Screen';
import { AppButton, Banner, Divider, EmptyState, GlassCard, KeyValue, LoadingOverlay, SectionTitle, SelectField, StatusBadge } from '../components/ui';
import { UploadedFileView } from '../database/models';
import { RootStackParamList } from '../navigation/types';
import { readPickedFile } from '../platform/expoPlatform';

import { inspectSupplierFile, InspectionMetadata, listUploadedFiles } from '../services/ingestion/ingestionService';
import { listAccounts, listClients } from '../services/reference/referenceService';
import { useApp, useServices } from '../state/AppProvider';
import { useAsyncData } from '../state/useAsyncData';
import { formatBytes, formatDateTime, formatInteger } from '../ui/format';
import { spacing, typography } from '../ui/theme';

export function UploadScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { services, actor } = useServices();
  const { can } = useApp();
  const [clientId, setClientId] = useState<number | null>(null);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<InspectionMetadata | null>(null);
  const [existing, setExisting] = useState<{ file: UploadedFileView; message: string } | null>(null);

  const reference = useAsyncData(async () => {
    const [clients, accounts] = await Promise.all([listClients(services), listAccounts(services)]);
    return { clients, accounts };
  }, [services]);

  const uploads = useAsyncData(async () => (accountId ? listUploadedFiles(services, { accountId }) : []), [services, accountId]);

  useEffect(() => {
    if (!clientId && reference.data?.clients.length) {
      setClientId(reference.data.clients[0].client_id);
    }
  }, [reference.data, clientId]);

  const accounts = useMemo(() => reference.data?.accounts.filter((account) => account.client_id === clientId) ?? [], [reference.data, clientId]);

  useEffect(() => {
    if (accounts.length && !accounts.some((account) => account.account_id === accountId)) {
      setAccountId(accounts[0].account_id);
    }
    if (!accounts.length) {
      setAccountId(null);
    }
  }, [accounts, accountId]);

  const pickFile = async () => {
    if (!accountId) {
      setError('Choose a client and advertising account first.');
      return;
    }
    setError(null);
    setInspection(null);
    setExisting(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        type: ['*/*'],
      });
      if (result.canceled || !result.assets?.length) {
        return;
      }
      const asset = result.assets[0];
      setBusy(true);
      try {
        const outcome = await inspectSupplierFile(services, actor, {
          accountId,
          originalFilename: asset.name,
          contentType: asset.mimeType ?? null,
          sizeBytes: asset.size ?? null,
          readBytes: () => readPickedFile(asset.uri),
        });
        if (outcome.outcome === 'already_registered') {
          setExisting({ file: outcome.existingFile, message: outcome.message });
        } else {
          setInspection(outcome.inspection);
        }
        await uploads.reload();
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(message);
        Alert.alert('Import Error', message || 'Failed to process file');
      } finally {
        setBusy(false);
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      Alert.alert('Import Error', message || 'Failed to select file');
    }
  };

  const resume = (file: UploadedFileView) => {
    if (file.latest_run_status === 'completed') {
      navigation.navigate('RunDetail', { runId: file.latest_run_id as number });
    } else {
      navigation.navigate('Mapping', { fileId: file.file_id });
    }
  };

  if (!can('files.upload')) {
    return (
      <Screen>
        <EmptyState icon="lock-closed" title="Upload not available" message="Your role can view reports but cannot import supplier files." />
      </Screen>
    );
  }

  return (
    <Screen refreshing={reference.loading} onRefresh={reference.reload} overlay={<LoadingOverlay visible={busy} message="Validating, hashing and inspecting the file…" />}>
      <GlassCard>
        <SectionTitle title="Import campaign data" subtitle="CSV or XLSX exports from Meta or TikTok, up to 25 MB" />
        <SelectField
          label="Client"
          value={clientId}
          options={(reference.data?.clients ?? []).map((client) => ({ value: client.client_id, label: client.client_name }))}
          onChange={(value) => setClientId(value)}
        />
        <SelectField
          label="Advertising account"
          value={accountId}
          options={accounts.map((account) => ({
            value: account.account_id,
            label: `${account.supplier_name} · ${account.account_name}`,
            description: account.external_account_id,
          }))}
          onChange={(value) => setAccountId(value)}
          placeholder={accounts.length ? 'Select…' : 'No accounts for this client'}
        />
        <AppButton label="Choose CSV or XLSX file" icon="document-attach" onPress={pickFile} disabled={!accountId} />
        {error ? <Banner tone="danger" message={error} /> : null}
        {reference.error ? <Banner tone="danger" message={reference.error} /> : null}
      </GlassCard>

      {existing ? (
        <GlassCard>
          <Banner tone="warning" title="Already uploaded" message={existing.message} />
          <KeyValue label="File" value={existing.file.original_filename} />
          <KeyValue label="Status" value={existing.file.status} />
          <AppButton label="Resume existing upload" icon="play-forward" onPress={() => resume(existing.file)} />
        </GlassCard>
      ) : null}

      {inspection ? (
        <GlassCard>
          <View style={styles.row}>
            <Text style={[typography.heading, styles.flex]}>Inspection</Text>
            <StatusBadge label={inspection.supplierName} tone="success" />
          </View>
          <Banner tone="success" message={inspection.message} />
          <KeyValue label="File type" value={inspection.fileType.toUpperCase()} />
          <KeyValue label="Size" value={formatBytes(inspection.fileSizeBytes)} />
          {inspection.worksheetName ? <KeyValue label="Worksheet" value={inspection.worksheetName} /> : null}
          <KeyValue label="Header row" value={String(inspection.headerRowNumber)} />
          <KeyValue label="Columns" value={String(inspection.headers.length)} />
          <Divider />
          <KeyValue label="Total source rows" value={formatInteger(inspection.totalRows)} />
          <KeyValue label="Detail rows" value={formatInteger(inspection.detailRows)} valueTone="success" />
          <KeyValue label="Summary rows excluded" value={formatInteger(inspection.summaryRows)} valueTone={inspection.summaryRows ? 'warning' : undefined} />
          <KeyValue label="Blank rows" value={formatInteger(inspection.blankRows)} />
          <KeyValue label="Detected supplier" value={inspection.detectedSupplierCode ? inspection.supplierName : 'Not detected'} />
          <Text style={typography.caption}>SHA-256 {inspection.fileHash.slice(0, 24)}…</Text>
          <AppButton label="Continue to field mapping" icon="arrow-forward" onPress={() => navigation.navigate('Mapping', { fileId: inspection.fileId })} />
        </GlassCard>
      ) : null}

      <SectionTitle title="Uploads for this account" subtitle="Resume mapping or review earlier imports" />
      {uploads.data && uploads.data.length === 0 ? <EmptyState icon="folder-open" title="No uploads yet" message="Files you import for this account appear here." /> : null}
      {uploads.data?.map((file) => (
        <GlassCard key={file.file_id}>
          <View style={styles.row}>
            <Text style={[typography.subheading, styles.flex]} numberOfLines={1}>
              {file.original_filename}
            </Text>
            <RunStatusBadge status={file.status} />
          </View>
          <Text style={typography.caption}>
            {formatInteger(file.record_count)} detail rows · {formatBytes(file.file_size_bytes)} · {formatDateTime(file.upload_date)}
          </Text>
          <AppButton label={file.latest_run_status === 'completed' ? 'View run' : 'Resume'} variant="secondary" compact icon="play-forward" onPress={() => resume(file)} />
        </GlassCard>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  flex: { flex: 1 },
});
