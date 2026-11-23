import { ForecastAllocationRow, ForecastScenarioRow } from '../../database/models';
import { Db } from '../../database/types';
import { parseJson } from '../../utils/async';
import { recordAuditEvent } from '../audit/auditService';
import { Actor, requirePermission } from '../auth/permissions';
import { isoNow, ServiceContext } from '../context';
import { ServiceError } from '../errors';
import { AllocationPlan, BaselineWindow, calculateBudgetForecast, ForecastResult } from './forecastEngine';
import { loadChannelHistories } from './historicalService';

export interface ScenarioInput {
  scenarioName: string;
  clientId: number;
  accountId?: number | null;
  targetMonth: string;
  totalBudgetZar: number;
  baselineWindow: BaselineWindow;
  channelKeys: string[];
  allocationMode: 'recommended' | 'manual';
  manualPercentages?: Record<string, number> | null;
}

export interface SavedScenario {
  scenarioId: number;
  scenarioName: string;
  clientId: number;
  clientName: string;
  accountId: number | null;
  targetMonth: string;
  totalBudgetZar: number;
  baselineWindow: BaselineWindow;
  allocationMode: 'recommended' | 'manual';
  parameters: ScenarioInput;
  result: ForecastResult;
  allocations: ForecastAllocationRow[];
  createdAt: string;
  updatedAt: string;
}

export async function runScenarioForecast(ctx: ServiceContext, input: ScenarioInput): Promise<ForecastResult> {
  if (!input.channelKeys.length) {
    throw new ServiceError('VALIDATION', 'Select at least one platform and campaign type.');
  }
  const histories = await loadChannelHistories(ctx, { clientId: input.clientId, accountId: input.accountId, channelKeys: input.channelKeys });
  return calculateBudgetForecast({
    totalBudget: input.totalBudgetZar,
    targetMonth: input.targetMonth,
    window: input.baselineWindow,
    histories,
    manualPercentages: input.allocationMode === 'manual' ? (input.manualPercentages ?? {}) : null,
  });
}

function validateScenarioInput(input: ScenarioInput): void {
  if (!input.scenarioName.trim()) {
    throw new ServiceError('VALIDATION', 'Enter a scenario name.', { field: 'scenarioName' });
  }
  if (input.allocationMode === 'manual' && !input.manualPercentages) {
    throw new ServiceError('VALIDATION', 'Manual allocation needs a percentage for each channel.');
  }
}

async function writeAllocations(db: Db, scenarioId: number, plans: (AllocationPlan | null)[]): Promise<void> {
  await db.run('DELETE FROM forecast_allocations WHERE scenario_id = ?', [scenarioId]);
  for (const plan of plans) {
    if (!plan) {
      continue;
    }
    for (const line of plan.lines) {
      await db.run(
        `INSERT INTO forecast_allocations (scenario_id, allocation_type, platform, campaign_type, allocation_percentage, allocated_budget_zar,
          projected_clicks, projected_impressions, projected_conversions, projected_cpc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          scenarioId,
          plan.mode,
          line.platform,
          line.campaignType,
          line.percentage,
          line.amount,
          line.clicks?.expected ?? null,
          line.impressions?.expected ?? null,
          line.conversions?.expected ?? null,
          line.expectedCpc,
        ],
      );
    }
  }
}

async function assertClient(ctx: ServiceContext, clientId: number): Promise<void> {
  const client = await ctx.db.first('SELECT client_id FROM clients WHERE client_id = ?', [clientId]);
  if (!client) {
    throw new ServiceError('VALIDATION', 'Choose a valid client.');
  }
}

export async function saveForecastScenario(ctx: ServiceContext, actor: Actor, input: ScenarioInput): Promise<SavedScenario> {
  requirePermission(actor, 'scenarios.manage');
  validateScenarioInput(input);
  await assertClient(ctx, input.clientId);
  const result = await runScenarioForecast(ctx, input);
  if (!result.recommended && !result.manual) {
    throw new ServiceError('INSUFFICIENT_DATA', result.warnings[0] ?? 'There is not enough eligible history to save a forecast.');
  }
  const now = isoNow(ctx);
  const scenarioId = await ctx.db.transaction(async (tx) => {
    const inserted = await tx.run(
      `INSERT INTO forecast_scenarios (scenario_name, client_id, account_id, target_month, total_budget_zar, baseline_window, allocation_mode,
        scenario_parameters_json, results_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.scenarioName.trim(),
        input.clientId,
        input.accountId ?? null,
        input.targetMonth,
        input.totalBudgetZar,
        input.baselineWindow,
        input.allocationMode,
        JSON.stringify(input),
        JSON.stringify(result),
        actor.userId,
        now,
        now,
      ],
    );
    await writeAllocations(tx, inserted.lastInsertRowId, [result.recommended, result.manual]);
    await recordAuditEvent(
      tx,
      { eventType: 'scenario.created', message: `Forecast scenario "${input.scenarioName.trim()}" saved.`, userId: actor.userId, entityType: 'scenario', entityId: inserted.lastInsertRowId },
      now,
    );
    return inserted.lastInsertRowId;
  });
  return getForecastScenario(ctx, scenarioId);
}

export async function updateForecastScenario(ctx: ServiceContext, actor: Actor, scenarioId: number, input: ScenarioInput): Promise<SavedScenario> {
  requirePermission(actor, 'scenarios.manage');
  validateScenarioInput(input);
  await assertClient(ctx, input.clientId);
  const existing = await ctx.db.first<ForecastScenarioRow>('SELECT * FROM forecast_scenarios WHERE scenario_id = ?', [scenarioId]);
  if (!existing) {
    throw new ServiceError('NOT_FOUND', 'Forecast scenario not found.');
  }
  const result = await runScenarioForecast(ctx, input);
  if (!result.recommended && !result.manual) {
    throw new ServiceError('INSUFFICIENT_DATA', result.warnings[0] ?? 'There is not enough eligible history to save a forecast.');
  }
  const now = isoNow(ctx);
  await ctx.db.transaction(async (tx) => {
    await tx.run(
      `UPDATE forecast_scenarios SET scenario_name = ?, client_id = ?, account_id = ?, target_month = ?, total_budget_zar = ?, baseline_window = ?,
        allocation_mode = ?, scenario_parameters_json = ?, results_json = ?, updated_at = ? WHERE scenario_id = ?`,
      [
        input.scenarioName.trim(),
        input.clientId,
        input.accountId ?? null,
        input.targetMonth,
        input.totalBudgetZar,
        input.baselineWindow,
        input.allocationMode,
        JSON.stringify(input),
        JSON.stringify(result),
        now,
        scenarioId,
      ],
    );
    await writeAllocations(tx, scenarioId, [result.recommended, result.manual]);
    await recordAuditEvent(
      tx,
      { eventType: 'scenario.updated', message: `Forecast scenario "${input.scenarioName.trim()}" recalculated and updated.`, userId: actor.userId, entityType: 'scenario', entityId: scenarioId },
      now,
    );
  });
  return getForecastScenario(ctx, scenarioId);
}

export async function deleteForecastScenario(ctx: ServiceContext, actor: Actor, scenarioId: number): Promise<void> {
  requirePermission(actor, 'scenarios.manage');
  const existing = await ctx.db.first<ForecastScenarioRow>('SELECT * FROM forecast_scenarios WHERE scenario_id = ?', [scenarioId]);
  if (!existing) {
    throw new ServiceError('NOT_FOUND', 'Forecast scenario not found.');
  }
  const now = isoNow(ctx);
  await ctx.db.transaction(async (tx) => {
    await tx.run('DELETE FROM forecast_scenarios WHERE scenario_id = ?', [scenarioId]);
    await recordAuditEvent(
      tx,
      { eventType: 'scenario.deleted', message: `Forecast scenario "${existing.scenario_name}" deleted.`, userId: actor.userId, entityType: 'scenario', entityId: scenarioId },
      now,
    );
  });
}

function toSavedScenario(row: ForecastScenarioRow & { client_name: string }, allocations: ForecastAllocationRow[]): SavedScenario {
  return {
    scenarioId: row.scenario_id,
    scenarioName: row.scenario_name,
    clientId: row.client_id,
    clientName: row.client_name,
    accountId: row.account_id,
    targetMonth: row.target_month,
    totalBudgetZar: row.total_budget_zar,
    baselineWindow: row.baseline_window,
    allocationMode: row.allocation_mode,
    parameters: parseJson<ScenarioInput>(row.scenario_parameters_json, {} as ScenarioInput),
    result: parseJson<ForecastResult>(row.results_json, {} as ForecastResult),
    allocations,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getForecastScenario(ctx: ServiceContext, scenarioId: number): Promise<SavedScenario> {
  const row = await ctx.db.first<ForecastScenarioRow & { client_name: string }>(
    'SELECT s.*, c.client_name FROM forecast_scenarios s JOIN clients c ON c.client_id = s.client_id WHERE s.scenario_id = ?',
    [scenarioId],
  );
  if (!row) {
    throw new ServiceError('NOT_FOUND', 'Forecast scenario not found.');
  }
  const allocations = await ctx.db.all<ForecastAllocationRow>(
    'SELECT * FROM forecast_allocations WHERE scenario_id = ? ORDER BY allocation_type, allocated_budget_zar DESC',
    [scenarioId],
  );
  return toSavedScenario(row, allocations);
}

export async function listForecastScenarios(ctx: ServiceContext, clientId?: number): Promise<SavedScenario[]> {
  const rows = await ctx.db.all<ForecastScenarioRow & { client_name: string }>(
    `SELECT s.*, c.client_name FROM forecast_scenarios s JOIN clients c ON c.client_id = s.client_id
     ${clientId !== undefined ? 'WHERE s.client_id = ?' : ''} ORDER BY s.updated_at DESC, s.scenario_id DESC`,
    clientId !== undefined ? [clientId] : [],
  );
  const result: SavedScenario[] = [];
  for (const row of rows) {
    const allocations = await ctx.db.all<ForecastAllocationRow>('SELECT * FROM forecast_allocations WHERE scenario_id = ? ORDER BY allocation_type, allocated_budget_zar DESC', [
      row.scenario_id,
    ]);
    result.push(toSavedScenario(row, allocations));
  }
  return result;
}

export interface ScenarioComparisonRow {
  scenarioId: number;
  scenarioName: string;
  targetMonth: string;
  totalBudgetZar: number;
  mode: 'recommended' | 'manual';
  expectedClicks: number | null;
  expectedImpressions: number | null;
  expectedConversions: number | null;
  blendedCpc: number | null;
  clickRange: { low: number; high: number } | null;
}

export async function compareForecastScenarios(ctx: ServiceContext, scenarioIds: number[]): Promise<ScenarioComparisonRow[]> {
  const rows: ScenarioComparisonRow[] = [];
  for (const id of scenarioIds) {
    const scenario = await getForecastScenario(ctx, id);
    const plan = scenario.allocationMode === 'manual' ? scenario.result.manual : scenario.result.recommended;
    rows.push({
      scenarioId: scenario.scenarioId,
      scenarioName: scenario.scenarioName,
      targetMonth: scenario.targetMonth,
      totalBudgetZar: scenario.totalBudgetZar,
      mode: scenario.allocationMode,
      expectedClicks: plan ? plan.clicks.expected : null,
      expectedImpressions: plan ? plan.impressions.expected : null,
      expectedConversions: plan?.conversions ? plan.conversions.expected : null,
      blendedCpc: plan?.blendedCpc ?? null,
      clickRange: plan ? { low: plan.clicks.low, high: plan.clicks.high } : null,
    });
  }
  return rows;
}
