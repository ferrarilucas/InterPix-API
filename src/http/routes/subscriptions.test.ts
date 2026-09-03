import { randomUUID } from 'crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { config } from '../../shared/config';
import { closePool } from '../../shared/db';
import { AppError } from '../../shared/errors';
import * as inter from '../../providers/inter/pixAutomatico';
import {
  addDays,
  businessToday,
  MIN_LEAD_DAYS,
  minimumFirstDueDate,
} from '../../domain/schedule';

const app = createApp();
const auth = { Authorization: `Bearer ${config.apiToken}` };
const runId = randomUUID();

const validBody = {
  externalUserId: 'usr_1',
  planCode: 'mensal_29_90',
  amount: '29.90',
  intervalMonths: 1,
  firstDueDate: '2026-12-20',
  debtor: { taxId: '12345678901', name: 'Fulano de Tal' },
};

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closePool();
});

describe('POST /subscriptions', () => {
  it('cria a assinatura em PENDING_AUTH e devolve o payload de autorizacao', async () => {
    vi.spyOn(inter, 'createRecurrence').mockResolvedValue({
      recId: `rec-9-${runId}`,
      status: 'CREATED',
      rawStatus: 'CRIADA',
    });
    vi.spyOn(inter, 'requestAuthorization').mockResolvedValue({
      recId: `rec-9-${runId}`,
      status: 'PENDING_AUTH',
      rawStatus: 'PENDENTE',
      solicrecId: `sol-9-${runId}`,
      pixCopyPaste: '00020126aaa',
      url: 'https://inter/autorizacao/9',
    });

    const response = await request(app).post('/subscriptions').set(auth).send(validBody);

    expect(response.status).toBe(201);
    expect(response.body.status).toBe('PENDING_AUTH');
    expect(response.body.authorization.pixCopyPaste).toBe('00020126aaa');
    expect(response.body.id).toBeTruthy();
  });

  it('recusa body invalido com 400 e detalhes de validacao', async () => {
    const response = await request(app)
      .post('/subscriptions')
      .set(auth)
      .send({ ...validBody, amount: 'nao-e-numero' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('BAD_REQUEST');
  });

  it('recusa firstDueDate no passado', async () => {
    const response = await request(app)
      .post('/subscriptions')
      .set(auth)
      .send({ ...validBody, firstDueDate: '2020-01-01' });

    expect(response.status).toBe(400);
  });

  it('recusa firstDueDate dentro da janela impossivel de enviar', async () => {
    const tooSoon = addDays(businessToday(), MIN_LEAD_DAYS - 1);

    const response = await request(app)
      .post('/subscriptions')
      .set(auth)
      .send({ ...validBody, firstDueDate: tooSoon });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain('antecedencia');
  });

  it('aceita firstDueDate exatamente no lead minimo configurado', async () => {
    const recId = `rec-lead-${randomUUID()}`;
    vi.spyOn(inter, 'createRecurrence').mockResolvedValue({
      recId,
      status: 'CREATED',
      rawStatus: 'CRIADA',
    });
    vi.spyOn(inter, 'requestAuthorization').mockResolvedValue({
      recId,
      status: 'PENDING_AUTH',
      rawStatus: 'PENDENTE',
      solicrecId: `sol-lead-${recId}`,
    });

    const response = await request(app)
      .post('/subscriptions')
      .set(auth)
      .send({
        ...validBody,
        externalUserId: `usr_lead_${recId}`,
        firstDueDate: minimumFirstDueDate(businessToday(), config.chargeLeadDays),
      });

    expect(response.status).toBe(201);
  });

  it('devolve 502 sem vazar detalhe quando o Inter falha', async () => {
    vi.spyOn(inter, 'createRecurrence').mockRejectedValue(AppError.upstream());

    const response = await request(app).post('/subscriptions').set(auth).send(validBody);

    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).not.toContain('segredo');
  });

  it('exige autenticacao', async () => {
    const response = await request(app).post('/subscriptions').send(validBody);
    expect(response.status).toBe(401);
  });
});

describe('GET /subscriptions/:id', () => {
  it('devolve a assinatura com a lista de ciclos', async () => {
    vi.spyOn(inter, 'createRecurrence').mockResolvedValue({
      recId: `rec-10-${runId}`,
      status: 'CREATED',
      rawStatus: 'CRIADA',
    });
    vi.spyOn(inter, 'requestAuthorization').mockResolvedValue({
      recId: `rec-10-${runId}`,
      status: 'PENDING_AUTH',
      rawStatus: 'PENDENTE',
      pixCopyPaste: '00020126bbb',
    });

    const created = await request(app).post('/subscriptions').set(auth).send(validBody);
    const response = await request(app).get(`/subscriptions/${created.body.id}`).set(auth);

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(created.body.id);
    expect(Array.isArray(response.body.cycles)).toBe(true);
  });

  it('devolve 404 para assinatura inexistente', async () => {
    const response = await request(app)
      .get('/subscriptions/00000000-0000-0000-0000-000000000000')
      .set(auth);

    expect(response.status).toBe(404);
  });
});
