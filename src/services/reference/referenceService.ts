import { AccountView, ClientRow, CurrencyRateRow, SupplierRow } from '../../database/models';
import { recordAuditEvent } from '../audit/auditService';
import { Actor, requirePermission } from '../auth/permissions';
import { isoNow, ServiceContext } from '../context';
import { ServiceError } from '../errors';

export async function listSuppliers(ctx: ServiceContext, includeInactive = false): Promise<SupplierRow[]> {
  return ctx.db.all<SupplierRow>(
    `SELECT * FROM suppliers ${includeInactive ? '' : 'WHERE is_active = 1'} ORDER BY supplier_id`,
  );
}

export async function listClients(ctx: ServiceContext): Promise<ClientRow[]> {
  return ctx.db.all<ClientRow>('SELECT * FROM clients ORDER BY client_name');
}

export async function listAccounts(ctx: ServiceContext, clientId?: number): Promise<AccountView[]> {
  return ctx.db.all<AccountView>(
    `SELECT a.*, c.client_name, s.supplier_name, s.supplier_code
     FROM advertising_accounts a
     JOIN clients c ON c.client_id = a.client_id
     JOIN suppliers s ON s.supplier_id = a.supplier_id
     ${clientId !== undefined ? 'WHERE a.client_id = ?' : ''}
     ORDER BY c.client_name, s.supplier_name, a.account_name`,
    clientId !== undefined ? [clientId] : [],
  );
}

export async function getAccount(ctx: ServiceContext, accountId: number): Promise<AccountView> {
  const account = await ctx.db.first<AccountView>(
    `SELECT a.*, c.client_name, s.supplier_name, s.supplier_code
     FROM advertising_accounts a
     JOIN clients c ON c.client_id = a.client_id
     JOIN suppliers s ON s.supplier_id = a.supplier_id
     WHERE a.account_id = ?`,
    [accountId],
  );
  if (!account) {
    throw new ServiceError('NOT_FOUND', 'Advertising account not found.');
  }
  return account;
}

export async function saveClient(ctx: ServiceContext, actor: Actor, input: { clientId?: number; clientName: string; industry?: string | null }): Promise<number> {
  requirePermission(actor, 'reference.manage');
  const name = input.clientName.trim();
  if (!name) {
    throw new ServiceError('VALIDATION', 'Enter a client name.', { field: 'clientName' });
  }
  const duplicate = await ctx.db.first<{ client_id: number }>('SELECT client_id FROM clients WHERE client_name = ? AND client_id <> ?', [
    name,
    input.clientId ?? -1,
  ]);
  if (duplicate) {
    throw new ServiceError('CONFLICT', 'A client with this name already exists.');
  }
  const now = isoNow(ctx);
  return ctx.db.transaction(async (tx) => {
    let clientId = input.clientId;
    if (clientId) {
      const result = await tx.run('UPDATE clients SET client_name = ?, industry = ?, updated_at = ? WHERE client_id = ?', [
        name,
        input.industry ?? null,
        now,
        clientId,
      ]);
      if (result.changes === 0) {
        throw new ServiceError('NOT_FOUND', 'Client not found.');
      }
    } else {
      const result = await tx.run('INSERT INTO clients (client_name, industry, created_at, updated_at) VALUES (?, ?, ?, ?)', [
        name,
        input.industry ?? null,
        now,
        now,
      ]);
      clientId = result.lastInsertRowId;
    }
    await recordAuditEvent(
      tx,
      { eventType: input.clientId ? 'client.updated' : 'client.created', message: `Client ${name} saved.`, userId: actor.userId, entityType: 'client', entityId: clientId },
      now,
    );
    return clientId;
  });
}

export async function deleteClient(ctx: ServiceContext, actor: Actor, clientId: number): Promise<void> {
  requirePermission(actor, 'reference.manage');
  const accounts = await ctx.db.first<{ total: number }>('SELECT COUNT(*) AS total FROM advertising_accounts WHERE client_id = ?', [clientId]);
  if ((accounts?.total ?? 0) > 0) {
    throw new ServiceError('CONFLICT', 'Delete or reassign this client’s advertising accounts first.');
  }
  const scenarios = await ctx.db.first<{ total: number }>('SELECT COUNT(*) AS total FROM forecast_scenarios WHERE client_id = ?', [clientId]);
  if ((scenarios?.total ?? 0) > 0) {
    throw new ServiceError('CONFLICT', 'This client has saved forecast scenarios. Delete them first.');
  }
  const now = isoNow(ctx);
  await ctx.db.transaction(async (tx) => {
    const result = await tx.run('DELETE FROM clients WHERE client_id = ?', [clientId]);
    if (result.changes === 0) {
      throw new ServiceError('NOT_FOUND', 'Client not found.');
    }
    await recordAuditEvent(tx, { eventType: 'client.deleted', message: `Client ${clientId} deleted.`, userId: actor.userId, entityType: 'client', entityId: clientId }, now);
  });
}

export interface SaveAccountInput {
  accountId?: number;
  clientId: number;
  supplierId: number;
  accountName: string;
  externalAccountId: string;
}

export async function saveAccount(ctx: ServiceContext, actor: Actor, input: SaveAccountInput): Promise<number> {
  requirePermission(actor, 'reference.manage');
  const name = input.accountName.trim();
  const external = input.externalAccountId.trim();
  if (!name || !external) {
    throw new ServiceError('VALIDATION', 'Enter an account name and the supplier’s account ID.');
  }
  const client = await ctx.db.first('SELECT client_id FROM clients WHERE client_id = ?', [input.clientId]);
  const supplier = await ctx.db.first<{ is_active: number }>('SELECT is_active FROM suppliers WHERE supplier_id = ?', [input.supplierId]);
  if (!client || !supplier) {
    throw new ServiceError('VALIDATION', 'An advertising account must belong to a valid client and supplier.');
  }
  const duplicate = await ctx.db.first<{ account_id: number }>(
    'SELECT account_id FROM advertising_accounts WHERE supplier_id = ? AND external_account_id = ? AND account_id <> ?',
    [input.supplierId, external, input.accountId ?? -1],
  );
  if (duplicate) {
    throw new ServiceError('CONFLICT', 'This supplier account ID is already registered.');
  }
  const now = isoNow(ctx);
  return ctx.db.transaction(async (tx) => {
    let accountId = input.accountId;
    if (accountId) {
      const files = await tx.first<{ total: number }>('SELECT COUNT(*) AS total FROM uploaded_files WHERE account_id = ?', [accountId]);
      const current = await tx.first<{ supplier_id: number; client_id: number }>('SELECT supplier_id, client_id FROM advertising_accounts WHERE account_id = ?', [accountId]);
      if (!current) {
        throw new ServiceError('NOT_FOUND', 'Advertising account not found.');
      }
      if ((files?.total ?? 0) > 0 && (current.supplier_id !== input.supplierId || current.client_id !== input.clientId)) {
        throw new ServiceError('CONFLICT', 'Files have been imported for this account, so its client and supplier can no longer change.');
      }
      await tx.run('UPDATE advertising_accounts SET client_id = ?, supplier_id = ?, account_name = ?, external_account_id = ? WHERE account_id = ?', [
        input.clientId,
        input.supplierId,
        name,
        external,
        accountId,
      ]);
    } else {
      const result = await tx.run(
        'INSERT INTO advertising_accounts (client_id, supplier_id, account_name, external_account_id, created_at) VALUES (?, ?, ?, ?, ?)',
        [input.clientId, input.supplierId, name, external, now],
      );
      accountId = result.lastInsertRowId;
    }
    await recordAuditEvent(
      tx,
      { eventType: input.accountId ? 'account.updated' : 'account.created', message: `Advertising account ${name} saved.`, userId: actor.userId, entityType: 'account', entityId: accountId },
      now,
    );
    return accountId;
  });
}

export async function deleteAccount(ctx: ServiceContext, actor: Actor, accountId: number): Promise<void> {
  requirePermission(actor, 'reference.manage');
  const files = await ctx.db.first<{ total: number }>('SELECT COUNT(*) AS total FROM uploaded_files WHERE account_id = ?', [accountId]);
  if ((files?.total ?? 0) > 0) {
    throw new ServiceError('CONFLICT', 'Files have been imported for this account, so it cannot be deleted.');
  }
  const now = isoNow(ctx);
  await ctx.db.transaction(async (tx) => {
    const result = await tx.run('DELETE FROM advertising_accounts WHERE account_id = ?', [accountId]);
    if (result.changes === 0) {
      throw new ServiceError('NOT_FOUND', 'Advertising account not found.');
    }
    await recordAuditEvent(tx, { eventType: 'account.deleted', message: `Advertising account ${accountId} deleted.`, userId: actor.userId, entityType: 'account', entityId: accountId }, now);
  });
}

export async function listCurrencyRates(ctx: ServiceContext): Promise<CurrencyRateRow[]> {
  return ctx.db.all<CurrencyRateRow>('SELECT * FROM currency_rates ORDER BY currency_code, rate_date DESC');
}

export async function saveCurrencyRate(
  ctx: ServiceContext,
  actor: Actor,
  input: { currencyCode: string; rateToZar: number; rateDate: string; source: string },
): Promise<number> {
  requirePermission(actor, 'currency.manage');
  const code = input.currencyCode.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code) || code === 'ZAR') {
    throw new ServiceError('VALIDATION', 'Enter a three-letter non-ZAR currency code.');
  }
  if (!Number.isFinite(input.rateToZar) || input.rateToZar <= 0) {
    throw new ServiceError('VALIDATION', 'The conversion rate must be a positive number.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.rateDate)) {
    throw new ServiceError('VALIDATION', 'Enter the rate date as YYYY-MM-DD.');
  }
  if (!input.source.trim()) {
    throw new ServiceError('VALIDATION', 'Record the source of the conversion rate.');
  }
  const now = isoNow(ctx);
  return ctx.db.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO currency_rates (currency_code, rate_to_zar, rate_date, source, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(currency_code, rate_date) DO UPDATE SET rate_to_zar = excluded.rate_to_zar, source = excluded.source`,
      [code, input.rateToZar, input.rateDate, input.source.trim(), now],
    );
    const row = await tx.first<{ rate_id: number }>('SELECT rate_id FROM currency_rates WHERE currency_code = ? AND rate_date = ?', [code, input.rateDate]);
    await recordAuditEvent(
      tx,
      { eventType: 'currency.rate_saved', message: `${code} rate ${input.rateToZar} ZAR dated ${input.rateDate} saved.`, userId: actor.userId, entityType: 'currency_rate', entityId: row?.rate_id ?? null },
      now,
    );
    return row?.rate_id ?? 0;
  });
}

export async function deleteCurrencyRate(ctx: ServiceContext, actor: Actor, rateId: number): Promise<void> {
  requirePermission(actor, 'currency.manage');
  const now = isoNow(ctx);
  await ctx.db.transaction(async (tx) => {
    await tx.run('DELETE FROM currency_rates WHERE rate_id = ?', [rateId]);
    await recordAuditEvent(tx, { eventType: 'currency.rate_deleted', message: `Currency rate ${rateId} deleted.`, userId: actor.userId, entityType: 'currency_rate', entityId: rateId }, now);
  });
}
