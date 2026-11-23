import { confirmMapping, getMappingConfirmation } from '../src/services/mapping/confirmationService';
import {
  applyProfileMappings,
  isProfileCompatible,
  mappingsFromSuggestions,
  suggestColumnMappings,
  validateColumnMappings,
} from '../src/services/mapping/mappingEngine';
import {
  createMappingProfile,
  deleteMappingProfile,
  getMappingProfile,
  listCompatibleProfiles,
  listMappingProfiles,
  updateMappingProfile,
} from '../src/services/mapping/profileService';
import { buildMetaXlsx, buildTikTokCsv, META_HEADERS, TIKTOK_HEADERS } from './helpers/fixtures';
import { adminActor, analystActor, createInitializedContext, getAccountId, TestContext, viewerActor } from './helpers/testContext';
import { uploadBytes } from './helpers/workflow';

describe('mapping engine', () => {
  it('maps every Meta reference column exactly and skips reporting range columns', () => {
    const suggestions = suggestColumnMappings(META_HEADERS, 'meta');
    const byColumn = Object.fromEntries(suggestions.map((item) => [item.sourceColumn, item]));
    expect(byColumn['Objective'].target).toBe('source_objective');
    expect(byColumn['Month'].target).toBe('report_month');
    expect(byColumn['Platform'].target).toBe('placement');
    expect(byColumn['Amount spent (ZAR)'].target).toBe('spend_zar');
    expect(byColumn['Impressions'].target).toBe('impressions');
    expect(byColumn['Link clicks'].target).toBe('clicks');
    expect(byColumn['Reporting starts'].status).toBe('skipped');
    expect(byColumn['Reporting ends'].status).toBe('skipped');
    const validation = validateColumnMappings(META_HEADERS, mappingsFromSuggestions(suggestions), 'meta');
    expect(validation.valid).toBe(true);
    expect(validation.matchedCount).toBe(6);
    expect(validation.skippedCount).toBe(2);
  });

  it('maps every TikTok reference column exactly, including currency', () => {
    const suggestions = suggestColumnMappings(TIKTOK_HEADERS, 'tiktok');
    expect(suggestions.every((item) => item.status === 'matched' && item.source === 'supplier_exact')).toBe(true);
    const mappings = mappingsFromSuggestions(suggestions);
    expect(mappings['Clicks (destination)']).toBe('clicks');
    expect(mappings['Placements Types']).toBe('placement');
    expect(mappings['Currency']).toBe('currency');
    expect(validateColumnMappings(TIKTOK_HEADERS, mappings, 'tiktok')).toMatchObject({ valid: true, matchedCount: 9 });
  });

  it('matches synonyms ignoring case and punctuation, and flags unknown columns for review', () => {
    const headers = ['  CAMPAIGN_NAME ', 'Cost', 'Impr', 'Clicks', 'Month', 'Objective', 'Currency', 'Mystery Column'];
    const suggestions = suggestColumnMappings(headers, 'tiktok');
    const byColumn = Object.fromEntries(suggestions.map((item) => [item.sourceColumn, item]));
    expect(byColumn['  CAMPAIGN_NAME '].target).toBe('campaign_name');
    expect(byColumn['Cost'].target).toBe('spend_zar');
    expect(byColumn['Impr'].target).toBe('impressions');
    expect(byColumn['Mystery Column'].status).toBe('review');
    const validation = validateColumnMappings(headers, mappingsFromSuggestions(suggestions), 'tiktok');
    expect(validation.valid).toBe(false);
    expect(validation.issues.map((issue) => issue.type)).toContain('unresolved');
  });

  it('accepts manual changes and recalculates the match counter', () => {
    const mappings = mappingsFromSuggestions(suggestColumnMappings(META_HEADERS, 'meta'));
    mappings['Reporting starts'] = 'skip';
    mappings['Platform'] = 'skip';
    const validation = validateColumnMappings(META_HEADERS, mappings, 'meta');
    expect(validation.valid).toBe(true);
    expect(validation.matchedCount).toBe(5);
    expect(validation.skippedCount).toBe(3);
  });

  it('rejects duplicate target fields immediately', () => {
    const mappings = mappingsFromSuggestions(suggestColumnMappings(META_HEADERS, 'meta'));
    mappings['Impressions'] = 'clicks';
    const validation = validateColumnMappings(META_HEADERS, mappings, 'meta');
    expect(validation.valid).toBe(false);
    expect(validation.duplicateTargets).toEqual(['clicks']);
    expect(validation.issues.find((issue) => issue.type === 'duplicate_target')?.columns).toEqual(['Impressions', 'Link clicks']);
    expect(validation.issues.some((issue) => issue.type === 'missing_required' && issue.field === 'impressions')).toBe(true);
  });

  it('requires essential fields and currency information', () => {
    const mappings = mappingsFromSuggestions(suggestColumnMappings(TIKTOK_HEADERS, 'tiktok'));
    mappings['Currency'] = 'skip';
    mappings['By month'] = 'skip';
    const validation = validateColumnMappings(TIKTOK_HEADERS, mappings, 'tiktok');
    const types = validation.issues.map((issue) => `${issue.type}:${issue.field ?? ''}`);
    expect(types).toContain('missing_required:report_month');
    expect(types).toContain('missing_currency:currency');
  });

  it('rejects invalid target fields', () => {
    const mappings = mappingsFromSuggestions(suggestColumnMappings(META_HEADERS, 'meta')) as Record<string, string>;
    mappings['Objective'] = 'not_a_field';
    const validation = validateColumnMappings(META_HEADERS, mappings as never, 'meta');
    expect(validation.issues.some((issue) => issue.type === 'invalid_target')).toBe(true);
  });

  it('only treats profiles with the same supplier, file type and column structure as compatible', () => {
    const profile = { supplierCode: 'meta', fileType: 'xlsx', sourceColumns: META_HEADERS };
    expect(isProfileCompatible(profile, { supplierCode: 'meta', fileType: 'xlsx', headers: [...META_HEADERS].reverse() })).toBe(true);
    expect(isProfileCompatible(profile, { supplierCode: 'meta', fileType: 'csv', headers: META_HEADERS })).toBe(false);
    expect(isProfileCompatible(profile, { supplierCode: 'tiktok', fileType: 'xlsx', headers: META_HEADERS })).toBe(false);
    expect(isProfileCompatible(profile, { supplierCode: 'meta', fileType: 'xlsx', headers: META_HEADERS.slice(1) })).toBe(false);
    expect(applyProfileMappings(['objective'], { Objective: 'source_objective' })).toEqual({ objective: 'source_objective' });
  });
});

describe('mapping profiles and confirmations', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createInitializedContext();
  });

  afterEach(async () => {
    await ctx.db.close();
  });

  async function metaSupplierId(): Promise<number> {
    const row = await ctx.db.first<{ supplier_id: number }>("SELECT supplier_id FROM suppliers WHERE supplier_code = 'meta'");
    return row?.supplier_id ?? 0;
  }

  it('supports full create, read, update and delete of mapping profiles', async () => {
    const supplierId = await metaSupplierId();
    const mappings = mappingsFromSuggestions(suggestColumnMappings(META_HEADERS, 'meta'));
    const created = await createMappingProfile(ctx, analystActor, { supplierId, profileName: 'Meta monthly', fileType: 'xlsx', columnMappings: mappings });
    expect(created.profileId).toBeGreaterThan(0);
    expect((await getMappingProfile(ctx, created.profileId)).columnMappings['Link clicks']).toBe('clicks');
    expect(await listMappingProfiles(ctx)).toHaveLength(1);

    const updated = await updateMappingProfile(ctx, analystActor, created.profileId, {
      profileName: 'Meta monthly v2',
      columnMappings: { ...mappings, Platform: 'skip' },
    });
    expect(updated.profileName).toBe('Meta monthly v2');
    expect(updated.columnMappings['Platform']).toBe('skip');

    await expect(
      createMappingProfile(ctx, analystActor, { supplierId, profileName: 'Meta monthly v2', fileType: 'xlsx', columnMappings: mappings }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await deleteMappingProfile(ctx, analystActor, created.profileId);
    expect(await listMappingProfiles(ctx)).toHaveLength(0);
    const events = await ctx.db.all<{ event_type: string }>("SELECT event_type FROM processing_logs WHERE event_type LIKE 'profile.%' ORDER BY log_id");
    expect(events.map((event) => event.event_type)).toEqual(['profile.created', 'profile.updated', 'profile.deleted']);
  });

  it('stops viewers from managing profiles', async () => {
    const supplierId = await metaSupplierId();
    await expect(
      createMappingProfile(ctx, viewerActor, { supplierId, profileName: 'Nope', fileType: 'xlsx', columnMappings: { Objective: 'source_objective' } }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lists only profiles compatible with the uploaded file', async () => {
    const supplierId = await metaSupplierId();
    const mappings = mappingsFromSuggestions(suggestColumnMappings(META_HEADERS, 'meta'));
    await createMappingProfile(ctx, adminActor, { supplierId, profileName: 'Compatible', fileType: 'xlsx', columnMappings: mappings });
    await createMappingProfile(ctx, adminActor, { supplierId, profileName: 'Wrong type', fileType: 'csv', columnMappings: mappings });
    const compatible = await listCompatibleProfiles(ctx, { supplierCode: 'meta', fileType: 'xlsx', headers: META_HEADERS });
    expect(compatible.map((profile) => profile.profileName)).toEqual(['Compatible']);
  });

  it('stores an immutable confirmation snapshot that survives profile edits and deletion', async () => {
    const accountId = await getAccountId(ctx, 'meta');
    const inspection = await uploadBytes(ctx, accountId, 'meta.xlsx', buildMetaXlsx());
    const supplierId = await metaSupplierId();
    const mappings = mappingsFromSuggestions(inspection.suggestions);
    const profile = await createMappingProfile(ctx, adminActor, { supplierId, profileName: 'Snapshot source', fileType: 'xlsx', columnMappings: mappings });
    const confirmation = await confirmMapping(ctx, adminActor, { fileId: inspection.fileId, columnMappings: mappings, profileId: profile.profileId });
    expect(confirmation.supplierDefaults).toMatchObject({ platform: 'Meta', currency: 'ZAR', clickMetricType: 'link_click' });
    expect(confirmation.sourceFileHash).toBe(inspection.fileHash);

    await updateMappingProfile(ctx, adminActor, profile.profileId, { columnMappings: { ...mappings, 'Link clicks': 'skip' } });
    await deleteMappingProfile(ctx, adminActor, profile.profileId);

    const reloaded = await getMappingConfirmation(ctx, confirmation.confirmationId);
    expect(reloaded.columnMappings['Link clicks']).toBe('clicks');
    expect(reloaded.profileName).toBe('Snapshot source');
    await expect(ctx.db.run('UPDATE mapping_confirmations SET profile_name = ? WHERE confirmation_id = ?', ['tampered', confirmation.confirmationId])).rejects.toThrow(
      /immutable/,
    );
    await expect(ctx.db.run('DELETE FROM mapping_confirmations WHERE confirmation_id = ?', [confirmation.confirmationId])).rejects.toThrow(/immutable/);
  });

  it('refuses to confirm an invalid mapping', async () => {
    const accountId = await getAccountId(ctx, 'tiktok');
    const inspection = await uploadBytes(ctx, accountId, 'tiktok.csv', buildTikTokCsv());
    const mappings = mappingsFromSuggestions(inspection.suggestions);
    mappings['Spend'] = 'impressions';
    await expect(confirmMapping(ctx, adminActor, { fileId: inspection.fileId, columnMappings: mappings })).rejects.toMatchObject({ code: 'MAPPING_INVALID' });
    const count = await ctx.db.first<{ total: number }>('SELECT COUNT(*) AS total FROM mapping_confirmations');
    expect(count?.total).toBe(0);
  });
});
