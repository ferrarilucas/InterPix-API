import { AxiosError } from 'axios';
import { api } from '../../shared/api';
import { AppError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import {
  ChargeResponse,
  CreateChargeInput,
  CreateRecurrenceInput,
  RecurrenceResponse,
} from './types';

function fail(operation: string, error: unknown): never {
  const axiosError = error as AxiosError;
  logger.error('falha na api do inter', {
    operation,
    status: axiosError.response?.status,
    body: axiosError.response?.data,
    message: axiosError.message,
  });
  throw AppError.upstream();
}

function periodicidadeFromMonths(intervalMonths: number): string {
  if (intervalMonths === 12) {
    return 'ANUAL';
  }
  if (intervalMonths === 6) {
    return 'SEMESTRAL';
  }
  if (intervalMonths === 3) {
    return 'TRIMESTRAL';
  }
  return 'MENSAL';
}

function toRecurrenceBody(input: CreateRecurrenceInput): Record<string, unknown> {
  return {
    vinculo: {
      devedor: { cpf: input.debtorTaxId, nome: input.debtorName },
      objeto: input.planCode,
    },
    calendario: {
      dataInicial: input.firstDueDate,
      periodicidade: periodicidadeFromMonths(input.intervalMonths),
    },
    valor: { valorRec: input.amount },
    politicaRetentativa: 'PERMITE_3R_7D',
  };
}

function toRecurrence(data: Record<string, unknown>): RecurrenceResponse {
  const dadosQR = data.dadosQR as Record<string, unknown> | undefined;
  const loc = data.loc as Record<string, unknown> | undefined;
  return {
    recId: String(data.idRec),
    status: String(data.status),
    solicrecId: data.idSolicRec ? String(data.idSolicRec) : undefined,
    pixCopyPaste: dadosQR?.pixCopiaECola ? String(dadosQR.pixCopiaECola) : undefined,
    url: loc?.location ? String(loc.location) : undefined,
  };
}

function toChargeBody(input: CreateChargeInput): Record<string, unknown> {
  return {
    idRec: input.recId,
    calendario: { dataDeVencimento: input.dueDate },
    valor: { original: input.amount },
    ajusteDiaUtil: true,
  };
}

function toCharge(data: Record<string, unknown>): ChargeResponse {
  const pix = data.pix as Array<Record<string, unknown>> | undefined;
  const latestPix = pix && pix.length > 0 ? pix[pix.length - 1] : undefined;
  return {
    txid: String(data.txid),
    status: String(data.status),
    endToEndId: latestPix?.endToEndId
      ? String(latestPix.endToEndId)
      : data.endToEndId
        ? String(data.endToEndId)
        : undefined,
    paidAt: latestPix?.horario
      ? String(latestPix.horario)
      : data.horario
        ? String(data.horario)
        : undefined,
    failureReason: data.motivoRejeicao ? String(data.motivoRejeicao) : undefined,
  };
}

export async function createRecurrence(
  input: CreateRecurrenceInput,
): Promise<RecurrenceResponse> {
  try {
    const response = await api.post('/pix/v2/rec', toRecurrenceBody(input), {
      headers: { 'Content-Type': 'application/json' },
    });
    return toRecurrence(response.data);
  } catch (error) {
    fail('createRecurrence', error);
  }
}

export async function requestAuthorization(
  recId: string,
  input: { payerRequest?: string } = {},
): Promise<RecurrenceResponse> {
  void input;
  const dataExpiracaoSolicitacao = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  try {
    const response = await api.post(
      '/pix/v2/solicrec',
      {
        idRec: recId,
        calendario: { dataExpiracaoSolicitacao },
      },
      { headers: { 'Content-Type': 'application/json' } },
    );
    return toRecurrence(response.data);
  } catch (error) {
    fail('requestAuthorization', error);
  }
}

export async function getRecurrence(recId: string): Promise<RecurrenceResponse> {
  try {
    const response = await api.get(`/pix/v2/rec/${recId}`);
    return toRecurrence(response.data);
  } catch (error) {
    fail('getRecurrence', error);
  }
}

export async function cancelRecurrence(recId: string): Promise<void> {
  try {
    await api.patch(
      `/pix/v2/rec/${recId}`,
      { status: 'CANCELADA' },
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    fail('cancelRecurrence', error);
  }
}

export async function createCharge(input: CreateChargeInput): Promise<ChargeResponse> {
  try {
    const response = await api.put(`/pix/v2/cobr/${input.txid}`, toChargeBody(input), {
      headers: { 'Content-Type': 'application/json' },
    });
    return toCharge(response.data);
  } catch (error) {
    fail('createCharge', error);
  }
}

export async function getChargeByTxid(txid: string): Promise<ChargeResponse> {
  try {
    const response = await api.get(`/pix/v2/cobr/${txid}`);
    return toCharge(response.data);
  } catch (error) {
    fail('getChargeByTxid', error);
  }
}
