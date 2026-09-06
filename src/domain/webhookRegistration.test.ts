import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../providers/inter/pixAutomatico', () => ({
  getWebhook: vi.fn(),
  putWebhook: vi.fn(),
}));

vi.mock('../shared/config', () => ({
  config: { interWebhookBaseUrl: 'https://api.exemplo.com/webhooks/inter' },
}));

import { getWebhook, putWebhook } from '../providers/inter/pixAutomatico';
import { ensureWebhooks } from './webhookRegistration';

const getWebhookMock = vi.mocked(getWebhook);
const putWebhookMock = vi.mocked(putWebhook);

describe('ensureWebhooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    putWebhookMock.mockResolvedValue(undefined);
  });

  it('registra os dois webhooks quando nenhum existe', async () => {
    getWebhookMock.mockResolvedValue(null);

    const result = await ensureWebhooks();

    expect(putWebhookMock).toHaveBeenCalledWith('rec', 'https://api.exemplo.com/webhooks/inter');
    expect(putWebhookMock).toHaveBeenCalledWith('cobr', 'https://api.exemplo.com/webhooks/inter');
    expect(result).toEqual([
      { kind: 'rec', action: 'REGISTERED' },
      { kind: 'cobr', action: 'REGISTERED' },
    ]);
  });

  it('nao reescreve quando a url ja esta correta', async () => {
    getWebhookMock.mockResolvedValue('https://api.exemplo.com/webhooks/inter');

    const result = await ensureWebhooks();

    expect(putWebhookMock).not.toHaveBeenCalled();
    expect(result).toEqual([
      { kind: 'rec', action: 'ALREADY_CORRECT' },
      { kind: 'cobr', action: 'ALREADY_CORRECT' },
    ]);
  });

  it('reescreve quando a url cadastrada aponta para outro lugar', async () => {
    getWebhookMock.mockResolvedValue('https://dominio-antigo.com/webhooks/inter');

    const result = await ensureWebhooks();

    expect(putWebhookMock).toHaveBeenCalledTimes(2);
    expect(result.every((entry) => entry.action === 'UPDATED')).toBe(true);
  });

  it('ignora barra final ao comparar a url cadastrada', async () => {
    getWebhookMock.mockResolvedValue('https://api.exemplo.com/webhooks/inter/');

    const result = await ensureWebhooks();

    expect(putWebhookMock).not.toHaveBeenCalled();
    expect(result.every((entry) => entry.action === 'ALREADY_CORRECT')).toBe(true);
  });

  it('nao deixa a falha de um webhook impedir o outro', async () => {
    getWebhookMock.mockResolvedValue(null);
    putWebhookMock.mockRejectedValueOnce(new Error('inter fora do ar'));

    const result = await ensureWebhooks();

    expect(putWebhookMock).toHaveBeenCalledTimes(2);
    expect(result[0]).toEqual({ kind: 'rec', action: 'FAILED', error: 'inter fora do ar' });
    expect(result[1]).toEqual({ kind: 'cobr', action: 'REGISTERED' });
  });

  it('nao propaga excecao quando o inter esta indisponivel', async () => {
    getWebhookMock.mockRejectedValue(new Error('timeout'));

    await expect(ensureWebhooks()).resolves.toEqual([
      { kind: 'rec', action: 'FAILED', error: 'timeout' },
      { kind: 'cobr', action: 'FAILED', error: 'timeout' },
    ]);
  });
});
