import axios, { AxiosError } from 'axios';
import { api } from '../../shared/api';
import { AppError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import {
  ChargeResponse,
  ChargeStatus,
  CreateChargeInput,
  CreateRecurrenceInput,
  RecurrenceResponse,
  RecurrenceStatus,
} from './types';

const RECURRENCE_STATUS_MAP: Record<string, RecurrenceStatus> = {
  CRIADA: 'CREATED',
  ENVIADA: 'PENDING_AUTH',
  RECEBIDA: 'PENDING_AUTH',
  APROVADA: 'APPROVED',
  ACEITA: 'APPROVED',
  REJEITADA: 'DENIED',
  EXPIRADA: 'DENIED',
  CANCELADA: 'CANCELED',
};

const CHARGE_STATUS_MAP: Record<string, ChargeStatus> = {
  CRIADA: 'CREATED',
  ATIVA: 'CREATED',
  CONCLUIDA: 'PAID',
  EXPIRADA: 'FAILED',
  REJEITADA: 'FAILED',
  CANCELADA: 'CANCELED',
};

function mapRecurrenceStatus(raw: string): RecurrenceStatus {
  return RECURRENCE_STATUS_MAP[raw] ?? 'UNKNOWN';
}

function mapChargeStatus(raw: string): ChargeStatus {
  return CHARGE_STATUS_MAP[raw] ?? 'UNKNOWN';
}

function fail(operation: string, error: unknown): never {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError;
    logger.error('falha na api do inter', {
      operation,
      status: axiosError.response?.status,
      body: axiosError.response?.data,
      message: axiosError.message,
    });
    throw AppError.upstream();
  }

  logger.error('falha na api do inter', {
    operation,
    message: error instanceof Error ? error.message : String(error),
  });
  throw AppError.upstream();
}

const ALREADY_GONE_HINTS = ['cancelad', 'nao encontrad', 'nao existe', 'inexistent', 'not found'];

function isRecurrenceAlreadyGone(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return false;
  }

  const status = error.response?.status;

  if (status === 404) {
    return true;
  }

  if (status !== 400) {
    return false;
  }

  const body = JSON.stringify(error.response?.data ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  return ALREADY_GONE_HINTS.some((hint) => body.includes(hint));
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

function devedorFrom(input: CreateRecurrenceInput): Record<string, unknown> {
  if (input.debtorTaxId.length === 14) {
    return { cnpj: input.debtorTaxId, nome: input.debtorName };
  }
  return { cpf: input.debtorTaxId, nome: input.debtorName };
}

function toRecurrenceBody(input: CreateRecurrenceInput): Record<string, unknown> {
  return {
    vinculo: {
      devedor: devedorFrom(input),
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
  const rawStatus = String(data.status);
  return {
    recId: String(data.idRec),
    status: mapRecurrenceStatus(rawStatus),
    rawStatus,
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
  const rawStatus = String(data.status);
  return {
    txid: String(data.txid),
    status: mapChargeStatus(rawStatus),
    rawStatus,
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
    if (isRecurrenceAlreadyGone(error)) {
      logger.warn('recorrencia ja cancelada ou inexistente no inter', {
        operation: 'cancelRecurrence',
        status: axios.isAxiosError(error) ? error.response?.status : undefined,
      });
      return;
    }

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
