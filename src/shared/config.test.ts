import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const validEnv = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/billing',
  API_TOKEN: 'token-de-teste-com-tamanho-suficiente',
  SAAS_WEBHOOK_URL: 'https://saas.internal/webhooks/billing',
  SAAS_WEBHOOK_SECRET: 'segredo-de-teste-com-tamanho-suficiente',
  INTER_CLIENT_ID: 'client-id',
  INTER_CLIENT_SECRET: 'client-secret',
  INTER_CERT_PATH: './cert.crt',
  INTER_KEY_PATH: './cert.key',
  PIX_KEY: 'chave@pix.com',
};

describe('loadConfig', () => {
  it('aplica os defaults de janela quando as variaveis nao vem no ambiente', () => {
    const config = loadConfig(validEnv);

    expect(config.chargeLeadDays).toBe(3);
    expect(config.dunningWindowDays).toBe(7);
    expect(config.port).toBe(3000);
  });

  it('rejeita chargeLeadDays fora da janela permitida pelo Bacen', () => {
    expect(() => loadConfig({ ...validEnv, CHARGE_LEAD_DAYS: '11' })).toThrow(
      /CHARGE_LEAD_DAYS/,
    );
    expect(() => loadConfig({ ...validEnv, CHARGE_LEAD_DAYS: '1' })).toThrow(
      /CHARGE_LEAD_DAYS/,
    );
  });

  it('rejeita API_TOKEN curto demais', () => {
    expect(() => loadConfig({ ...validEnv, API_TOKEN: 'curto' })).toThrow(/API_TOKEN/);
  });

  it('lista todas as variaveis ausentes numa unica mensagem', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*PIX_KEY/);
  });
});
