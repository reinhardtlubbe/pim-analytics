import { RouteProp, useNavigation, useRoute } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Screen } from '../components/Screen';
import { AppButton, Banner, Chip, Divider, GlassCard, KeyValue, SectionTitle, SelectField, StatusBadge, TextField } from '../components/ui';
import { AccountView, ClientRow } from '../database/models';
import { MainTabParamList, RootStackParamList } from '../navigation/types';
import { toStructuredError } from '../services/errors';
import { AllocationPlan, BaselineWindow, ForecastResult, manualAllocation, reverseCalculate, ReverseCalculationResult } from '../services/forecasting/forecastEngine';
import { listForecastChannels } from '../services/forecasting/historicalService';
import { getForecastScenario, runScenarioForecast, saveForecastScenario, ScenarioInput, updateForecastScenario } from '../services/forecasting/scenarioService';
import { listAccounts, listClients } from '../services/reference/referenceService';
import { useApp, useServices } from '../state/AppProvider';
import { formatDecimal, formatInteger, formatPercent, formatZar, nextMonth } from '../ui/format';
import { colors, spacing, typography } from '../ui/theme';

type Channel = { key: string; platform: string; campaignType: string; months: number };

export function CalculatorScreen() {
  const route = useRoute<RouteProp<MainTabParamList, 'Calculator'>>();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { services, actor } = useServices();
  const { can } = useApp();
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [clientId, setClientId] = useState<number | null>(null);
  const [accountId, setAccountId] = useState<number>(-1);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [targetMonth, setTargetMonth] = useState(nextMonth());
  const [budgetText, setBudgetText] = useState('100000');
  const [window, setWindow] = useState<BaselineWindow>(6);
  const [mode, setMode] = useState<'recommended' | 'manual'>('recommended');
  const [manual, setManual] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ForecastResult | null>(null);
  const [manualPlan, setManualPlan] = useState<AllocationPlan | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [goal, setGoal] = useState<'clicks' | 'conversions'>('clicks');
  const [goalText, setGoalText] = useState('');
  const [reverse, setReverse] = useState<ReverseCalculationResult | null>(null);
  const [scenarioName, setScenarioName] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [pendingSelection, setPendingSelection] = useState<string[] | null>(null);

  useEffect(() => {
    Promise.all([listClients(services), listAccounts(services)])
      .then(([clientRows, accountRows]) => {
        setClients(clientRows);
        setAccounts(accountRows);
        setClientId((current) => current ?? clientRows[0]?.client_id ?? null);
      })
      .catch((caught) => setError(toStructuredError(caught).message));
  }, [services]);

  useEffect(() => {
    const scenarioId = route.params?.scenarioId;
    if (!scenarioId) {
      return;
    }
    getForecastScenario(services, scenarioId)
      .then((scenario) => {
        const input = scenario.parameters;
        setEditingId(scenario.scenarioId);
        setScenarioName(scenario.scenarioName);
        setClientId(input.clientId);
        setAccountId(input.accountId ?? -1);
        setTargetMonth(input.targetMonth);
        setBudgetText(String(input.totalBudgetZar));
        setWindow(input.baselineWindow);
        setMode(input.allocationMode);
        setManual(Object.fromEntries(Object.entries(input.manualPercentages ?? {}).map(([key, value]) => [key, String(value)])));
        setPendingSelection(input.channelKeys);
      })
      .catch((caught) => setError(toStructuredError(caught).message));
  }, [services, route.params?.scenarioId]);

  useEffect(() => {
    if (!clientId) {
      return;
    }
    let cancelled = false;
    listForecastChannels(services, clientId, accountId === -1 ? null : accountId)
      .then((rows) => {
        if (cancelled) {
          return;
        }
        setChannels(rows);
        if (pendingSelection) {
          setSelected(pendingSelection.filter((key) => rows.some((row) => row.key === key)));
          setPendingSelection(null);
          return;
        }
        setSelected((current) => {
          const valid = current.filter((key) => rows.some((row) => row.key === key));
          return valid.length ? valid : rows.map((row) => row.key);
        });
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(toStructuredError(caught).message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [services, clientId, accountId, pendingSelection]);

  const budget = Number(budgetText.replace(/[\s,]/g, ''));
  const manualPercentages = useMemo(
    () => Object.fromEntries(selected.map((key) => [key, Number(manual[key] ?? '0') || 0])),
    [selected, manual],
  );
  const manualTotal = Object.values(manualPercentages).reduce((sum, value) => sum + value, 0);

  const input: ScenarioInput | null = clientId
    ? {
        scenarioName: scenarioName || 'Untitled scenario',
        clientId,
        accountId: accountId === -1 ? null : accountId,
        targetMonth,
        totalBudgetZar: budget,
        baselineWindow: window,
        channelKeys: selected,
        allocationMode: mode,
        manualPercentages: mode === 'manual' ? manualPercentages : null,
      }
    : null;

  useEffect(() => {
    if (!input || !selected.length) {
      setResult(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setError(null);
      try {
        const forecast = await runScenarioForecast(services, { ...input, allocationMode: 'recommended', manualPercentages: null });
        if (cancelled) {
          return;
        }
        setResult(forecast);
        if (mode === 'manual') {
          try {
            setManualPlan(manualAllocation(forecast.channels, budget, Object.fromEntries(Object.entries(manualPercentages).filter(([key]) => forecast.channels.some((channel) => channel.key === key)))));
            setManualError(null);
          } catch (caught) {
            setManualPlan(null);
            setManualError(toStructuredError(caught).message);
          }
        } else {
          setManualPlan(null);
          setManualError(null);
        }
      } catch (caught) {
        if (!cancelled) {
          setResult(null);
          setError(toStructuredError(caught).message);
        }
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [services, clientId, accountId, targetMonth, budget, window, mode, JSON.stringify(manualPercentages), selected.join('|')]);

  useEffect(() => {
    const target = Number(goalText.replace(/[\s,]/g, ''));
    if (!result || !goalText || !Number.isFinite(target) || target <= 0) {
      setReverse(null);
      return;
    }
    try {
      setReverse(reverseCalculate(result.channels, goal, target));
    } catch (caught) {
      setReverse({ goal, target, requiredBudget: null, plan: null, warnings: [toStructuredError(caught).message] });
    }
  }, [result, goal, goalText]);

  const seedManualFromRecommended = () => {
    if (!result?.recommended) {
      return;
    }
    const next: Record<string, string> = {};
    selected.forEach((key) => {
      next[key] = String(result.recommended?.lines.find((line) => line.key === key)?.percentage ?? 0);
    });
    setManual(next);
  };

  const adjust = (key: string, delta: number) => {
    setManual((current) => {
      const value = Math.min(100, Math.max(0, (Number(current[key] ?? '0') || 0) + delta));
      return { ...current, [key]: String(Math.round(value * 100) / 100) };
    });
  };

  const save = async (asNew: boolean) => {
    if (!input) {
      return;
    }
    setSaving(true);
    setSaveMessage(null);
    try {
      const payload = { ...input, scenarioName: scenarioName.trim() };
      const saved = editingId && !asNew ? await updateForecastScenario(services, actor, editingId, payload) : await saveForecastScenario(services, actor, payload);
      setEditingId(saved.scenarioId);
      setSaveMessage({ tone: 'success', text: `Scenario "${saved.scenarioName}" ${editingId && !asNew ? 'updated' : 'saved'} to the database.` });
    } catch (caught) {
      setSaveMessage({ tone: 'danger', text: toStructuredError(caught).message });
    } finally {
      setSaving(false);
    }
  };

  const activePlan = mode === 'manual' ? manualPlan : result?.recommended ?? null;
  const accountOptions = [{ value: -1, label: 'All accounts' }, ...accounts.filter((account) => account.client_id === clientId).map((account) => ({ value: account.account_id, label: `${account.supplier_name} · ${account.account_name}` }))];

  return (
    <Screen>
      <GlassCard>
        <SectionTitle
          title={editingId ? `Editing scenario #${editingId}` : 'Budget calculator'}
          subtitle="Forecasts use accepted, eligible SQLite records only"
          right={<AppButton label="Saved" compact variant="ghost" icon="folder-open" onPress={() => navigation.navigate('Scenarios')} />}
        />
        <SelectField label="Client" value={clientId} options={clients.map((client) => ({ value: client.client_id, label: client.client_name }))} onChange={(value) => setClientId(value)} />
        <SelectField label="Advertising account" value={accountId} options={accountOptions} onChange={(value) => setAccountId(value)} />
        <View style={styles.row}>
          <View style={styles.flex}>
            <TextField label="Total budget (ZAR)" value={budgetText} onChangeText={setBudgetText} keyboardType="decimal-pad" error={budgetText && !(budget > 0) ? 'Enter an amount above zero' : null} />
          </View>
          <View style={styles.flex}>
            <TextField
              label="Target month"
              value={targetMonth}
              onChangeText={setTargetMonth}
              placeholder="YYYY-MM"
              autoCapitalize="none"
              error={/^\d{4}-(0[1-9]|1[0-2])$/.test(targetMonth) ? null : 'Use YYYY-MM'}
            />
          </View>
        </View>
        <Text style={typography.label}>Historical baseline</Text>
        <View style={styles.row}>
          {[3, 6, 12].map((value) => (
            <Chip key={value} label={`Last ${value} months`} active={window === value} onPress={() => setWindow(value as BaselineWindow)} />
          ))}
        </View>
        <Text style={typography.label}>Platforms and campaign types</Text>
        {channels.length === 0 ? <Text style={typography.body}>No eligible processed records exist for this client yet.</Text> : null}
        <View style={styles.wrap}>
          {channels.map((channel) => (
            <Chip
              key={channel.key}
              label={`${channel.platform} · ${channel.campaignType}`}
              active={selected.includes(channel.key)}
              onPress={() => setSelected((current) => (current.includes(channel.key) ? current.filter((key) => key !== channel.key) : [...current, channel.key]))}
            />
          ))}
        </View>
      </GlassCard>

      {error ? <Banner tone="danger" message={error} /> : null}
      {result?.warnings.map((warning, index) => <Banner key={index} tone="warning" message={warning} />)}

      {result && result.channels.length ? (
        <GlassCard>
          <SectionTitle title="Historical baseline" subtitle={`${result.windowMonths[0]} to ${result.anchorMonth}`} />
          {result.channels.map((channel) => (
            <View key={channel.key} style={styles.channel}>
              <View style={styles.row}>
                <Text style={[typography.subheading, styles.flex]}>
                  {channel.platform} · {channel.campaignType}
                </Text>
                <StatusBadge label={`${channel.monthsCovered} mo`} tone={channel.monthsCovered >= 3 ? 'success' : 'warning'} />
              </View>
              <View style={styles.metricRow}>
                <MetricCell label="CPC" value={channel.metrics.cpc.value !== null ? formatZar(channel.metrics.cpc.value) : 'n/a'} />
                <MetricCell label="CPM" value={channel.metrics.cpm.value !== null ? formatZar(channel.metrics.cpm.value) : 'n/a'} />
                <MetricCell label="CTR" value={formatPercent(channel.metrics.ctr.value)} />
                <MetricCell label="Conv. rate" value={channel.metrics.conversionRate.value !== null ? formatPercent(channel.metrics.conversionRate.value) : 'n/a'} />
              </View>
              <Text style={typography.caption}>{channel.seasonality.explanation}</Text>
              <Text style={typography.caption}>{channel.diminishingReturns.explanation}</Text>
              {channel.metrics.cpc.unavailableReason ? <Text style={typography.caption}>{channel.metrics.cpc.unavailableReason}</Text> : null}
              <Divider />
            </View>
          ))}
        </GlassCard>
      ) : null}

      {result ? (
        <GlassCard>
          <View style={styles.row}>
            <Chip label="Recommended split" active={mode === 'recommended'} onPress={() => setMode('recommended')} icon="sparkles" />
            <Chip
              label="Manual split"
              active={mode === 'manual'}
              icon="options"
              onPress={() => {
                setMode('manual');
                if (!Object.keys(manual).length) {
                  seedManualFromRecommended();
                }
              }}
            />
          </View>
          {mode === 'manual' ? (
            <>
              {selected
                .filter((key) => result.channels.some((channel) => channel.key === key))
                .map((key) => (
                  <View key={key} style={styles.manualRow}>
                    <Text style={[typography.body, styles.flex]} numberOfLines={1}>
                      {key.replace('::', ' · ')}
                    </Text>
                    <AppButton label="−5" compact variant="secondary" onPress={() => adjust(key, -5)} />
                    <View style={styles.percentInput}>
                      <TextField label="%" value={manual[key] ?? '0'} onChangeText={(text) => setManual((current) => ({ ...current, [key]: text }))} keyboardType="decimal-pad" />
                    </View>
                    <AppButton label="+5" compact variant="secondary" onPress={() => adjust(key, 5)} />
                  </View>
                ))}
              <View style={styles.row}>
                <Text style={[typography.subheading, styles.flex, { color: Math.abs(manualTotal - 100) <= 0.01 ? colors.success : colors.warning }]}>Total {formatDecimal(manualTotal)}%</Text>
                <AppButton label="Copy recommended" compact variant="ghost" onPress={seedManualFromRecommended} />
              </View>
              {manualError ? <Banner tone="warning" message={manualError} /> : null}
            </>
          ) : null}
          {activePlan ? <PlanView plan={activePlan} /> : null}
        </GlassCard>
      ) : null}

      {result?.recommended && manualPlan ? (
        <GlassCard>
          <SectionTitle title="Recommended vs manual" />
          <ComparisonRow label="" left="Recommended" right="Manual" />
          <ComparisonRow label="Allocated budget" left={formatZar(result.recommended.allocatedBudget)} right={formatZar(manualPlan.allocatedBudget)} />
          <ComparisonRow label="Expected clicks" left={formatInteger(result.recommended.clicks.expected)} right={formatInteger(manualPlan.clicks.expected)} />
          <ComparisonRow label="Expected impressions" left={formatInteger(result.recommended.impressions.expected)} right={formatInteger(manualPlan.impressions.expected)} />
          <ComparisonRow
            label="Expected conversions"
            left={result.recommended.conversions ? formatInteger(result.recommended.conversions.expected) : 'n/a'}
            right={manualPlan.conversions ? formatInteger(manualPlan.conversions.expected) : 'n/a'}
          />
          <ComparisonRow label="Blended CPC" left={formatZar(result.recommended.blendedCpc)} right={formatZar(manualPlan.blendedCpc)} />
        </GlassCard>
      ) : null}

      {result ? (
        <GlassCard>
          <SectionTitle title="Reverse calculation" subtitle="Estimate the budget needed for a target" />
          <View style={styles.row}>
            <Chip label="Clicks" active={goal === 'clicks'} onPress={() => setGoal('clicks')} />
            <Chip label="Conversions" active={goal === 'conversions'} onPress={() => setGoal('conversions')} />
          </View>
          <TextField label={`Desired ${goal}`} value={goalText} onChangeText={setGoalText} keyboardType="number-pad" />
          {reverse?.requiredBudget ? (
            <KeyValue label="Estimated budget required" value={formatZar(reverse.requiredBudget)} valueTone="success" />
          ) : null}
          {reverse?.warnings.map((warning, index) => <Banner key={index} tone="warning" message={warning} />)}
        </GlassCard>
      ) : null}

      {result ? (
        <GlassCard>
          <SectionTitle title="Assumptions" />
          {result.assumptions.map((assumption, index) => (
            <Text key={index} style={typography.caption}>
              • {assumption}
            </Text>
          ))}
        </GlassCard>
      ) : null}

      {result && can('scenarios.manage') ? (
        <GlassCard>
          <TextField label="Scenario name" value={scenarioName} onChangeText={setScenarioName} placeholder="e.g. Festive push" />
          <View style={styles.row}>
            <AppButton label={editingId ? 'Update scenario' : 'Save scenario'} icon="save" loading={saving} disabled={!scenarioName.trim() || !activePlan} onPress={() => save(false)} style={styles.flex} />
            {editingId ? <AppButton label="Save as new" variant="secondary" icon="copy" disabled={!scenarioName.trim() || !activePlan} onPress={() => save(true)} style={styles.flex} /> : null}
          </View>
          {saveMessage ? <Banner tone={saveMessage.tone} message={saveMessage.text} /> : null}
        </GlassCard>
      ) : null}
    </Screen>
  );
}

function MetricCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metricCell}>
      <Text style={typography.caption}>{label}</Text>
      <Text style={typography.tabular}>{value}</Text>
    </View>
  );
}

function ComparisonRow({ label, left, right }: { label: string; left: string; right: string }) {
  return (
    <View style={styles.comparison}>
      <Text style={[typography.body, styles.flex]}>{label}</Text>
      <Text style={[typography.tabular, styles.comparisonValue]}>{left}</Text>
      <Text style={[typography.tabular, styles.comparisonValue]}>{right}</Text>
    </View>
  );
}

function PlanView({ plan }: { plan: AllocationPlan }) {
  return (
    <View style={styles.plan}>
      {plan.lines.map((line) => (
        <View key={line.key} style={styles.planLine}>
          <View style={styles.row}>
            <Text style={[typography.subheading, styles.flex]}>
              {line.platform} · {line.campaignType}
            </Text>
            <Text style={typography.tabular}>{formatPercent(line.percentage)}</Text>
          </View>
          <View style={styles.metricRow}>
            <MetricCell label="Budget" value={formatZar(line.amount)} />
            <MetricCell label="Clicks" value={line.clicks ? formatInteger(line.clicks.expected) : 'n/a'} />
            <MetricCell label="Impr." value={line.impressions ? formatInteger(line.impressions.expected) : 'n/a'} />
            <MetricCell label="CPC" value={formatZar(line.expectedCpc)} />
          </View>
          {line.notes.map((note, index) => (
            <Text key={index} style={[typography.caption, { color: colors.warning }]}>
              {note}
            </Text>
          ))}
        </View>
      ))}
      <Divider />
      <KeyValue label="Total allocated" value={formatZar(plan.allocatedBudget)} />
      <KeyValue label="Clicks (low / expected / high)" value={`${formatInteger(plan.clicks.low)} / ${formatInteger(plan.clicks.expected)} / ${formatInteger(plan.clicks.high)}`} />
      <KeyValue
        label="Impressions (low / expected / high)"
        value={`${formatInteger(plan.impressions.low)} / ${formatInteger(plan.impressions.expected)} / ${formatInteger(plan.impressions.high)}`}
      />
      <KeyValue label="Conversions" value={plan.conversions ? formatInteger(plan.conversions.expected) : 'Not supported by data'} />
      <KeyValue label="Blended CPC" value={formatZar(plan.blendedCpc)} />
      {plan.warnings.map((warning, index) => (
        <Banner key={index} tone="warning" message={warning} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  channel: { gap: 6 },
  metricRow: { flexDirection: 'row', gap: spacing.sm },
  metricCell: { flex: 1 },
  manualRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  percentInput: { width: 80 },
  plan: { gap: spacing.sm },
  planLine: { gap: 6, paddingVertical: 6 },
  comparison: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 4 },
  comparisonValue: { width: 100, textAlign: 'right' },
});
