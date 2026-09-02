import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../shared/api';
import { AppError } from '../../shared/errors';
import { createCharge, createRecurrence, getChargeByTxid } from './pixAutomatico';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createRecurrence', () => {
  it('sempre envia a recorrencia com retentativa habilitada', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      data: { idRec: 'rec-1', status: 'CRIADA' },
    } as never);

    await createRecurrence({
      amount: '29.90',
      intervalMonths: 1,
      firstDueDate: '2026-09-20',
      debtorTaxId: '12345678901',
      debtorName: 'Fulano',
      planCode: 'mensal_29_90',
    });

    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(body.politicaRetentativa).toBe('PERMITE_3R_7D');
  });

  it('mapeia a resposta do Inter para o formato interno', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({
      data: { idRec: 'rec-2', status: 'CRIADA' },
    } as never);

    const result = await createRecurrence({
      amount: '29.90',
      intervalMonths: 1,
      firstDueDate: '2026-09-20',
      debtorTaxId: '12345678901',
      debtorName: 'Fulano',
      planCode: 'mensal_29_90',
    });

    expect(result.recId).toBe('rec-2');
    expect(result.status).toBe('CRIADA');
  });

  it('converte falha do Inter em AppError.upstream sem vazar o corpo', async () => {
    vi.spyOn(api, 'post').mockRejectedValue({
      isAxiosError: true,
      response: { status: 500, data: { detalhe: 'segredo interno' } },
      message: 'boom',
    });

    await expect(
      createRecurrence({
        amount: '29.90',
        intervalMonths: 1,
        firstDueDate: '2026-09-20',
        debtorTaxId: '12345678901',
        debtorName: 'Fulano',
        planCode: 'mensal_29_90',
      }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });
});

describe('createCharge', () => {
  it('reusa o txid recebido, para respeitar a regra de retentativa', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({
      data: { txid: 'txid-fixo', status: 'CRIADA' },
    } as never);

    await createCharge({
      recId: 'rec-1',
      txid: 'txid-fixo',
      dueDate: '2026-09-20',
      amount: '29.90',
    });

    expect(put.mock.calls[0][0]).toContain('txid-fixo');
  });
});

describe('getChargeByTxid', () => {
  it('mapeia cobranca liquidada', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { txid: 'txid-1', status: 'LIQUIDADA', endToEndId: 'E123', horario: '2026-09-20T10:00:00Z' },
    } as never);

    const result = await getChargeByTxid('txid-1');

    expect(result.status).toBe('LIQUIDADA');
    expect(result.endToEndId).toBe('E123');
    expect(result.paidAt).toBe('2026-09-20T10:00:00Z');
  });
});
