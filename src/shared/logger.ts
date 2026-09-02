type Level = 'info' | 'warn' | 'error';

const SENSITIVE_KEYS = new Set(['taxId', 'cpf', 'cnpj', 'debtorTaxId', 'tax_id']);

export function maskTaxId(value: string): string {
  if (value.length <= 3) {
    return '*'.repeat(value.length);
  }
  return '*'.repeat(value.length - 3) + value.slice(-3);
}

function sanitize(value: unknown, visited = new WeakSet<object>()): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    if (visited.has(value)) {
      return '[Circular]';
    }

    visited.add(value);
    const result = value.map(item => sanitize(item, visited));
    visited.delete(value);
    return result;
  }

  if (value !== null && typeof value === 'object') {
    if (visited.has(value)) {
      return '[Circular]';
    }

    visited.add(value);

    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key) && inner != null) {
        result[key] = maskTaxId(String(inner));
      } else {
        result[key] = sanitize(inner, visited);
      }
    }

    visited.delete(value);
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
