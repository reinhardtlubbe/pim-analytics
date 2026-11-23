import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { Screen } from '../components/Screen';
import { AppButton, Banner, EmptyState, GlassCard, KeyValue, SectionTitle, StatusBadge } from '../components/ui';
import { RootScreenProps } from '../navigation/types';
import { toStructuredError } from '../services/errors';
import { compareForecastScenarios, deleteForecastScenario, listForecastScenarios } from '../services/forecasting/scenarioService';
import { useApp, useServices } from '../state/AppProvider';
import { useAsyncData } from '../state/useAsyncData';
import { formatDateTime, formatInteger, formatZar } from '../ui/format';
import { spacing, typography } from '../ui/theme';

export function ScenariosScreen({ navigation }: RootScreenProps<'Scenarios'>) {
  const { services, actor } = useServices();
  const { can } = useApp();
  const [compare, setCompare] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { data, loading, reload, error: loadError } = useAsyncData(() => listForecastScenarios(services), [services]);

  const remove = (scenarioId: number, name: string) => {
    Alert.alert('Delete scenario', `Delete "${name}" and its saved allocations? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteForecastScenario(services, actor, scenarioId);
            setCompare((current) => current.filter((id) => id !== scenarioId));
            await reload();
          } catch (caught) {
            setError(toStructuredError(caught).message);
          }
        },
      },
    ]);
  };

  const toggleCompare = (scenarioId: number) =>
    setCompare((current) => (current.includes(scenarioId) ? current.filter((id) => id !== scenarioId) : [...current, scenarioId].slice(-3)));

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      {loadError || error ? <Banner tone="danger" message={(loadError ?? error) as string} /> : null}
      {compare.length >= 2 ? (
        <AppButton label={`Compare ${compare.length} scenarios`} icon="git-compare" onPress={() => navigation.navigate('ScenarioCompare', { scenarioIds: compare })} />
      ) : (
        <Text style={typography.caption}>Select two or three scenarios to compare them side by side.</Text>
      )}
      {data && data.length === 0 ? <EmptyState icon="calculator" title="No saved scenarios" message="Build a forecast in the calculator and save it here." /> : null}
      {data?.map((scenario) => {
        const plan = scenario.allocationMode === 'manual' ? scenario.result.manual : scenario.result.recommended;
        return (
          <GlassCard key={scenario.scenarioId}>
            <View style={styles.row}>
              <Text style={[typography.subheading, styles.flex]}>{scenario.scenarioName}</Text>
              <StatusBadge label={scenario.allocationMode === 'manual' ? 'Manual' : 'Recommended'} tone="info" />
            </View>
            <Text style={typography.caption}>
              {scenario.clientName} · target {scenario.targetMonth} · {scenario.baselineWindow}-month baseline · updated {formatDateTime(scenario.updatedAt)}
            </Text>
            <KeyValue label="Budget" value={formatZar(scenario.totalBudgetZar)} />
            <KeyValue label="Expected clicks" value={plan ? formatInteger(plan.clicks.expected) : '—'} />
            <KeyValue label="Blended CPC" value={formatZar(plan?.blendedCpc ?? null)} />
            <View style={styles.row}>
              <AppButton label={compare.includes(scenario.scenarioId) ? 'Selected' : 'Compare'} compact variant={compare.includes(scenario.scenarioId) ? 'primary' : 'secondary'} icon="checkbox" onPress={() => toggleCompare(scenario.scenarioId)} style={styles.flex} />
              <AppButton label={can('scenarios.manage') ? 'Edit' : 'Open'} compact variant="secondary" icon="create" onPress={() => navigation.popTo('Main', { screen: 'Calculator', params: { scenarioId: scenario.scenarioId } })} style={styles.flex} />
              {can('scenarios.manage') ? <AppButton label="Delete" compact variant="danger" icon="trash" onPress={() => remove(scenario.scenarioId, scenario.scenarioName)} style={styles.flex} /> : null}
            </View>
          </GlassCard>
        );
      })}
    </Screen>
  );
}

export function ScenarioCompareScreen({ route }: RootScreenProps<'ScenarioCompare'>) {
  const { services } = useServices();
  const { data, error } = useAsyncData(() => compareForecastScenarios(services, route.params.scenarioIds), [services, route.params.scenarioIds.join(',')]);
  const rows: { label: string; value: (index: number) => string }[] = data
    ? [
        { label: 'Target month', value: (index) => data[index].targetMonth },
        { label: 'Allocation', value: (index) => (data[index].mode === 'manual' ? 'Manual' : 'Recommended') },
        { label: 'Budget', value: (index) => formatZar(data[index].totalBudgetZar) },
        { label: 'Expected clicks', value: (index) => formatInteger(data[index].expectedClicks) },
        { label: 'Click range', value: (index) => (data[index].clickRange ? `${formatInteger(data[index].clickRange!.low)}–${formatInteger(data[index].clickRange!.high)}` : '—') },
        { label: 'Expected impressions', value: (index) => formatInteger(data[index].expectedImpressions) },
        { label: 'Expected conversions', value: (index) => (data[index].expectedConversions === null ? 'n/a' : formatInteger(data[index].expectedConversions)) },
        { label: 'Blended CPC', value: (index) => formatZar(data[index].blendedCpc) },
      ]
    : [];
  return (
    <Screen>
      {error ? <Banner tone="danger" message={error} /> : null}
      {data ? (
        <GlassCard>
          <SectionTitle title="Scenario comparison" />
          <View style={styles.compareRow}>
            <Text style={[typography.label, styles.compareLabel]}> </Text>
            {data.map((scenario) => (
              <Text key={scenario.scenarioId} style={[typography.subheading, styles.compareCell]} numberOfLines={2}>
                {scenario.scenarioName}
              </Text>
            ))}
          </View>
          {rows.map((row) => (
            <View key={row.label} style={styles.compareRow}>
              <Text style={[typography.caption, styles.compareLabel]}>{row.label}</Text>
              {data.map((scenario, index) => (
                <Text key={scenario.scenarioId} style={[typography.tabular, styles.compareCell]}>
                  {row.value(index)}
                </Text>
              ))}
            </View>
          ))}
        </GlassCard>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  compareRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 6 },
  compareLabel: { width: 100 },
  compareCell: { flex: 1, textAlign: 'right' },
});
