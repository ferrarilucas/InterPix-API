import { describe, expect, it } from 'vitest';
import {
  addMonths,
  businessToday,
  canCancelCycle,
  isWithinSendWindow,
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
  it('dispara exatamente no dia do lead configurado', () => {
    expect(shouldSendCharge('2026-09-20', '2026-09-17', 3)).toBe(true);
  });

  it('dispara tambem se o job atrasou, desde que ainda esteja na janela', () => {
    expect(shouldSendCharge('2026-09-20', '2026-09-18', 3)).toBe(true);
  });

  it('nao dispara antes do lead', () => {
    expect(shouldSendCharge('2026-09-20', '2026-09-16', 3)).toBe(false);
  });

  it('nao dispara depois de fechada a janela', () => {
    expect(shouldSendCharge('2026-09-20', '2026-09-19', 3)).toBe(false);
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
