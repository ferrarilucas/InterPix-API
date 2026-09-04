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
  INTER_RECEBEDOR_NOME: 'Empresa de Teste Ltda',
  INTER_RECEBEDOR_CNPJ: '12345678000199',
  INTER_RECEBEDOR_AGENCIA: '0001',
  INTER_RECEBEDOR_CONTA: '1234567',
  INTER_RECEBEDOR_TIPO_CONTA: 'CORRENTE',
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

  it('aceita os limites inclusivos de chargeLeadDays (Bacen 2-10)', () => {
    const config2 = loadConfig({ ...validEnv, CHARGE_LEAD_DAYS: '2' });
    expect(config2.chargeLeadDays).toBe(2);

    const config10 = loadConfig({ ...validEnv, CHARGE_LEAD_DAYS: '10' });
    expect(config10.chargeLeadDays).toBe(10);
  });

  it('rejeita dunningWindowDays fora da janela permitida', () => {
    expect(() => loadConfig({ ...validEnv, DUNNING_WINDOW_DAYS: '0' })).toThrow(
      /DUNNING_WINDOW_DAYS/,
    );
    expect(() => loadConfig({ ...validEnv, DUNNING_WINDOW_DAYS: '8' })).toThrow(
      /DUNNING_WINDOW_DAYS/,
    );
  });

  it('aceita os limites inclusivos de dunningWindowDays (1-7)', () => {
    const config1 = loadConfig({ ...validEnv, DUNNING_WINDOW_DAYS: '1' });
    expect(config1.dunningWindowDays).toBe(1);

    const config7 = loadConfig({ ...validEnv, DUNNING_WINDOW_DAYS: '7' });
    expect(config7.dunningWindowDays).toBe(7);
  });

  it('rejeita API_TOKEN curto demais', () => {
    expect(() => loadConfig({ ...validEnv, API_TOKEN: 'curto' })).toThrow(/API_TOKEN/);
  });

  it('lista todas as variaveis ausentes numa unica mensagem', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*PIX_KEY/);
  });

  it('rejeita INTER_RECEBEDOR_CNPJ com tamanho diferente de 14 digitos', () => {
    expect(() =>
      loadConfig({ ...validEnv, INTER_RECEBEDOR_CNPJ: '123' }),
    ).toThrow(/INTER_RECEBEDOR_CNPJ/);
  });

  it('rejeita INTER_RECEBEDOR_TIPO_CONTA fora do enum aceito pelo Inter', () => {
    expect(() =>
      loadConfig({ ...validEnv, INTER_RECEBEDOR_TIPO_CONTA: 'INVESTIMENTO' }),
    ).toThrow(/INTER_RECEBEDOR_TIPO_CONTA/);
  });

  it('carrega os dados do recebedor configurados no ambiente', () => {
    const config = loadConfig(validEnv);

    expect(config.interRecebedorNome).toBe('Empresa de Teste Ltda');
    expect(config.interRecebedorCnpj).toBe('12345678000199');
    expect(config.interRecebedorAgencia).toBe('0001');
    expect(config.interRecebedorConta).toBe('1234567');
    expect(config.interRecebedorTipoConta).toBe('CORRENTE');
  });
});
