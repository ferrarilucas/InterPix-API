import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { config } from '../../shared/config';

const app = createApp();

describe('requireAuth', () => {
  it('libera o health check sem token', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
  });

  it('recusa requisicao sem header Authorization', async () => {
    const response = await request(app).get('/subscriptions/qualquer');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHORIZED');
  });

  it('recusa token errado do mesmo tamanho', async () => {
    const wrong = 'x'.repeat(config.apiToken.length);
    const response = await request(app)
      .get('/subscriptions/qualquer')
      .set('Authorization', `Bearer ${wrong}`);
    expect(response.status).toBe(401);
  });

  it('recusa token de tamanho diferente sem estourar excecao', async () => {
    const response = await request(app)
      .get('/subscriptions/qualquer')
      .set('Authorization', 'Bearer curto');
    expect(response.status).toBe(401);
  });

  it('nao devolve detalhe interno no corpo do erro', async () => {
    const response = await request(app).get('/subscriptions/qualquer');
    expect(JSON.stringify(response.body)).not.toContain(config.apiToken);
  });
});
