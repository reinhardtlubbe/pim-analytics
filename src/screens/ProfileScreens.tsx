import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Screen } from '../components/Screen';
import { AppButton, Banner, EmptyState, GlassCard, SectionTitle, SelectField, StatusBadge, TextField } from '../components/ui';
import { MappingTarget, SKIP_TARGET, STANDARD_FIELDS } from '../config/standardFields';
import { getSupplierConfigByName } from '../config/suppliers';
import { SupplierRow } from '../database/models';
import { RootScreenProps } from '../navigation/types';
import { toStructuredError } from '../services/errors';
import { FileType } from '../services/ingestion/fileParser';
import { ColumnMappings, findDuplicateTargets } from '../services/mapping/mappingEngine';
import { createMappingProfile, deleteMappingProfile, getMappingProfile, listMappingProfiles, updateMappingProfile } from '../services/mapping/profileService';
import { listSuppliers } from '../services/reference/referenceService';
import { useApp, useServices } from '../state/AppProvider';
import { useAsyncData } from '../state/useAsyncData';
import { formatDateTime } from '../ui/format';
import { spacing, typography } from '../ui/theme';

const TARGETS = [...STANDARD_FIELDS.map((field) => ({ value: field.key as string, label: field.label })), { value: SKIP_TARGET as string, label: 'Skip this column' }];

export function ProfilesScreen({ navigation }: RootScreenProps<'Profiles'>) {
  const { services, actor } = useServices();
  const { can } = useApp();
  const [error, setError] = useState<string | null>(null);
  const { data, loading, reload, error: loadError } = useAsyncData(() => listMappingProfiles(services), [services]);

  const remove = (profileId: number, name: string) => {
    Alert.alert('Delete profile', `Delete "${name}"? Confirmed import snapshots that used it are not affected.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteMappingProfile(services, actor, profileId);
            await reload();
          } catch (caught) {
            setError(toStructuredError(caught).message);
          }
        },
      },
    ]);
  };

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      {can('mappings.manage') ? <AppButton label="New mapping profile" icon="add" onPress={() => navigation.navigate('ProfileEditor', {})} /> : null}
      {loadError || error ? <Banner tone="danger" message={(loadError ?? error) as string} /> : null}
      {data && data.length === 0 ? <EmptyState icon="git-compare" title="No profiles yet" message="Save a mapping from the Mapping screen or create one here." /> : null}
      {data?.map((profile) => {
        const mapped = Object.values(profile.columnMappings).filter((target) => target && target !== SKIP_TARGET).length;
        return (
          <Pressable key={profile.profileId} onPress={() => navigation.navigate('ProfileEditor', { profileId: profile.profileId })} accessibilityRole="button">
            <GlassCard>
              <View style={styles.row}>
                <Text style={[typography.subheading, styles.flex]}>{profile.profileName}</Text>
                <StatusBadge label={profile.supplierName} tone="info" />
              </View>
              <Text style={typography.caption}>
                {profile.fileType.toUpperCase()} · {profile.sourceColumns.length} columns · {mapped} mapped · updated {formatDateTime(profile.updatedAt)}
              </Text>
              {can('mappings.manage') ? (
                <View style={styles.row}>
                  <AppButton label="Edit" compact variant="secondary" icon="create" onPress={() => navigation.navigate('ProfileEditor', { profileId: profile.profileId })} style={styles.flex} />
                  <AppButton label="Delete" compact variant="danger" icon="trash" onPress={() => remove(profile.profileId, profile.profileName)} style={styles.flex} />
                </View>
              ) : null}
            </GlassCard>
          </Pressable>
        );
      })}
    </Screen>
  );
}

export function ProfileEditorScreen({ route, navigation }: RootScreenProps<'ProfileEditor'>) {
  const profileId = route.params?.profileId;
  const { services, actor } = useServices();
  const { can } = useApp();
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [fileType, setFileType] = useState<FileType>('csv');
  const [mappings, setMappings] = useState<ColumnMappings>({});
  const [newColumn, setNewColumn] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const supplierRows = await listSuppliers(services);
        setSuppliers(supplierRows);
        if (profileId) {
          const profile = await getMappingProfile(services, profileId);
          setSupplierId(profile.supplierId);
          setName(profile.profileName);
          setFileType(profile.fileType);
          setMappings(profile.columnMappings);
        } else if (supplierRows.length) {
          setSupplierId(supplierRows[0].supplier_id);
        }
      } catch (caught) {
        setError(toStructuredError(caught).message);
      }
    })();
  }, [services, profileId]);

  const seedFromSupplier = () => {
    const supplier = suppliers.find((row) => row.supplier_id === supplierId);
    const config = supplier ? getSupplierConfigByName(supplier.supplier_code) : undefined;
    if (!config) {
      return;
    }
    const seeded: ColumnMappings = {};
    Object.entries(config.exactMappings).forEach(([column, field]) => {
      seeded[column] = field;
    });
    config.skipColumns.forEach((column) => {
      seeded[column] = SKIP_TARGET;
    });
    setMappings(seeded);
  };

  const duplicates = findDuplicateTargets(mappings);

  const save = async () => {
    if (!supplierId) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (profileId) {
        await updateMappingProfile(services, actor, profileId, { profileName: name, columnMappings: mappings });
      } else {
        await createMappingProfile(services, actor, { supplierId, profileName: name, fileType, columnMappings: mappings });
      }
      navigation.goBack();
    } catch (caught) {
      setError(toStructuredError(caught).message);
    } finally {
      setSaving(false);
    }
  };

  const editable = can('mappings.manage');

  return (
    <Screen>
      <GlassCard>
        <SectionTitle title={profileId ? 'Edit profile' : 'New profile'} subtitle="Profiles are reusable templates; confirmed imports keep their own snapshot" />
        <TextField label="Profile name" value={name} onChangeText={setName} editable={editable} />
        <SelectField
          label="Supplier"
          value={supplierId}
          options={suppliers.map((supplier) => ({ value: supplier.supplier_id, label: supplier.supplier_name }))}
          onChange={(value) => setSupplierId(value)}
          disabled={Boolean(profileId) || !editable}
        />
        <SelectField
          label="File type"
          value={fileType}
          options={[
            { value: 'csv', label: 'CSV' },
            { value: 'xlsx', label: 'XLSX' },
          ]}
          onChange={(value) => setFileType(value as FileType)}
          disabled={Boolean(profileId) || !editable}
        />
        {!profileId && editable ? <AppButton label="Start from supplier defaults" variant="secondary" icon="color-wand" onPress={seedFromSupplier} /> : null}
      </GlassCard>

      {duplicates.length ? <Banner tone="danger" message={`Each standard field can be used once. Duplicated: ${duplicates.join(', ')}`} /> : null}

      {Object.keys(mappings).map((column) => (
        <GlassCard key={column}>
          <View style={styles.row}>
            <Text style={[typography.subheading, styles.flex]}>{column}</Text>
            {editable ? (
              <AppButton
                label="Remove"
                compact
                variant="ghost"
                icon="close"
                onPress={() =>
                  setMappings((current) => {
                    const next = { ...current };
                    delete next[column];
                    return next;
                  })
                }
              />
            ) : null}
          </View>
          <SelectField
            value={mappings[column] || null}
            options={TARGETS}
            onChange={(value) => setMappings((current) => ({ ...current, [column]: value as MappingTarget }))}
            compact
            disabled={!editable}
            status={duplicates.includes(mappings[column] as never) ? 'danger' : mappings[column] ? 'success' : 'warning'}
          />
        </GlassCard>
      ))}

      {editable ? (
        <GlassCard>
          <TextField label="Add source column" value={newColumn} onChangeText={setNewColumn} placeholder="Exact column header" />
          <AppButton
            label="Add column"
            variant="secondary"
            icon="add"
            disabled={!newColumn.trim() || newColumn.trim() in mappings}
            onPress={() => {
              setMappings((current) => ({ ...current, [newColumn.trim()]: '' }));
              setNewColumn('');
            }}
          />
        </GlassCard>
      ) : null}

      {error ? <Banner tone="danger" message={error} /> : null}
      {editable ? <AppButton label={profileId ? 'Save changes' : 'Create profile'} icon="save" loading={saving} disabled={!name.trim() || duplicates.length > 0} onPress={save} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
