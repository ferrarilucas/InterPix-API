type Level = 'info' | 'warn' | 'error';

const SENSITIVE_KEYS = new Set(['taxId', 'cpf', 'cnpj', 'debtorTaxId', 'tax_id']);

export function maskTaxId(value: string): string {
  if (value.length <= 3) {
    return '*'.repeat(value.length);
  }
  return '*'.repeat(value.length - 3) + value.slice(-3);
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key) && typeof inner === 'string') {
        result[key] = maskTaxId(inner);
      } else {
        result[key] = sanitize(inner);
      }
    }
    return result;
  }

  return value;
}

function emit(level: Level, message: string, meta: Record<string, unknown>): void {
  const sanitized = sanitize(meta) as Record<string, unknown>;
  console.log(
    JSON.stringify({
      level,
      message,
      timestamp: new Date().toISOString(),
      ...sanitized,
    }),
  );
}

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

function build(base: Record<string, unknown>): Logger {
  return {
    info: (message, meta = {}) => emit('info', message, { ...base, ...meta }),
    warn: (message, meta = {}) => emit('warn', message, { ...base, ...meta }),
    error: (message, meta = {}) => emit('error', message, { ...base, ...meta }),
  };
}

export const logger = build({});

export function createRequestLogger(requestId: string): Logger {
  return build({ requestId });
}
