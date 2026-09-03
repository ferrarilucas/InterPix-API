import { describe, expect, it } from 'vitest';
import {
  addMonths,
  businessToday,
  canCancelCycle,
  isDunningWindowOver,
  isSendWindowMissed,
  isWithinSendWindow,
  minimumFirstDueDate,
  nextRetryDate,
  shouldSendCharge,
} from './schedule';

describe('businessToday', () => {
  it('usa a data do horario de Brasilia perto da meia-noite UTC, nao a data UTC', () => {
    const result = businessToday(new Date('2026-09-20T23:30:00-03:00'));
    expect(result).toBe('2026-09-20');
    expect(result).not.toBe('2026-09-21');
  });

  it('vira a data logo apos a meia-noite em Brasilia', () => {
    expect(businessToday(new Date('2026-09-21T00:30:00-03:00'))).toBe('2026-09-21');
  });

  it('coincide com a data UTC no meio do dia', () => {
    expect(businessToday(new Date('2026-09-20T12:00:00-03:00'))).toBe('2026-09-20');
  });
});

describe('isWithinSendWindow', () => {
  it('aceita envio a 10 dias do vencimento', () => {
    expect(isWithinSendWindow('2026-09-20', '2026-09-10')).toBe(true);
  });

  it('aceita envio a 2 dias do vencimento', () => {
    expect(isWithinSendWindow('2026-09-20', '2026-09-18')).toBe(true);
  });

  it('recusa envio a 11 dias do vencimento', () => {
    expect(isWithinSendWindow('2026-09-20', '2026-09-09')).toBe(false);
  });

  it('recusa envio na vespera', () => {
    expect(isWithinSendWindow('2026-09-20', '2026-09-19')).toBe(false);
  });
});

describe('shouldSendCharge', () => {
  it('dispara no dia do lead preferido', () => {
    expect(shouldSendCharge('2026-09-20', '2026-09-17')).toBe(true);
  });

  it('dispara tambem se o job atrasou, desde que ainda esteja na janela', () => {
    expect(shouldSendCharge('2026-09-20', '2026-09-18')).toBe(true);
  });

  it('dispara em qualquer dia da janela legal, inclusive no limite de 10 dias', () => {
    expect(shouldSendCharge('2026-09-20', '2026-09-10')).toBe(true);
    expect(shouldSendCharge('2026-09-20', '2026-09-16')).toBe(true);
  });

  it('nao dispara antes do limite de 10 dias', () => {
    expect(shouldSendCharge('2026-09-20', '2026-09-09')).toBe(false);
  });

  it('nao dispara depois de fechada a janela', () => {
    expect(shouldSendCharge('2026-09-20', '2026-09-19')).toBe(false);
    expect(shouldSendCharge('2026-09-20', '2026-09-20')).toBe(false);
  });
});

describe('isSendWindowMissed', () => {
  it('e falso enquanto o ciclo ainda pode ser enviado', () => {
    expect(isSendWindowMissed('2026-09-20', '2026-09-18')).toBe(false);
  });

  it('e verdadeiro quando o lead caiu abaixo de 2 dias', () => {
    expect(isSendWindowMissed('2026-09-20', '2026-09-19')).toBe(true);
    expect(isSendWindowMissed('2026-09-20', '2026-09-21')).toBe(true);
  });
});

describe('minimumFirstDueDate', () => {
  it('exige ao menos o lead configurado de folga', () => {
    expect(minimumFirstDueDate('2026-09-01', 3)).toBe('2026-09-04');
  });

  it('nunca aceita menos que o minimo legal de 2 dias', () => {
    expect(minimumFirstDueDate('2026-09-01', 1)).toBe('2026-09-03');
  });
});

describe('isDunningWindowOver', () => {
  it('nao encerra a janela no ultimo dia dela', () => {
    expect(isDunningWindowOver('2026-09-20', '2026-09-27', 7)).toBe(false);
  });

  it('encerra a janela em D+8', () => {
    expect(isDunningWindowOver('2026-09-20', '2026-09-28', 7)).toBe(true);
  });
});

describe('nextRetryDate', () => {
  it('agenda para o dia seguinte quando ainda ha janela', () => {
    expect(nextRetryDate('2026-09-20', '2026-09-21', 7)).toBe('2026-09-22');
  });

  it('devolve null quando a janela de 7 dias acabou', () => {
    expect(nextRetryDate('2026-09-20', '2026-09-27', 7)).toBeNull();
  });

  it('devolve null no ultimo dia possivel, porque a liquidacao cairia fora', () => {
    expect(nextRetryDate('2026-09-20', '2026-09-26', 7)).toBe('2026-09-27');
  });
});

describe('canCancelCycle', () => {
  it('permite cancelar dois dias antes', () => {
    expect(canCancelCycle('2026-09-20', '2026-09-18')).toBe(true);
  });

  it('permite cancelar na vespera', () => {
    expect(canCancelCycle('2026-09-20', '2026-09-19')).toBe(true);
  });

  it('recusa cancelar no dia do vencimento', () => {
    expect(canCancelCycle('2026-09-20', '2026-09-20')).toBe(false);
  });

  it('recusa cancelar depois do vencimento', () => {
    expect(canCancelCycle('2026-09-20', '2026-09-25')).toBe(false);
  });
});

describe('addMonths', () => {
  it('avanca um mes simples', () => {
    expect(addMonths('2026-09-12', 1)).toBe('2026-10-12');
  });

  it('avanca doze meses', () => {
    expect(addMonths('2026-09-12', 12)).toBe('2027-09-12');
  });

  it('ancora no ultimo dia do mes quando o destino e mais curto', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
  });
});
