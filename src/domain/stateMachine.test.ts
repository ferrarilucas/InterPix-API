import { describe, expect, it } from 'vitest';
import { assertCycleTransition, assertSubscriptionTransition } from './stateMachine';

describe('assertSubscriptionTransition', () => {
  it('permite PENDING_AUTH para ACTIVE', () => {
    expect(() => assertSubscriptionTransition('PENDING_AUTH', 'ACTIVE')).not.toThrow();
  });

  it('permite PAST_DUE voltar para ACTIVE quando a retentativa paga', () => {
    expect(() => assertSubscriptionTransition('PAST_DUE', 'ACTIVE')).not.toThrow();
  });

  it('recusa ressuscitar assinatura cancelada', () => {
    expect(() => assertSubscriptionTransition('CANCELED', 'ACTIVE')).toThrow(
      /INVALID_TRANSITION|nao permitida/,
    );
  });

  it('recusa pular de PENDING_AUTH direto para SUSPENDED', () => {
    expect(() => assertSubscriptionTransition('PENDING_AUTH', 'SUSPENDED')).toThrow();
  });

  it('permite transicao para o mesmo estado sem erro', () => {
    expect(() => assertSubscriptionTransition('ACTIVE', 'ACTIVE')).not.toThrow();
  });

  it('recusa reativar assinatura suspensa', () => {
    expect(() => assertSubscriptionTransition('SUSPENDED', 'ACTIVE')).toThrow(
      /INVALID_TRANSITION|nao permitida/,
    );
  });

  it('permite CANCELED voltar para si mesmo sem erro', () => {
    expect(() => assertSubscriptionTransition('CANCELED', 'CANCELED')).not.toThrow();
  });

  it('permite AUTH_DENIED voltar para si mesmo sem erro', () => {
    expect(() => assertSubscriptionTransition('AUTH_DENIED', 'AUTH_DENIED')).not.toThrow();
  });
});

describe('assertCycleTransition', () => {
  it('permite SCHEDULED para SENT', () => {
    expect(() => assertCycleTransition('SCHEDULED', 'SENT')).not.toThrow();
  });

  it('permite FAILED para RETRYING', () => {
    expect(() => assertCycleTransition('FAILED', 'RETRYING')).not.toThrow();
  });

  it('permite RETRYING para PAID', () => {
    expect(() => assertCycleTransition('RETRYING', 'PAID')).not.toThrow();
  });

  it('recusa reabrir um ciclo pago', () => {
    expect(() => assertCycleTransition('PAID', 'FAILED')).toThrow();
  });

  it('recusa cancelar um ciclo ja abandonado', () => {
    expect(() => assertCycleTransition('ABANDONED', 'CANCELED')).toThrow();
  });

  it('permite PAID voltar para si mesmo sem erro', () => {
    expect(() => assertCycleTransition('PAID', 'PAID')).not.toThrow();
  });

  it('permite ABANDONED voltar para si mesmo sem erro', () => {
    expect(() => assertCycleTransition('ABANDONED', 'ABANDONED')).not.toThrow();
  });
});
