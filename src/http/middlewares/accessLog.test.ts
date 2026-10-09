import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { closePool } from '../../shared/db';

const app = createApp();

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closePool();
});

function emittedLines(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls.map((call: unknown[]) => JSON.parse(call[0] as string));
}

async function waitForLine(
  spy: ReturnType<typeof vi.spyOn>,
  predicate: (line: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  let found: Record<string, unknown> | undefined;
  await vi.waitFor(
    () => {
      found = emittedLines(spy).find(predicate);
      expect(found).toBeDefined();
    },
    { timeout: 2000, interval: 20 },
  );
  return found as Record<string, unknown>;
}

describe('log de acesso', () => {
  it('registra o corpo, os cabecalhos e o caminho de toda chamada recebida em /webhooks', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await request(app)
      .post('/webhooks/inter/rec')
      .set('User-Agent', 'inter-webhook')
      .send({ recs: [{ idRec: 'RR123', status: 'APROVADA' }] });

    const line = await waitForLine(spy, (l) => l.message === 'webhook do inter recebido');
    expect(line.path).toBe('/webhooks/inter/rec');
    expect(line.method).toBe('POST');
    expect(line.userAgent).toBe('inter-webhook');
    expect(String(line.contentType)).toContain('application/json');
    expect(line.body).toEqual({ recs: [{ idRec: 'RR123', status: 'APROVADA' }] });
  });

  it('avisa quando o corpo do webhook nao traz idRec nem txid no nivel de cima', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await request(app).post('/webhooks/inter/rec').send({ recs: [{ idRec: 'RR123' }] });

    const line = await waitForLine(
      spy,
      (l) => l.message === 'webhook do inter sem idRec nem txid no nivel de cima',
    );
    expect(line.keys).toEqual(['recs']);
  });

  it('registra metodo, caminho e status de chamadas recusadas por falta de credencial', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await request(app).post('/webhooks/inter/pix').send({ pix: [] });

    const line = await waitForLine(
      spy,
      (l) => l.message === 'requisicao concluida' && l.path === '/webhooks/inter/pix',
    );
    expect(line.method).toBe('POST');
    expect(line.status).toBe(401);
    expect(typeof line.durationMs).toBe('number');
  });

  it('nao registra o health check', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await request(app).get('/health');

    expect(emittedLines(spy).some((l) => l.path === '/health')).toBe(false);
  });
});
