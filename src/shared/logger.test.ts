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

  it('mascara taxId dentro de array de objetos', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    logger.info('devedores', { debtors: [{ taxId: '12345678901', name: 'Fulano' }] });

    const emitted = JSON.parse(spy.mock.calls[0][0] as string);
    expect(emitted.debtors[0].taxId).toBe('********901');
    expect(emitted.debtors[0].name).toBe('Fulano');
  });

  it('mascara taxId em profundidade de tres ou mais niveis', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    logger.info('aninhado', { a: { b: { c: { taxId: '12345678901' } } } });

    const emitted = JSON.parse(spy.mock.calls[0][0] as string);
    expect(emitted.a.b.c.taxId).toBe('********901');
  });

  it('preserva Date em formato ISO', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const testDate = new Date('2026-09-02T10:30:00Z');

    logger.info('evento', { settlementDate: testDate });

    const emitted = JSON.parse(spy.mock.calls[0][0] as string);
    expect(emitted.settlementDate).toBe('2026-09-02T10:30:00.000Z');
  });

  it('mascara campo sensivel com valor numerico', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    logger.info('numero', { taxId: 12345678901 });

    const emitted = JSON.parse(spy.mock.calls[0][0] as string);
    expect(emitted.taxId).toBe('********901');
  });

  it('permite referencia compartilhada nao ciclica', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const shared = { taxId: '12345678901' };
    logger.info('compartilhado', { a: shared, b: shared });

    const emitted = JSON.parse(spy.mock.calls[0][0] as string);
    expect(emitted.a.taxId).toBe('********901');
    expect(emitted.b.taxId).toBe('********901');
    expect(emitted.a.taxId).not.toBe('[Circular]');
    expect(emitted.b.taxId).not.toBe('[Circular]');
  });

  it('nao lanca erro com referencia circular', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const circular: Record<string, unknown> = { name: 'ciclo' };
    circular.self = circular;

    expect(() => {
      logger.info('circular', circular);
    }).not.toThrow();

    const jsonStr = spy.mock.calls[0][0] as string;
    expect(jsonStr).toContain('[Circular]');

    const emitted = JSON.parse(jsonStr);
    expect(emitted.name).toBe('ciclo');
  });
});
