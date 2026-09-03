import { randomUUID } from 'crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closePool } from '../shared/db';
import {
  insertTransaction,
  listRecentIncompleteTransactions,
  markTransactionCompleted,
  updateTransactionStatus,
  updateTransactionTaxId,
} from './transactions';

const runId = randomUUID();

afterAll(async () => {
  await closePool();
});

describe('transactions repository', () => {
  it('insere transacao e devolve os campos persistidos', async () => {
    const txid = `txid-insert-${runId}`;

    const transaction = await insertTransaction({
      txid,
      internalId: 'internal-1',
      taxId: '12345678901',
      status: 'ACTIVE',
      callbackUrl: 'https://example.com/callback',
      amount: '29.90',
      pixCopyPaste: '00020126',
    });

    expect(transaction.id).toBeTruthy();
    expect(transaction.txid).toBe(txid);
    expect(transaction.internalId).toBe('internal-1');
    expect(transaction.taxId).toBe('12345678901');
    expect(transaction.status).toBe('ACTIVE');
    expect(transaction.callbackUrl).toBe('https://example.com/callback');
    expect(transaction.amount).toBe('29.90');
    expect(transaction.pixCopyPaste).toBe('00020126');
  });

  it('atualiza o status da transacao', async () => {
    const txid = `txid-status-${runId}`;
    await insertTransaction({
      txid,
      internalId: 'internal-2',
      status: 'ACTIVE',
      amount: '10.00',
    });

    await updateTransactionStatus(txid, 'COMPLETED');

    const since = new Date(Date.now() - 60_000).toISOString();
    const pending = await listRecentIncompleteTransactions(since);
    expect(pending.some((tx) => tx.txid === txid)).toBe(false);
  });

  it('marca transacao como concluida via markTransactionCompleted', async () => {
    const txid = `txid-completed-${runId}`;
    await insertTransaction({
      txid,
      internalId: 'internal-3',
      status: 'ACTIVE',
      amount: '15.00',
    });

    await markTransactionCompleted(txid);

    const since = new Date(Date.now() - 60_000).toISOString();
    const pending = await listRecentIncompleteTransactions(since);
    expect(pending.some((tx) => tx.txid === txid)).toBe(false);
  });

  it('atualiza o taxId da transacao', async () => {
    const txid = `txid-taxid-${runId}`;
    await insertTransaction({
      txid,
      internalId: 'internal-4',
      status: 'ACTIVE',
      amount: '20.00',
    });

    await updateTransactionTaxId(txid, '98765432100');

    const since = new Date(Date.now() - 60_000).toISOString();
    const pending = await listRecentIncompleteTransactions(since);
    const found = pending.find((tx) => tx.txid === txid);

    expect(found?.taxId).toBe('98765432100');
  });

  it('lista apenas transacoes ACTIVE criadas desde o horario informado', async () => {
    const activeTxid = `txid-active-${runId}`;
    const completedTxid = `txid-completed-list-${runId}`;

    await insertTransaction({
      txid: activeTxid,
      internalId: 'internal-5',
      status: 'ACTIVE',
      amount: '30.00',
    });
    await insertTransaction({
      txid: completedTxid,
      internalId: 'internal-6',
      status: 'COMPLETED',
      amount: '30.00',
    });

    const since = new Date(Date.now() - 60_000).toISOString();
    const pending = await listRecentIncompleteTransactions(since);

    expect(pending.some((tx) => tx.txid === activeTxid)).toBe(true);
    expect(pending.some((tx) => tx.txid === completedTxid)).toBe(false);
  });

  it('nao lista transacoes criadas antes do horario informado', async () => {
    const txid = `txid-old-${runId}`;
    await insertTransaction({
      txid,
      internalId: 'internal-7',
      status: 'ACTIVE',
      amount: '40.00',
    });

    const future = new Date(Date.now() + 60_000).toISOString();
    const pending = await listRecentIncompleteTransactions(future);

    expect(pending.some((tx) => tx.txid === txid)).toBe(false);
  });
});
