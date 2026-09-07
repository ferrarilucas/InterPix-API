import { getWebhook, putWebhook } from '../providers/inter/pixAutomatico';
import { WebhookKind } from '../providers/inter/types';
import { config } from '../shared/config';
import { logger } from '../shared/logger';

export type WebhookAction = 'ALREADY_CORRECT' | 'REGISTERED' | 'UPDATED' | 'FAILED';

export interface WebhookCheck {
  kind: WebhookKind;
  action: WebhookAction;
  error?: string;
}

const KINDS: WebhookKind[] = ['rec', 'cobr'];

export const INTER_WEBHOOK_PATH = '/webhooks/inter';

export function interWebhookUrl(): string {
  return `${config.appBaseUrl}${INTER_WEBHOOK_PATH}`;
}

function normalize(url: string): string {
  return url.replace(/\/+$/, '');
}

async function ensureOne(kind: WebhookKind, desired: string): Promise<WebhookCheck> {
  try {
    const current = await getWebhook(kind);

    if (current && normalize(current) === normalize(desired)) {
      return { kind, action: 'ALREADY_CORRECT' };
    }

    await putWebhook(kind, desired);

    return { kind, action: current ? 'UPDATED' : 'REGISTERED' };
  } catch (error) {
    return { kind, action: 'FAILED', error: (error as Error).message };
  }
}

export async function ensureWebhooks(): Promise<WebhookCheck[]> {
  const desired = interWebhookUrl();
  const results: WebhookCheck[] = [];

  for (const kind of KINDS) {
    results.push(await ensureOne(kind, desired));
  }

  return results;
}

export async function ensureWebhooksAndLog(): Promise<WebhookCheck[]> {
  const results = await ensureWebhooks();

  for (const result of results) {
    if (result.action === 'FAILED') {
      logger.error('webhook do inter nao pode ser verificado nem cadastrado', {
        kind: result.kind,
        message: result.error,
      });
    } else if (result.action !== 'ALREADY_CORRECT') {
      logger.info('webhook do inter cadastrado', {
        kind: result.kind,
        action: result.action,
        url: interWebhookUrl(),
      });
    }
  }

  return results;
}
