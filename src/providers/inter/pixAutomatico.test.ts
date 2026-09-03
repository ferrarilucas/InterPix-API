import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../shared/api';
import { AppError } from '../../shared/errors';
import {
  cancelRecurrence,
  createCharge,
  createRecurrence,
  getChargeByTxid,
  getRecurrence,
} from './pixAutomatico';

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

  it('envia o devedor como cpf quando o documento tem 11 digitos', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      data: { idRec: 'rec-cpf', status: 'CRIADA' },
    } as never);

    await createRecurrence({
      amount: '29.90',
      intervalMonths: 1,
      firstDueDate: '2026-09-20',
      debtorTaxId: '12345678901',
      debtorName: 'Fulano',
      planCode: 'mensal_29_90',
    });

    const body = post.mock.calls[0][1] as { vinculo: { devedor: Record<string, unknown> } };
    expect(body.vinculo.devedor.cpf).toBe('12345678901');
    expect(body.vinculo.devedor.cnpj).toBeUndefined();
  });

  it('envia o devedor como cnpj quando o documento tem 14 digitos', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      data: { idRec: 'rec-cnpj', status: 'CRIADA' },
    } as never);

    await createRecurrence({
      amount: '29.90',
      intervalMonths: 1,
      firstDueDate: '2026-09-20',
      debtorTaxId: '12345678901234',
      debtorName: 'Empresa Ltda',
      planCode: 'mensal_29_90',
    });

    const body = post.mock.calls[0][1] as { vinculo: { devedor: Record<string, unknown> } };
    expect(body.vinculo.devedor.cnpj).toBe('12345678901234');
    expect(body.vinculo.devedor.cpf).toBeUndefined();
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
    expect(result.status).toBe('CREATED');
    expect(result.rawStatus).toBe('CRIADA');
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

  it('converte falha nao-axios (sem response) em AppError.upstream', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new Error('falha de rede generica'));

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

describe('mapeamento de status de recorrencia', () => {
  const cases: Array<[string, string]> = [
    ['CRIADA', 'CREATED'],
    ['ENVIADA', 'PENDING_AUTH'],
    ['RECEBIDA', 'PENDING_AUTH'],
    ['APROVADA', 'APPROVED'],
    ['ACEITA', 'APPROVED'],
    ['REJEITADA', 'DENIED'],
    ['EXPIRADA', 'DENIED'],
    ['CANCELADA', 'CANCELED'],
  ];

  it.each(cases)('mapeia status documentado do Inter %s para %s', async (interStatus, expected) => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { idRec: 'rec-1', status: interStatus },
    } as never);

    const result = await getRecurrence('rec-1');

    expect(result.status).toBe(expected);
    expect(result.rawStatus).toBe(interStatus);
  });

  it('mapeia status desconhecido para UNKNOWN preservando rawStatus, nunca para um estado de sucesso', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { idRec: 'rec-1', status: 'ALGO_NOVO' },
    } as never);

    const result = await getRecurrence('rec-1');

    expect(result.status).toBe('UNKNOWN');
    expect(result.rawStatus).toBe('ALGO_NOVO');
  });
});

describe('cancelRecurrence', () => {
  it('trata recorrencia inexistente (404) como sucesso', async () => {
    vi.spyOn(api, 'patch').mockRejectedValue({
      isAxiosError: true,
      response: { status: 404, data: { title: 'Recurso nao encontrado' } },
      message: 'not found',
    });

    await expect(cancelRecurrence('rec-1')).resolves.toBeUndefined();
  });

  it('trata recorrencia ja cancelada (400) como sucesso', async () => {
    vi.spyOn(api, 'patch').mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 400,
        data: {
          title: 'Requisicao invalida',
          violacoes: [{ razao: 'Recorrencia ja esta CANCELADA' }],
        },
      },
      message: 'bad request',
    });

    await expect(cancelRecurrence('rec-2')).resolves.toBeUndefined();
  });

  it('mantem AppError.upstream para falha real do Inter', async () => {
    vi.spyOn(api, 'patch').mockRejectedValue({
      isAxiosError: true,
      response: { status: 500, data: { detalhe: 'segredo interno' } },
      message: 'boom',
    });

    await expect(cancelRecurrence('rec-3')).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    await expect(cancelRecurrence('rec-3')).rejects.toBeInstanceOf(AppError);
  });

  it('mantem AppError.upstream para 400 que nao indica cancelamento previo', async () => {
    vi.spyOn(api, 'patch').mockRejectedValue({
      isAxiosError: true,
      response: { status: 400, data: { title: 'Valor invalido' } },
      message: 'bad request',
    });

    await expect(cancelRecurrence('rec-4')).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('mantem AppError.upstream para falha de rede', async () => {
    vi.spyOn(api, 'patch').mockRejectedValue(new Error('falha de rede generica'));

    await expect(cancelRecurrence('rec-5')).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
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
  it('mapeia cobranca liquidada (CONCLUIDA) para PAID', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: {
        txid: 'txid-1',
        status: 'CONCLUIDA',
        pix: [{ endToEndId: 'E123', horario: '2026-09-20T10:00:00Z' }],
      },
    } as never);

    const result = await getChargeByTxid('txid-1');

    expect(result.status).toBe('PAID');
    expect(result.rawStatus).toBe('CONCLUIDA');
    expect(result.endToEndId).toBe('E123');
    expect(result.paidAt).toBe('2026-09-20T10:00:00Z');
  });
});

describe('mapeamento de status de cobranca', () => {
  const cases: Array<[string, string]> = [
    ['CRIADA', 'CREATED'],
    ['ATIVA', 'CREATED'],
    ['CONCLUIDA', 'PAID'],
    ['EXPIRADA', 'FAILED'],
    ['REJEITADA', 'FAILED'],
    ['CANCELADA', 'CANCELED'],
  ];

  it.each(cases)('mapeia status documentado do Inter %s para %s', async (interStatus, expected) => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { txid: 'txid-1', status: interStatus },
    } as never);

    const result = await getChargeByTxid('txid-1');

    expect(result.status).toBe(expected);
    expect(result.rawStatus).toBe(interStatus);
  });

  it('mapeia status desconhecido para UNKNOWN preservando rawStatus, nunca para PAID', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { txid: 'txid-1', status: 'ALGO_NOVO' },
    } as never);

    const result = await getChargeByTxid('txid-1');

    expect(result.status).toBe('UNKNOWN');
    expect(result.rawStatus).toBe('ALGO_NOVO');
  });
});
