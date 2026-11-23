import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { Screen } from '../components/Screen';
import { AppButton, Banner, BadgeTone, GlassCard, LoadingOverlay, SectionTitle, SelectField, SelectOption, StatusBadge, TextField } from '../components/ui';
import { MappingTarget, SKIP_TARGET, STANDARD_FIELDS } from '../config/standardFields';
import { RootScreenProps } from '../navigation/types';
import { toStructuredError } from '../services/errors';
import { changeFileLayout, InspectionMetadata, resumeUploadedFile } from '../services/ingestion/ingestionService';
import { confirmMapping } from '../services/mapping/confirmationService';
import { applyProfileMappings, ColumnMappings, mappingsFromSuggestions, statusForTarget, validateColumnMappings } from '../services/mapping/mappingEngine';
import { createMappingProfile, listCompatibleProfiles, MappingProfile, updateMappingProfile } from '../services/mapping/profileService';
import { useApp, useServices } from '../state/AppProvider';
import { colors, spacing, typography } from '../ui/theme';

const TARGET_OPTIONS: SelectOption<string>[] = [
  ...STANDARD_FIELDS.map((field) => ({
    value: field.key,
    label: field.label,
    description: field.presentationAliases.length ? `${field.key} (shown as ${field.presentationAliases.join(', ')})` : field.key,
  })),
  { value: SKIP_TARGET, label: 'Skip this column', description: 'Keep in the source snapshot but do not map' },
];

export function MappingScreen({ route, navigation }: RootScreenProps<'Mapping'>) {
  const { fileId } = route.params;
  const { services, actor } = useServices();
  const { can } = useApp();
  const [inspection, setInspection] = useState<InspectionMetadata | null>(null);
  const [mappings, setMappings] = useState<ColumnMappings>({});
  const [profiles, setProfiles] = useState<MappingProfile[]>([]);
  const [activeProfile, setActiveProfile] = useState<MappingProfile | null>(null);
  const [profileName, setProfileName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadProfiles = useCallback(
    async (current: InspectionMetadata) => {
      setProfiles(await listCompatibleProfiles(services, { supplierCode: current.supplierCode, fileType: current.fileType, headers: current.headers }));
    },
    [services],
  );

  const applyInspection = useCallback(
    async (next: InspectionMetadata) => {
      setInspection(next);
      setMappings(mappingsFromSuggestions(next.suggestions));
      setActiveProfile(null);
      await loadProfiles(next);
    },
    [loadProfiles],
  );

  useEffect(() => {
    (async () => {
      setBusy('Reading stored file…');
      try {
        await applyInspection(await resumeUploadedFile(services, fileId));
      } catch (caught) {
        setError(toStructuredError(caught).message);
      } finally {
        setBusy(null);
      }
    })();
  }, [services, fileId, applyInspection]);

  const validation = useMemo(
    () => (inspection ? validateColumnMappings(inspection.headers, mappings, inspection.supplierCode) : null),
    [inspection, mappings],
  );
  const duplicateColumns = useMemo(
    () => new Set(validation?.issues.filter((issue) => issue.type === 'duplicate_target').flatMap((issue) => issue.columns) ?? []),
    [validation],
  );

  const changeLayout = async (layout: { worksheetName?: string; headerRowNumber?: number }) => {
    setBusy('Re-reading the file layout…');
    setError(null);
    try {
      await applyInspection(await changeFileLayout(services, actor, fileId, layout));
    } catch (caught) {
      setError(toStructuredError(caught).message);
    } finally {
      setBusy(null);
    }
  };

  const loadProfile = (profileId: number) => {
    const profile = profiles.find((item) => item.profileId === profileId);
    if (!profile || !inspection) {
      return;
    }
    setMappings(applyProfileMappings(inspection.headers, profile.columnMappings));
    setActiveProfile(profile);
    setProfileName(profile.profileName);
    setNotice(`Loaded profile "${profile.profileName}". Review the selections before confirming.`);
  };

  const saveProfile = async (mode: 'create' | 'update') => {
    if (!inspection) {
      return;
    }
    setError(null);
    setBusy('Saving mapping profile…');
    try {
      const saved =
        mode === 'update' && activeProfile
          ? await updateMappingProfile(services, actor, activeProfile.profileId, { profileName, columnMappings: mappings })
          : await createMappingProfile(services, actor, {
              supplierId: inspection.supplierId,
              profileName,
              fileType: inspection.fileType,
              columnMappings: mappings,
              headerRowNumber: inspection.headerRowNumber,
              worksheetName: inspection.worksheetName,
            });
      setActiveProfile(saved);
      await loadProfiles(inspection);
      setNotice(mode === 'update' ? `Profile "${saved.profileName}" updated.` : `Profile "${saved.profileName}" saved.`);
    } catch (caught) {
      setError(toStructuredError(caught).message);
    } finally {
      setBusy(null);
    }
  };

  const confirm = async () => {
    if (!inspection || !validation?.valid) {
      return;
    }
    setError(null);
    setBusy('Locking in the confirmed mapping…');
    try {
      const confirmation = await confirmMapping(services, actor, { fileId, columnMappings: mappings, profileId: activeProfile?.profileId ?? null });
      navigation.replace('Processing', { fileId, confirmationId: confirmation.confirmationId });
    } catch (caught) {
      setError(toStructuredError(caught).message);
    } finally {
      setBusy(null);
    }
  };

  const reset = () => {
    if (!inspection) {
      return;
    }
    Alert.alert('Reset mapping', 'Restore the automatic suggestions for every column?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset',
        onPress: () => {
          setMappings(mappingsFromSuggestions(inspection.suggestions));
          setActiveProfile(null);
        },
      },
    ]);
  };

  const rowTone = (column: string, target: MappingTarget): { tone: BadgeTone; label: string } => {
    if (duplicateColumns.has(column)) {
      return { tone: 'danger', label: 'Duplicate' };
    }
    const status = statusForTarget(target);
    return status === 'matched' ? { tone: 'success', label: 'Matched' } : status === 'skipped' ? { tone: 'muted', label: 'Skipped' } : { tone: 'warning', label: 'Review' };
  };

  const essentialTotal = (validation?.totalColumns ?? 0) - (validation?.skippedCount ?? 0);

  return (
    <Screen
      overlay={<LoadingOverlay visible={Boolean(busy)} message={busy ?? ''} />}
      footer={
        inspection ? (
          <View style={styles.footer}>
            <View style={styles.flex}>
              <Text style={typography.subheading}>
                {validation?.matchedCount ?? 0} of {essentialTotal} fields matched
              </Text>
              <Text style={typography.caption}>
                {validation?.skippedCount ?? 0} skipped · {validation?.reviewCount ?? 0} need review
              </Text>
            </View>
            <AppButton label="Confirm mapping" icon="lock-closed" variant="success" disabled={!validation?.valid || !can('files.process')} onPress={confirm} />
          </View>
        ) : null
      }
    >
      {error ? <Banner tone="danger" message={error} /> : null}
      {notice ? <Banner tone="info" message={notice} /> : null}

      {inspection ? (
        <>
          <GlassCard>
            <SectionTitle title={inspection.originalFilename} subtitle={`${inspection.supplierName} · ${inspection.accountName} · ${inspection.detailRows} detail rows`} />
            {inspection.worksheetNames.length > 1 ? (
              <SelectField
                label="Worksheet"
                value={inspection.worksheetName ?? ''}
                options={inspection.worksheetNames.map((name) => ({ value: name, label: name }))}
                onChange={(value) => changeLayout({ worksheetName: value })}
              />
            ) : null}
            <View style={styles.headerRow}>
              <Text style={[typography.body, styles.flex]}>Header row {inspection.headerRowNumber}</Text>
              <AppButton label="Up" compact variant="secondary" icon="arrow-up" disabled={inspection.headerRowNumber <= 1} onPress={() => changeLayout({ headerRowNumber: inspection.headerRowNumber - 1 })} />
              <AppButton label="Down" compact variant="secondary" icon="arrow-down" onPress={() => changeLayout({ headerRowNumber: inspection.headerRowNumber + 1 })} />
            </View>
          </GlassCard>

          <GlassCard>
            <SectionTitle title="Mapping profiles" subtitle={`${profiles.length} compatible profile${profiles.length === 1 ? '' : 's'} for this structure`} />
            {profiles.length ? (
              <SelectField
                label="Load a saved profile"
                value={activeProfile?.profileId ?? null}
                options={profiles.map((profile) => ({ value: profile.profileId, label: profile.profileName, description: `Updated ${profile.updatedAt.slice(0, 10)}` }))}
                onChange={loadProfile}
                placeholder="Choose a profile"
              />
            ) : null}
            {can('mappings.manage') ? (
              <>
                <TextField label="Profile name" value={profileName} onChangeText={setProfileName} placeholder="e.g. Meta monthly export" />
                <View style={styles.buttonRow}>
                  <AppButton label="Save as new" compact icon="save" variant="secondary" disabled={!profileName.trim()} onPress={() => saveProfile('create')} style={styles.flex} />
                  <AppButton
                    label="Update loaded"
                    compact
                    icon="refresh"
                    variant="secondary"
                    disabled={!activeProfile || !profileName.trim()}
                    onPress={() => saveProfile('update')}
                    style={styles.flex}
                  />
                </View>
              </>
            ) : null}
          </GlassCard>

          <SectionTitle title="Source columns" right={<AppButton label="Reset" compact variant="ghost" icon="refresh" onPress={reset} />} />
          {validation && !validation.valid ? (
            <Banner tone="warning" title="Resolve before confirming" message={validation.issues.map((issue) => issue.message).join('\n')} />
          ) : null}
          {inspection.headers.map((column) => {
            const target = mappings[column] ?? '';
            const status = rowTone(column, target);
            const suggestion = inspection.suggestions.find((item) => item.sourceColumn === column);
            return (
              <GlassCard key={column} style={[styles.columnCard, { borderLeftColor: status.tone === 'success' ? colors.success : status.tone === 'muted' ? colors.muted : status.tone === 'danger' ? colors.danger : colors.warning }]}>
                <View style={styles.headerRow}>
                  <Text style={[typography.subheading, styles.flex]} numberOfLines={2}>
                    {column}
                  </Text>
                  <StatusBadge label={status.label} tone={status.tone} />
                </View>
                <Text style={typography.caption} numberOfLines={2}>
                  Samples: {inspection.samples[column]?.length ? inspection.samples[column].join(' · ') : 'all values empty'}
                </Text>
                {suggestion && suggestion.candidates.length > 1 && !target ? (
                  <Text style={typography.caption}>Possible matches: {suggestion.candidates.join(', ')}</Text>
                ) : null}
                <SelectField
                  value={target || null}
                  options={TARGET_OPTIONS}
                  onChange={(value) => setMappings((current) => ({ ...current, [column]: value as MappingTarget }))}
                  placeholder="Choose a standard field"
                  compact
                  status={status.tone}
                  disabled={!can('files.process')}
                />
              </GlassCard>
            );
          })}
          <Banner
            tone="info"
            message={`Defaults applied on confirmation: platform ${inspection.supplierName}${inspection.supplierCode === 'meta' ? ', currency ZAR, link-click metric' : ', currency from the file, destination-click metric'}. The confirmed mapping is stored as an immutable snapshot for this file.`}
          />
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  buttonRow: { flexDirection: 'row', gap: spacing.sm },
  columnCard: { borderLeftWidth: 4 },
});
