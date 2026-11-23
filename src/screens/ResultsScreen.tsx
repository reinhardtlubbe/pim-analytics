import { RouteProp, useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { GradientBackground } from '../components/Screen';
import { AppButton, Banner, Chip, EmptyState, GlassCard, SelectField, StatusBadge, TextField } from '../components/ui';
import { ClientRow, MediaRecordRow } from '../database/models';
import { MainTabParamList, RootStackParamList } from '../navigation/types';
import { shareExportedFile } from '../platform/expoPlatform';
import { toStructuredError } from '../services/errors';
import { exportCleanData, ExportFormat } from '../services/reporting/exportService';
import { getFilterOptions, getProcessingResults, ResultsFilter, ResultsSortField, ResultsTotals } from '../services/reporting/resultsService';
import { listClients } from '../services/reference/referenceService';
import { useApp, useServices } from '../state/AppProvider';
import { formatInteger, formatZar } from '../ui/format';
import { colors, radius, spacing, typography } from '../ui/theme';

const SORTS: { key: ResultsSortField; label: string }[] = [
  { key: 'report_month', label: 'Month' },
  { key: 'spend_zar', label: 'Spend' },
  { key: 'impressions', label: 'Impressions' },
  { key: 'clicks', label: 'Clicks' },
  { key: 'conversions', label: 'Conversions' },
  { key: 'campaign_name', label: 'Campaign' },
];

const ALL = '__all__';

export function ResultsScreen() {
  const route = useRoute<RouteProp<MainTabParamList, 'Results'>>();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { services, actor } = useServices();
  const { can } = useApp();
  const runId = route.params?.runId;
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [clientId, setClientId] = useState<number | null>(null);
  const [options, setOptions] = useState<{ platforms: string[]; campaignTypes: string[]; months: string[] }>({ platforms: [], campaignTypes: [], months: [] });
  const [platform, setPlatform] = useState<string>(ALL);
  const [campaignType, setCampaignType] = useState<string>(ALL);
  const [monthFrom, setMonthFrom] = useState<string>(ALL);
  const [monthTo, setMonthTo] = useState<string>(ALL);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<ResultsSortField>('report_month');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [items, setItems] = useState<MediaRecordRow[]>([]);
  const [totals, setTotals] = useState<ResultsTotals | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);

  useEffect(() => {
    const handle = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  useEffect(() => {
    listClients(services).then(setClients).catch(() => undefined);
  }, [services]);

  useEffect(() => {
    getFilterOptions(services, clientId ?? undefined)
      .then(setOptions)
      .catch(() => undefined);
  }, [services, clientId, runId]);

  const filter: ResultsFilter = useMemo(
    () => ({
      runId,
      clientId: clientId ?? undefined,
      platform: platform === ALL ? undefined : platform,
      campaignType: campaignType === ALL ? undefined : campaignType,
      monthFrom: monthFrom === ALL ? undefined : monthFrom,
      monthTo: monthTo === ALL ? undefined : monthTo,
      search: search || undefined,
    }),
    [runId, clientId, platform, campaignType, monthFrom, monthTo, search],
  );

  const requestId = useRef(0);
  const load = useCallback(
    async (targetPage: number) => {
      const current = ++requestId.current;
      if (targetPage === 1) {
        setPage(1);
      }
      setLoading(true);
      setError(null);
      try {
        const result = await getProcessingResults(services, { ...filter, sort, direction, page: targetPage, pageSize: 25 });
        if (current !== requestId.current) {
          return;
        }
        setTotals(result.totals);
        setTotalPages(result.totalPages);
        setPage(result.page);
        setItems((existing) => (targetPage === 1 ? result.items : [...existing, ...result.items]));
      } catch (caught) {
        if (current === requestId.current) {
          setError(toStructuredError(caught).message);
        }
      } finally {
        if (current === requestId.current) {
          setLoading(false);
        }
      }
    },
    [services, filter, sort, direction],
  );

  useFocusEffect(
    useCallback(() => {
      load(1);
      getFilterOptions(services, clientId ?? undefined)
        .then(setOptions)
        .catch(() => undefined);
    }, [load, services, clientId]),
  );

  const toggleSort = (key: ResultsSortField) => {
    if (key === sort) {
      setDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
    } else {
      setSort(key);
      setDirection(key === 'campaign_name' ? 'asc' : 'desc');
    }
  };

  const runExport = async (format: ExportFormat) => {
    setExporting(format);
    setExportMessage(null);
    setError(null);
    try {
      const result = await exportCleanData(services, actor, filter, format);
      const shared = await shareExportedFile(result.uri, result.mimeType, 'Share clean campaign data');
      setExportMessage(`${result.filename}: ${formatInteger(result.rowCount)} records, ${formatZar(result.spendZarTotal)} total spend.${shared ? '' : ' Sharing is unavailable on this device; the file is saved in app storage.'}`);
    } catch (caught) {
      setError(toStructuredError(caught).message);
    } finally {
      setExporting(null);
    }
  };

  const monthOptions = [{ value: ALL, label: 'Any month' }, ...options.months.map((month) => ({ value: month, label: month }))];

  const header = (
    <View style={styles.headerContent}>
      {runId ? (
        <Banner tone="info" message={`Showing records from run #${runId} only.`} />
      ) : null}
      {runId ? <AppButton label="Show all active records" variant="ghost" compact onPress={() => navigation.setParams({ runId: undefined } as never)} /> : null}
      <GlassCard>
        <TextField label="Search" value={searchInput} onChangeText={setSearchInput} placeholder="Campaign, ad group, placement, objective…" autoCapitalize="none" />
        <SelectField
          label="Client"
          value={clientId ?? -1}
          options={[{ value: -1, label: 'All clients' }, ...clients.map((client) => ({ value: client.client_id, label: client.client_name }))]}
          onChange={(value) => setClientId(value === -1 ? null : value)}
        />
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          <Chip label="All platforms" active={platform === ALL} onPress={() => setPlatform(ALL)} />
          {options.platforms.map((value) => (
            <Chip key={value} label={value} active={platform === value} onPress={() => setPlatform(value)} />
          ))}
        </ScrollView>
        <SelectField
          label="Campaign type"
          value={campaignType}
          options={[{ value: ALL, label: 'All campaign types' }, ...options.campaignTypes.map((value) => ({ value, label: value }))]}
          onChange={setCampaignType}
        />
        <View style={styles.row}>
          <View style={styles.flex}>
            <SelectField label="From" value={monthFrom} options={monthOptions} onChange={setMonthFrom} />
          </View>
          <View style={styles.flex}>
            <SelectField label="To" value={monthTo} options={monthOptions} onChange={setMonthTo} />
          </View>
        </View>
        <Text style={typography.label}>Sort</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {SORTS.map((item) => (
            <Chip
              key={item.key}
              label={item.label}
              active={sort === item.key}
              icon={sort === item.key ? (direction === 'asc' ? 'arrow-up' : 'arrow-down') : undefined}
              onPress={() => toggleSort(item.key)}
            />
          ))}
        </ScrollView>
      </GlassCard>

      {totals ? (
        <GlassCard>
          <Text style={typography.label}>Totals for current filters</Text>
          <View style={styles.totalsGrid}>
            <Total label="Records" value={formatInteger(totals.recordCount)} />
            <Total label="Spend (ZAR)" value={formatZar(totals.spendZar)} />
            <Total label="Impressions" value={formatInteger(totals.impressions)} />
            <Total label="Clicks" value={formatInteger(totals.clicks)} />
            <Total label="Conversions" value={totals.conversions === null ? 'Not in data' : formatInteger(totals.conversions)} />
          </View>
          {totals.missingClickRecords ? <Text style={typography.caption}>{formatInteger(totals.missingClickRecords)} records have no click value (kept blank, not zero).</Text> : null}
          {totals.spendExcludedRecords ? <Text style={typography.caption}>{formatInteger(totals.spendExcludedRecords)} records lack a ZAR conversion and are excluded from spend.</Text> : null}
        </GlassCard>
      ) : null}

      {can('reports.export') ? (
        <View style={styles.row}>
          <AppButton label="Export CSV" icon="download" variant="secondary" onPress={() => runExport('csv')} loading={exporting === 'csv'} disabled={!totals?.recordCount} style={styles.flex} />
          <AppButton label="Export XLSX" icon="grid" variant="secondary" onPress={() => runExport('xlsx')} loading={exporting === 'xlsx'} disabled={!totals?.recordCount} style={styles.flex} />
        </View>
      ) : null}
      {exportMessage ? <Banner tone="success" message={exportMessage} /> : null}
      {error ? <Banner tone="danger" message={error} /> : null}
    </View>
  );

  return (
    <GradientBackground>
      <SafeAreaView style={styles.flex} edges={['left', 'right']}>
        <FlatList
          data={items}
          keyExtractor={(item) => String(item.record_id)}
          ListHeaderComponent={header}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => <RecordCard record={item} />}
          onEndReachedThreshold={0.4}
          onEndReached={() => {
            if (!loading && page < totalPages) {
              load(page + 1);
            }
          }}
          refreshControl={<RefreshControl refreshing={loading && page === 1} onRefresh={() => load(1)} tintColor={colors.primary} />}
          ListEmptyComponent={
            loading ? undefined : <EmptyState icon="search" title="No records" message="No stored records match these filters. Import and process a file to populate the database." />
          }
          ListFooterComponent={loading && page > 1 ? <ActivityIndicator color={colors.primary} style={styles.footerSpinner} /> : <View style={styles.footerSpacer} />}
          initialNumToRender={12}
          windowSize={7}
          removeClippedSubviews
          keyboardShouldPersistTaps="handled"
        />
      </SafeAreaView>
    </GradientBackground>
  );
}

function Total({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.total}>
      <Text style={typography.caption}>{label}</Text>
      <Text style={[typography.tabular, styles.totalValue]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
    </View>
  );
}

const RecordCard = React.memo(function RecordCard({ record }: { record: MediaRecordRow }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Pressable onPress={() => setExpanded((value) => !value)} accessibilityRole="button" accessibilityHint="Shows the original source values">
      <GlassCard style={styles.recordCard}>
        <View style={styles.row}>
          <Text style={[typography.subheading, styles.flex]} numberOfLines={1}>
            {record.campaign_name ?? `${record.source_objective} · ${record.placement ?? 'All placements'}`}
          </Text>
          <Text style={typography.caption}>{record.report_month}</Text>
        </View>
        <View style={styles.badges}>
          <StatusBadge label={record.platform} tone="info" icon="globe" />
          <StatusBadge label={record.campaign_type} tone={record.campaign_type === 'Unknown' ? 'warning' : 'muted'} icon="pricetag" />
          {record.duplicate_flag === 'potential_business_key' ? <StatusBadge label="Possible duplicate" tone="warning" /> : null}
        </View>
        <View style={styles.metrics}>
          <Metric label="Spend" value={formatZar(record.spend_zar)} />
          <Metric label="Impr." value={formatInteger(record.impressions)} />
          <Metric label={record.click_metric_type === 'link_click' ? 'Link clicks' : record.click_metric_type === 'destination_click' ? 'Dest. clicks' : 'Clicks'} value={record.clicks === null ? 'Missing' : formatInteger(record.clicks)} />
        </View>
        {expanded ? (
          <View style={styles.sourceBox}>
            <Text style={typography.caption}>
              Source row {record.source_row_number} · run #{record.run_id} · {record.account_name} · {record.currency}
              {record.ad_group_name ? ` · ${record.ad_group_name}` : ''}
            </Text>
            <Text style={[typography.caption, styles.mono]}>{record.source_data_json}</Text>
          </View>
        ) : null}
      </GlassCard>
    </Pressable>
  );
});

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={typography.caption}>{label}</Text>
      <Text style={typography.tabular}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { padding: spacing.lg, gap: spacing.md },
  headerContent: { gap: spacing.md, marginBottom: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  chips: { gap: spacing.sm, paddingVertical: 2 },
  totalsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  total: { minWidth: '28%', flexGrow: 1 },
  totalValue: { fontSize: 15, fontWeight: '700' },
  recordCard: { gap: spacing.sm },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  metrics: { flexDirection: 'row', gap: spacing.md },
  metric: { flex: 1 },
  sourceBox: { backgroundColor: colors.inputBackground, borderRadius: radius.sm, padding: spacing.sm, gap: 4 },
  mono: { fontFamily: typography.tabular.fontFamily },
  footerSpinner: { marginVertical: spacing.lg },
  footerSpacer: { height: spacing.xxl },
});
