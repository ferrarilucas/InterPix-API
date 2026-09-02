import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequestLogger, logger, maskTaxId } from './logger';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('maskTaxId', () => {
  it('mantem apenas os tres ultimos digitos de um CPF', () => {
    expect(maskTaxId('12345678901')).toBe('********901');
  });

  it('mantem apenas os tres ultimos digitos de um CNPJ', () => {
    expect(maskTaxId('12345678000199')).toBe('***********199');
  });

  it('mascara tudo quando o valor e curto demais', () => {
    expect(maskTaxId('12')).toBe('**');
  });
});

describe('logger', () => {
  it('emite JSON com level, message e timestamp', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    logger.info('assinatura criada', { subscriptionId: 'abc' });

    const emitted = JSON.parse(spy.mock.calls[0][0] as string);
    expect(emitted.level).toBe('info');
    expect(emitted.message).toBe('assinatura criada');
    expect(emitted.subscriptionId).toBe('abc');
    expect(typeof emitted.timestamp).toBe('string');
  });

  it('mascara qualquer campo chamado taxId em qualquer profundidade', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    logger.info('devedor', { debtor: { taxId: '12345678901', name: 'Fulano' } });

    const emitted = JSON.parse(spy.mock.calls[0][0] as string);
    expect(emitted.debtor.taxId).toBe('********901');
    expect(emitted.debtor.name).toBe('Fulano');
  });

  it('carrega o requestId em toda saida do logger de request', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    createRequestLogger('req-1').info('entrou');

    const emitted = JSON.parse(spy.mock.calls[0][0] as string);
    expect(emitted.requestId).toBe('req-1');
  });
});
