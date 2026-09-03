import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from './app';
import { config } from '../shared/config';

const app = createApp();

describe('app', () => {
  it('responde 404 com corpo padronizado em rota inexistente', async () => {
    const response = await request(app)
      .get('/nao-existe')
      .set('Authorization', `Bearer ${config.apiToken}`);
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('devolve 400 quando o corpo nao e um JSON valido', async () => {
    const response = await request(app)
      .post('/subscriptions')
      .set('Authorization', `Bearer ${config.apiToken}`)
      .set('Content-Type', 'application/json')
      .send('{"externalUserId":');

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('BAD_REQUEST');
  });

  it('devolve o requestId no header da resposta', async () => {
    const response = await request(app).get('/health');
    expect(response.headers['x-request-id']).toBeTruthy();
  });
});
