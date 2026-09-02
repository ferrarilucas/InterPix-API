# Assinaturas por Pix Automático — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transformar a InterPix-API em um serviço de assinaturas por Pix Automático, consumido server-side por um SaaS em Next.js, com estado de pagamento próprio, retentativas dentro das regras do Bacen e notificação por webhook assinado.

**Architecture:** Processo Express único com jobs `node-cron` no mesmo container, dividido em camadas (`http`, `domain`, `providers/inter`, `repositories`, `jobs`, `shared`). Postgres próprio (database `billing`) acessado via `pg` com SQL puro. Webhook do Inter é apenas gatilho: todo evento é confirmado por consulta autenticada à API do Inter antes de mudar estado.

**Tech Stack:** TypeScript 5.8 (CommonJS, target es2020), Node 18, Express 4, `pg`, Zod 4, axios, node-cron, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-02-pix-automatico-assinaturas-design.md`

## Global Constraints

- Node 18, TypeScript `strict: true`, módulo CommonJS, saída em `dist/` via `tsc`.
- **Nenhum comentário no código.** Nomes descritivos no lugar de comentários.
- Toda entrada HTTP validada com Zod antes de chegar ao domínio.
- Erro do Inter nunca é repassado cru na resposta HTTP; log interno completo, resposta genérica.
- CPF/CNPJ sempre mascarado em log.
- `events` é append-only: sem `UPDATE`, sem `DELETE`.
- Transição de status só pela função do domínio; nenhum repositório escreve `status` livremente.
- Janela de envio da `cobr`: entre 10 e 2 dias antes do vencimento. Default `CHARGE_LEAD_DAYS=3`.
- Janela de retentativa: 7 dias após o vencimento (`DUNNING_WINDOW_DAYS=7`).
- Retentativa reusa o mesmo `txid` do ciclo; muda apenas a data prevista.
- A `rec` é sempre criada com retentativa habilitada.
- Testes rodam contra um Postgres real apontado por `DATABASE_URL_TEST`.

---

### Task 1: Infraestrutura de testes e módulo de configuração

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`
- Create: `src/shared/config.ts`
- Create: `src/shared/config.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: nada
- Produces: `config` — objeto congelado com `databaseUrl: string`, `apiToken: string`, `saasWebhookUrl: string`, `saasWebhookSecret: string`, `interClientId: string`, `interClientSecret: string`, `interCertPath: string`, `interKeyPath: string`, `pixKey: string`, `chargeLeadDays: number`, `dunningWindowDays: number`, `port: number`. Também `loadConfig(env: NodeJS.ProcessEnv): Config` para teste.

- [ ] **Step 1: Instalar dependências**

```bash
npm install pg
npm install --save-dev vitest @types/pg
```

- [ ] **Step 2: Adicionar scripts e config do Vitest**

Em `package.json`, adicionar aos `scripts`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

Criar `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
    fileParallelism: false,
  },
});
```

- [ ] **Step 3: Escrever o teste que falha**

Criar `src/shared/config.test.ts`:

```ts
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

  it('rejeita API_TOKEN curto demais', () => {
    expect(() => loadConfig({ ...validEnv, API_TOKEN: 'curto' })).toThrow(/API_TOKEN/);
  });

  it('lista todas as variaveis ausentes numa unica mensagem', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL[\s\S]*PIX_KEY/);
  });
});
```

- [ ] **Step 4: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/shared/config.test.ts`
Expected: FAIL com "Failed to resolve import './config'"

- [ ] **Step 5: Implementar `src/shared/config.ts`**

```ts
import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  API_TOKEN: z.string().min(24),
  SAAS_WEBHOOK_URL: z.string().url(),
  SAAS_WEBHOOK_SECRET: z.string().min(24),
  INTER_CLIENT_ID: z.string().min(1),
  INTER_CLIENT_SECRET: z.string().min(1),
  INTER_CERT_PATH: z.string().min(1),
  INTER_KEY_PATH: z.string().min(1),
  PIX_KEY: z.string().min(1),
  CHARGE_LEAD_DAYS: z.coerce.number().int().min(2).max(10).default(3),
  DUNNING_WINDOW_DAYS: z.coerce.number().int().min(1).max(7).default(7),
  PORT: z.coerce.number().int().positive().default(3000),
});

export interface Config {
  databaseUrl: string;
  apiToken: string;
  saasWebhookUrl: string;
  saasWebhookSecret: string;
  interClientId: string;
  interClientSecret: string;
  interCertPath: string;
  interKeyPath: string;
  pixKey: string;
  chargeLeadDays: number;
  dunningWindowDays: number;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = schema.safeParse(env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuracao invalida:\n${details}`);
  }

  const value = parsed.data;

  return Object.freeze({
    databaseUrl: value.DATABASE_URL,
    apiToken: value.API_TOKEN,
    saasWebhookUrl: value.SAAS_WEBHOOK_URL,
    saasWebhookSecret: value.SAAS_WEBHOOK_SECRET,
    interClientId: value.INTER_CLIENT_ID,
    interClientSecret: value.INTER_CLIENT_SECRET,
    interCertPath: value.INTER_CERT_PATH,
    interKeyPath: value.INTER_KEY_PATH,
    pixKey: value.PIX_KEY,
    chargeLeadDays: value.CHARGE_LEAD_DAYS,
    dunningWindowDays: value.DUNNING_WINDOW_DAYS,
    port: value.PORT,
  });
}

export const config = loadConfig(process.env);
```

- [ ] **Step 6: Rodar o teste e confirmar que passa**

Run: `npx vitest run src/shared/config.test.ts`
Expected: PASS, 4 testes

- [ ] **Step 7: Atualizar `.env.example`**

```
DATABASE_URL=postgres://billing:senha@postgres:5432/billing
DATABASE_URL_TEST=postgres://billing:senha@localhost:5432/billing_test
API_TOKEN=gere_um_token_com_no_minimo_24_caracteres
SAAS_WEBHOOK_URL=http://saas:3000/api/webhooks/billing
SAAS_WEBHOOK_SECRET=gere_um_segredo_com_no_minimo_24_caracteres

INTER_CLIENT_ID=YOUR_CLIENT_ID
INTER_CLIENT_SECRET=YOUR_CLIENT_SECRET
INTER_CERT_PATH=./cert_path.crt
INTER_KEY_PATH=./cert_path.key
PIX_KEY=YOUR_PIX_KEY

CHARGE_LEAD_DAYS=3
DUNNING_WINDOW_DAYS=7
PORT=3000
```

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/shared/config.ts src/shared/config.test.ts .env.example
git commit -m "feat: adiciona infra de testes e modulo de configuracao validado"
```

---

### Task 2: Logger estruturado com máscara de dados sensíveis

**Files:**
- Create: `src/shared/logger.ts`
- Create: `src/shared/logger.test.ts`

**Interfaces:**
- Consumes: nada
- Produces: `logger.info(message: string, meta?: Record<string, unknown>): void`, `logger.warn(...)`, `logger.error(...)`, todos com a mesma assinatura. `maskTaxId(value: string): string`. `createRequestLogger(requestId: string)` retornando um logger com `requestId` fixo em toda saída.

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/shared/logger.test.ts`:

```ts
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
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/shared/logger.test.ts`
Expected: FAIL com "Failed to resolve import './logger'"

- [ ] **Step 3: Implementar `src/shared/logger.ts`**

```ts
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
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx vitest run src/shared/logger.test.ts`
Expected: PASS, 6 testes

- [ ] **Step 5: Commit**

```bash
git add src/shared/logger.ts src/shared/logger.test.ts
git commit -m "feat: adiciona logger estruturado com mascara de dados sensiveis"
```

---

### Task 3: Pool do Postgres, runner de migrations e schema inicial

**Files:**
- Create: `src/shared/db.ts`
- Create: `src/shared/migrations.ts`
- Create: `src/shared/migrations.test.ts`
- Create: `migrations/001_initial_schema.sql`
- Create: `src/test/setup.ts`
- Modify: `vitest.config.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `config` da Task 1
- Produces: `pool: Pool`, `query<T>(text: string, params?: unknown[]): Promise<T[]>`, `withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>`, `closePool(): Promise<void>`, `runMigrations(connectionString: string): Promise<string[]>` retornando os nomes aplicados nesta execução.

- [ ] **Step 1: Criar o schema inicial**

Criar `migrations/001_initial_schema.sql` com o DDL exato da seção "Modelo de dados" do spec, precedido de:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

E os tipos e tabelas na ordem: `subscription_status`, `cycle_status`, `subscriptions`, `cycles`, `cycle_attempts`, `events`, `inter_webhook_receipts`, `webhook_deliveries`, seguidos dos quatro índices.

- [ ] **Step 2: Escrever o teste que falha**

Criar `src/shared/migrations.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { runMigrations } from './migrations';

const connectionString = process.env.DATABASE_URL_TEST as string;
let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
});

afterAll(async () => {
  await pool.end();
});

describe('runMigrations', () => {
  it('cria as tabelas do schema inicial', async () => {
    await runMigrations(connectionString);

    const result = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    const tables = result.rows.map((row) => row.table_name);

    expect(tables).toEqual(
      expect.arrayContaining([
        'subscriptions',
        'cycles',
        'cycle_attempts',
        'events',
        'inter_webhook_receipts',
        'webhook_deliveries',
        'schema_migrations',
      ]),
    );
  });

  it('e idempotente: rodar de novo nao aplica nada', async () => {
    const applied = await runMigrations(connectionString);
    expect(applied).toEqual([]);
  });
});
```

- [ ] **Step 3: Rodar o teste e confirmar que falha**

Run: `DATABASE_URL_TEST=postgres://... npx vitest run src/shared/migrations.test.ts`
Expected: FAIL com "Failed to resolve import './migrations'"

- [ ] **Step 4: Implementar `src/shared/db.ts`**

```ts
import { Pool, PoolClient } from 'pg';
import { config } from './config';

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export async function query<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
```

- [ ] **Step 5: Implementar `src/shared/migrations.ts`**

```ts
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

export async function runMigrations(connectionString: string): Promise<string[]> {
  const pool = new Pool({ connectionString });

  try {
    await pool.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );

    const applied = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(applied.rows.map((row) => row.name));

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    const executed: string[] = [];

    for (const file of files) {
      if (done.has(file)) {
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        executed.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    return executed;
  } finally {
    await pool.end();
  }
}
```

- [ ] **Step 6: Criar o setup de testes**

Criar `src/test/setup.ts`:

```ts
import { runMigrations } from '../shared/migrations';

export async function setup(): Promise<void> {
  const connectionString = process.env.DATABASE_URL_TEST;
  if (!connectionString) {
    throw new Error('DATABASE_URL_TEST nao definida');
  }
  process.env.DATABASE_URL = connectionString;
  await runMigrations(connectionString);
}
```

Em `vitest.config.ts`, adicionar dentro de `test`:

```ts
globalSetup: ['./src/test/setup.ts'],
```

Em `package.json`, adicionar aos `scripts`:

```json
"migrate": "node -e \"require('./dist/shared/migrations').runMigrations(process.env.DATABASE_URL).then(a=>console.log(a))\""
```

- [ ] **Step 7: Rodar o teste e confirmar que passa**

Run: `DATABASE_URL_TEST=postgres://... npx vitest run src/shared/migrations.test.ts`
Expected: PASS, 2 testes

- [ ] **Step 8: Commit**

```bash
git add migrations src/shared/db.ts src/shared/migrations.ts src/shared/migrations.test.ts src/test/setup.ts vitest.config.ts package.json
git commit -m "feat: adiciona pool postgres, runner de migrations e schema inicial"
```

---

### Task 4: Autenticação, tratamento de erro e esqueleto do app

**Files:**
- Create: `src/shared/errors.ts`
- Create: `src/http/middlewares/auth.ts`
- Create: `src/http/middlewares/auth.test.ts`
- Create: `src/http/middlewares/errorHandler.ts`
- Create: `src/http/middlewares/requestContext.ts`
- Create: `src/http/app.ts`
- Create: `src/http/app.test.ts`

**Interfaces:**
- Consumes: `config`, `logger`, `createRequestLogger`
- Produces: `AppError` (classe com `status: number`, `code: string`, `message: string`), `requireAuth: RequestHandler`, `requestContext: RequestHandler` (popula `req.requestId` e `req.log`), `errorHandler: ErrorRequestHandler`, `createApp(): Express`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/http/middlewares/auth.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { config } from '../../shared/config';

const app = createApp();

describe('requireAuth', () => {
  it('libera o health check sem token', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
  });

  it('recusa requisicao sem header Authorization', async () => {
    const response = await request(app).get('/subscriptions/qualquer');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHORIZED');
  });

  it('recusa token errado do mesmo tamanho', async () => {
    const wrong = 'x'.repeat(config.apiToken.length);
    const response = await request(app)
      .get('/subscriptions/qualquer')
      .set('Authorization', `Bearer ${wrong}`);
    expect(response.status).toBe(401);
  });

  it('recusa token de tamanho diferente sem estourar excecao', async () => {
    const response = await request(app)
      .get('/subscriptions/qualquer')
      .set('Authorization', 'Bearer curto');
    expect(response.status).toBe(401);
  });

  it('nao devolve detalhe interno no corpo do erro', async () => {
    const response = await request(app).get('/subscriptions/qualquer');
    expect(JSON.stringify(response.body)).not.toContain(config.apiToken);
  });
});
```

Criar `src/http/app.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from './app';

const app = createApp();

describe('app', () => {
  it('responde 404 com corpo padronizado em rota inexistente', async () => {
    const response = await request(app).get('/nao-existe');
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('devolve o requestId no header da resposta', async () => {
    const response = await request(app).get('/health');
    expect(response.headers['x-request-id']).toBeTruthy();
  });
});
```

- [ ] **Step 2: Instalar supertest e rodar o teste**

```bash
npm install --save-dev supertest @types/supertest
```

Run: `npx vitest run src/http`
Expected: FAIL com "Failed to resolve import '../app'"

- [ ] **Step 3: Implementar `src/shared/errors.ts`**

```ts
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static unauthorized(): AppError {
    return new AppError(401, 'UNAUTHORIZED', 'Credencial ausente ou invalida.');
  }

  static notFound(resource: string): AppError {
    return new AppError(404, 'NOT_FOUND', `${resource} nao encontrado.`);
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }

  static conflict(code: string, message: string): AppError {
    return new AppError(409, code, message);
  }

  static upstream(): AppError {
    return new AppError(502, 'UPSTREAM_ERROR', 'Falha na comunicacao com o provedor de pagamento.');
  }
}
```

- [ ] **Step 4: Implementar `src/http/middlewares/requestContext.ts`**

```ts
import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { createRequestLogger, Logger } from '../../shared/logger';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      log: Logger;
    }
  }
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  req.requestId = requestId;
  req.log = createRequestLogger(requestId);
  res.setHeader('X-Request-Id', requestId);
  next();
}
```

- [ ] **Step 5: Implementar `src/http/middlewares/auth.ts`**

```ts
import { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { config } from '../../shared/config';
import { AppError } from '../../shared/errors';

const expected = Buffer.from(config.apiToken);

function matches(received: string): boolean {
  const candidate = Buffer.from(received);
  if (candidate.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(candidate, expected);
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('authorization');

  if (!header || !header.startsWith('Bearer ')) {
    next(AppError.unauthorized());
    return;
  }

  if (!matches(header.slice('Bearer '.length))) {
    next(AppError.unauthorized());
    return;
  }

  next();
}
```

- [ ] **Step 6: Implementar `src/http/middlewares/errorHandler.ts`**

```ts
import { NextFunction, Request, Response } from 'express';
import { AppError } from '../../shared/errors';
import { logger } from '../../shared/logger';

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(AppError.notFound('Recurso'));
}

export function errorHandler(
  error: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const log = req.log ?? logger;

  if (error instanceof AppError) {
    if (error.status >= 500) {
      log.error('erro tratado', { code: error.code, message: error.message });
    } else {
      log.warn('requisicao recusada', { code: error.code, message: error.message });
    }
    res.status(error.status).json({
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }

  log.error('erro nao tratado', { message: error.message, stack: error.stack });
  res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno.' });
}
```

- [ ] **Step 7: Implementar `src/http/app.ts`**

```ts
import express, { Express, Request, Response } from 'express';
import { requestContext } from './middlewares/requestContext';
import { requireAuth } from './middlewares/auth';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler';

export function createApp(): Express {
  const app = express();

  app.use(express.json({ limit: '256kb' }));
  app.use(requestContext);

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use(requireAuth);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
```

- [ ] **Step 8: Rodar os testes e confirmar que passam**

Run: `npx vitest run src/http`
Expected: PASS, 7 testes

- [ ] **Step 9: Commit**

```bash
git add src/shared/errors.ts src/http package.json package-lock.json
git commit -m "feat: adiciona auth por bearer token, tratamento de erro e esqueleto do app"
```

---

### Task 5: Tipos de domínio e máquina de estados

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/domain/stateMachine.ts`
- Create: `src/domain/stateMachine.test.ts`

**Interfaces:**
- Consumes: nada
- Produces:
  - `SubscriptionStatus = 'PENDING_AUTH' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELED' | 'AUTH_DENIED'`
  - `CycleStatus = 'SCHEDULED' | 'SENT' | 'PAID' | 'FAILED' | 'RETRYING' | 'ABANDONED' | 'CANCELED'`
  - `Subscription`, `Cycle`, `CycleAttempt` (interfaces)
  - `assertSubscriptionTransition(from: SubscriptionStatus, to: SubscriptionStatus): void`
  - `assertCycleTransition(from: CycleStatus, to: CycleStatus): void`
  - Ambas lançam `AppError.conflict('INVALID_TRANSITION', ...)` quando a transição não é permitida.

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/domain/stateMachine.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/domain/stateMachine.test.ts`
Expected: FAIL com "Failed to resolve import './stateMachine'"

- [ ] **Step 3: Implementar `src/domain/types.ts`**

```ts
export type SubscriptionStatus =
  | 'PENDING_AUTH'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'SUSPENDED'
  | 'CANCELED'
  | 'AUTH_DENIED';

export type CycleStatus =
  | 'SCHEDULED'
  | 'SENT'
  | 'PAID'
  | 'FAILED'
  | 'RETRYING'
  | 'ABANDONED'
  | 'CANCELED';

export interface Subscription {
  id: string;
  externalUserId: string;
  planCode: string;
  amount: string;
  intervalMonths: number;
  status: SubscriptionStatus;
  interRecId: string | null;
  interSolicrecId: string | null;
  debtorTaxId: string;
  debtorName: string;
  nextDueDate: string | null;
  authorizedAt: string | null;
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Cycle {
  id: string;
  subscriptionId: string;
  seq: number;
  dueDate: string;
  amount: string;
  status: CycleStatus;
  interTxid: string | null;
  endToEndId: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CycleAttempt {
  id: string;
  cycleId: string;
  attemptNumber: number;
  scheduledFor: string;
  sentAt: string | null;
  outcome: string | null;
  failureReason: string | null;
  createdAt: string;
}
```

- [ ] **Step 4: Implementar `src/domain/stateMachine.ts`**

```ts
import { AppError } from '../shared/errors';
import { CycleStatus, SubscriptionStatus } from './types';

const SUBSCRIPTION_TRANSITIONS: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  PENDING_AUTH: ['ACTIVE', 'AUTH_DENIED', 'CANCELED'],
  ACTIVE: ['PAST_DUE', 'CANCELED'],
  PAST_DUE: ['ACTIVE', 'SUSPENDED', 'CANCELED'],
  SUSPENDED: ['ACTIVE', 'CANCELED'],
  CANCELED: [],
  AUTH_DENIED: [],
};

const CYCLE_TRANSITIONS: Record<CycleStatus, CycleStatus[]> = {
  SCHEDULED: ['SENT', 'CANCELED'],
  SENT: ['PAID', 'FAILED', 'CANCELED'],
  PAID: [],
  FAILED: ['RETRYING', 'ABANDONED'],
  RETRYING: ['PAID', 'FAILED', 'ABANDONED'],
  ABANDONED: [],
  CANCELED: [],
};

function assert<T extends string>(
  allowed: Record<T, T[]>,
  entity: string,
  from: T,
  to: T,
): void {
  if (from === to) {
    return;
  }

  if (!allowed[from].includes(to)) {
    throw AppError.conflict(
      'INVALID_TRANSITION',
      `Transicao de ${entity} nao permitida: ${from} -> ${to}.`,
    );
  }
}

export function assertSubscriptionTransition(
  from: SubscriptionStatus,
  to: SubscriptionStatus,
): void {
  assert(SUBSCRIPTION_TRANSITIONS, 'assinatura', from, to);
}

export function assertCycleTransition(from: CycleStatus, to: CycleStatus): void {
  assert(CYCLE_TRANSITIONS, 'ciclo', from, to);
}
```

- [ ] **Step 5: Rodar o teste e confirmar que passa**

Run: `npx vitest run src/domain/stateMachine.test.ts`
Expected: PASS, 10 testes

- [ ] **Step 6: Commit**

```bash
git add src/domain/types.ts src/domain/stateMachine.ts src/domain/stateMachine.test.ts
git commit -m "feat: adiciona tipos de dominio e maquina de estados de assinatura e ciclo"
```

---

### Task 6: Política de datas do Pix Automático

**Files:**
- Create: `src/domain/schedule.ts`
- Create: `src/domain/schedule.test.ts`

**Interfaces:**
- Consumes: `config`
- Produces:
  - `shouldSendCharge(dueDate: string, today: string, leadDays: number): boolean`
  - `isWithinSendWindow(dueDate: string, sendDate: string): boolean` — janela de 10 a 2 dias
  - `nextRetryDate(dueDate: string, today: string, windowDays: number): string | null` — `null` quando a janela acabou
  - `canCancelCycle(dueDate: string, today: string): boolean` — só até a véspera
  - `addMonths(date: string, months: number): string` — preserva fim de mês
  - Todas as datas em `YYYY-MM-DD`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/domain/schedule.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  addMonths,
  canCancelCycle,
  isWithinSendWindow,
  nextRetryDate,
  shouldSendCharge,
} from './schedule';

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
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/domain/schedule.test.ts`
Expected: FAIL com "Failed to resolve import './schedule'"

- [ ] **Step 3: Implementar `src/domain/schedule.ts`**

```ts
const MIN_LEAD_DAYS = 2;
const MAX_LEAD_DAYS = 10;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toUtc(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function toIso(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / MS_PER_DAY);
}

export function isWithinSendWindow(dueDate: string, sendDate: string): boolean {
  const lead = daysBetween(sendDate, dueDate);
  return lead >= MIN_LEAD_DAYS && lead <= MAX_LEAD_DAYS;
}

export function shouldSendCharge(dueDate: string, today: string, leadDays: number): boolean {
  const lead = daysBetween(today, dueDate);
  return lead <= leadDays && isWithinSendWindow(dueDate, today);
}

export function nextRetryDate(
  dueDate: string,
  today: string,
  windowDays: number,
): string | null {
  const target = toUtc(today) + MS_PER_DAY;
  const limit = toUtc(dueDate) + windowDays * MS_PER_DAY;

  if (target > limit) {
    return null;
  }

  return toIso(target);
}

export function canCancelCycle(dueDate: string, today: string): boolean {
  return daysBetween(today, dueDate) >= 1;
}

export function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return toIso(target.getTime());
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `npx vitest run src/domain/schedule.test.ts`
Expected: PASS, 15 testes

- [ ] **Step 5: Commit**

```bash
git add src/domain/schedule.ts src/domain/schedule.test.ts
git commit -m "feat: adiciona politica de datas do pix automatico"
```

---

### Task 7: Repositórios de assinatura, ciclo, tentativa e evento

**Files:**
- Create: `src/repositories/subscriptions.ts`
- Create: `src/repositories/cycles.ts`
- Create: `src/repositories/events.ts`
- Create: `src/repositories/subscriptions.test.ts`
- Create: `src/repositories/cycles.test.ts`
- Create: `src/test/factories.ts`

**Interfaces:**
- Consumes: `query`, `withTransaction`, tipos de `src/domain/types.ts`
- Produces:
  - `insertSubscription(input: NewSubscription): Promise<Subscription>` onde `NewSubscription = { externalUserId, planCode, amount, intervalMonths, debtorTaxId, debtorName, nextDueDate }`
  - `findSubscriptionById(id: string): Promise<Subscription | null>`
  - `findSubscriptionByRecId(recId: string): Promise<Subscription | null>`
  - `updateSubscriptionStatus(id, status, patch?: { interRecId?, interSolicrecId?, nextDueDate?, authorizedAt?, canceledAt? }): Promise<Subscription>`
  - `listActiveSubscriptionsDueFor(date: string): Promise<Subscription[]>`
  - `insertCycle(input: { subscriptionId, seq, dueDate, amount }): Promise<Cycle>`
  - `findCycleById(id: string): Promise<Cycle | null>`
  - `findCycleByTxid(txid: string): Promise<Cycle | null>`
  - `findCurrentCycle(subscriptionId: string): Promise<Cycle | null>`
  - `listCyclesByStatus(statuses: CycleStatus[]): Promise<Cycle[]>`
  - `updateCycleStatus(id, status, patch?: { interTxid?, endToEndId?, paidAt? }): Promise<Cycle>`
  - `insertCycleAttempt(input: { cycleId, attemptNumber, scheduledFor }): Promise<CycleAttempt>`
  - `countCycleAttempts(cycleId: string): Promise<number>`
  - `markAttemptOutcome(cycleId, attemptNumber, outcome, failureReason?): Promise<void>`
  - `insertEvent(input: { subscriptionId?, cycleId?, type: string, payload: unknown }): Promise<{ id: string }>`
  - `listEventsBySubscription(subscriptionId: string): Promise<Array<{ id: string; type: string; payload: unknown; createdAt: string }>>`

- [ ] **Step 1: Criar as factories de teste**

Criar `src/test/factories.ts`:

```ts
import { insertSubscription } from '../repositories/subscriptions';
import { Subscription } from '../domain/types';

let counter = 0;

export async function createSubscription(
  overrides: Partial<Parameters<typeof insertSubscription>[0]> = {},
): Promise<Subscription> {
  counter += 1;
  return insertSubscription({
    externalUserId: `usr_${counter}`,
    planCode: 'mensal_29_90',
    amount: '29.90',
    intervalMonths: 1,
    debtorTaxId: '12345678901',
    debtorName: 'Fulano de Tal',
    nextDueDate: '2026-09-20',
    ...overrides,
  });
}
```

- [ ] **Step 2: Escrever o teste que falha**

Criar `src/repositories/subscriptions.test.ts`:

```ts
import { afterAll, describe, expect, it } from 'vitest';
import { closePool } from '../shared/db';
import { createSubscription } from '../test/factories';
import {
  findSubscriptionById,
  findSubscriptionByRecId,
  listActiveSubscriptionsDueFor,
  updateSubscriptionStatus,
} from './subscriptions';

afterAll(async () => {
  await closePool();
});

describe('subscriptions repository', () => {
  it('insere com status PENDING_AUTH e devolve o registro mapeado', async () => {
    const subscription = await createSubscription();

    expect(subscription.id).toBeTruthy();
    expect(subscription.status).toBe('PENDING_AUTH');
    expect(subscription.amount).toBe('29.90');
    expect(subscription.externalUserId).toMatch(/^usr_/);
  });

  it('busca por id', async () => {
    const created = await createSubscription();
    const found = await findSubscriptionById(created.id);

    expect(found?.id).toBe(created.id);
  });

  it('devolve null para id inexistente', async () => {
    const found = await findSubscriptionById('00000000-0000-0000-0000-000000000000');
    expect(found).toBeNull();
  });

  it('atualiza status e campos do patch juntos', async () => {
    const created = await createSubscription();

    const updated = await updateSubscriptionStatus(created.id, 'ACTIVE', {
      interRecId: 'rec-123',
      authorizedAt: new Date().toISOString(),
    });

    expect(updated.status).toBe('ACTIVE');
    expect(updated.interRecId).toBe('rec-123');
    expect(updated.authorizedAt).toBeTruthy();
  });

  it('busca por rec id do Inter', async () => {
    const created = await createSubscription();
    await updateSubscriptionStatus(created.id, 'ACTIVE', { interRecId: 'rec-busca' });

    const found = await findSubscriptionByRecId('rec-busca');
    expect(found?.id).toBe(created.id);
  });

  it('lista apenas assinaturas ACTIVE com vencimento ate a data pedida', async () => {
    const dueSoon = await createSubscription({ nextDueDate: '2026-10-01' });
    const dueLater = await createSubscription({ nextDueDate: '2026-12-01' });
    const pending = await createSubscription({ nextDueDate: '2026-10-01' });

    await updateSubscriptionStatus(dueSoon.id, 'ACTIVE', { interRecId: 'rec-a' });
    await updateSubscriptionStatus(dueLater.id, 'ACTIVE', { interRecId: 'rec-b' });

    const result = await listActiveSubscriptionsDueFor('2026-10-01');
    const ids = result.map((item) => item.id);

    expect(ids).toContain(dueSoon.id);
    expect(ids).not.toContain(dueLater.id);
    expect(ids).not.toContain(pending.id);
  });
});
```

Criar `src/repositories/cycles.test.ts`:

```ts
import { afterAll, describe, expect, it } from 'vitest';
import { closePool } from '../shared/db';
import { createSubscription } from '../test/factories';
import {
  countCycleAttempts,
  findCycleByTxid,
  insertCycle,
  insertCycleAttempt,
  markAttemptOutcome,
  updateCycleStatus,
} from './cycles';

afterAll(async () => {
  await closePool();
});

describe('cycles repository', () => {
  it('insere ciclo com status SCHEDULED', async () => {
    const subscription = await createSubscription();
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-20',
      amount: '29.90',
    });

    expect(cycle.status).toBe('SCHEDULED');
    expect(cycle.seq).toBe(1);
  });

  it('recusa dois ciclos com a mesma sequencia na mesma assinatura', async () => {
    const subscription = await createSubscription();
    await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-20',
      amount: '29.90',
    });

    await expect(
      insertCycle({
        subscriptionId: subscription.id,
        seq: 1,
        dueDate: '2026-10-20',
        amount: '29.90',
      }),
    ).rejects.toThrow();
  });

  it('guarda o txid e permite buscar por ele', async () => {
    const subscription = await createSubscription();
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-20',
      amount: '29.90',
    });

    await updateCycleStatus(cycle.id, 'SENT', { interTxid: 'txid-unico-1' });
    const found = await findCycleByTxid('txid-unico-1');

    expect(found?.id).toBe(cycle.id);
    expect(found?.status).toBe('SENT');
  });

  it('acumula tentativas do mesmo ciclo compartilhando o txid', async () => {
    const subscription = await createSubscription();
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-20',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: 'txid-unico-2' });

    await insertCycleAttempt({ cycleId: cycle.id, attemptNumber: 1, scheduledFor: '2026-09-20' });
    await markAttemptOutcome(cycle.id, 1, 'FAILED', 'saldo insuficiente');
    await insertCycleAttempt({ cycleId: cycle.id, attemptNumber: 2, scheduledFor: '2026-09-22' });

    expect(await countCycleAttempts(cycle.id)).toBe(2);
    expect((await findCycleByTxid('txid-unico-2'))?.interTxid).toBe('txid-unico-2');
  });
});
```

- [ ] **Step 3: Rodar os testes e confirmar que falham**

Run: `npx vitest run src/repositories`
Expected: FAIL com "Failed to resolve import './subscriptions'"

- [ ] **Step 4: Implementar `src/repositories/subscriptions.ts`**

```ts
import { query } from '../shared/db';
import { Subscription, SubscriptionStatus } from '../domain/types';

interface SubscriptionRow {
  id: string;
  external_user_id: string;
  plan_code: string;
  amount: string;
  interval_months: number;
  status: SubscriptionStatus;
  inter_rec_id: string | null;
  inter_solicrec_id: string | null;
  debtor_tax_id: string;
  debtor_name: string;
  next_due_date: string | null;
  authorized_at: string | null;
  canceled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewSubscription {
  externalUserId: string;
  planCode: string;
  amount: string;
  intervalMonths: number;
  debtorTaxId: string;
  debtorName: string;
  nextDueDate: string;
}

export interface SubscriptionPatch {
  interRecId?: string;
  interSolicrecId?: string;
  nextDueDate?: string;
  authorizedAt?: string;
  canceledAt?: string;
}

function toDomain(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    externalUserId: row.external_user_id,
    planCode: row.plan_code,
    amount: row.amount,
    intervalMonths: row.interval_months,
    status: row.status,
    interRecId: row.inter_rec_id,
    interSolicrecId: row.inter_solicrec_id,
    debtorTaxId: row.debtor_tax_id,
    debtorName: row.debtor_name,
    nextDueDate: row.next_due_date ? String(row.next_due_date).slice(0, 10) : null,
    authorizedAt: row.authorized_at,
    canceledAt: row.canceled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function insertSubscription(input: NewSubscription): Promise<Subscription> {
  const rows = await query<SubscriptionRow>(
    `INSERT INTO subscriptions
       (external_user_id, plan_code, amount, interval_months, debtor_tax_id, debtor_name, next_due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.externalUserId,
      input.planCode,
      input.amount,
      input.intervalMonths,
      input.debtorTaxId,
      input.debtorName,
      input.nextDueDate,
    ],
  );
  return toDomain(rows[0]);
}

export async function findSubscriptionById(id: string): Promise<Subscription | null> {
  const rows = await query<SubscriptionRow>('SELECT * FROM subscriptions WHERE id = $1', [id]);
  return rows[0] ? toDomain(rows[0]) : null;
}

export async function findSubscriptionByRecId(recId: string): Promise<Subscription | null> {
  const rows = await query<SubscriptionRow>(
    'SELECT * FROM subscriptions WHERE inter_rec_id = $1',
    [recId],
  );
  return rows[0] ? toDomain(rows[0]) : null;
}

export async function updateSubscriptionStatus(
  id: string,
  status: SubscriptionStatus,
  patch: SubscriptionPatch = {},
): Promise<Subscription> {
  const rows = await query<SubscriptionRow>(
    `UPDATE subscriptions SET
       status = $2,
       inter_rec_id = COALESCE($3, inter_rec_id),
       inter_solicrec_id = COALESCE($4, inter_solicrec_id),
       next_due_date = COALESCE($5, next_due_date),
       authorized_at = COALESCE($6, authorized_at),
       canceled_at = COALESCE($7, canceled_at),
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      status,
      patch.interRecId ?? null,
      patch.interSolicrecId ?? null,
      patch.nextDueDate ?? null,
      patch.authorizedAt ?? null,
      patch.canceledAt ?? null,
    ],
  );
  return toDomain(rows[0]);
}

export async function listActiveSubscriptionsDueFor(date: string): Promise<Subscription[]> {
  const rows = await query<SubscriptionRow>(
    `SELECT * FROM subscriptions
     WHERE status = 'ACTIVE' AND next_due_date IS NOT NULL AND next_due_date <= $1
     ORDER BY next_due_date`,
    [date],
  );
  return rows.map(toDomain);
}
```

- [ ] **Step 5: Implementar `src/repositories/cycles.ts`**

```ts
import { query } from '../shared/db';
import { Cycle, CycleAttempt, CycleStatus } from '../domain/types';

interface CycleRow {
  id: string;
  subscription_id: string;
  seq: number;
  due_date: string;
  amount: string;
  status: CycleStatus;
  inter_txid: string | null;
  end_to_end_id: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AttemptRow {
  id: string;
  cycle_id: string;
  attempt_number: number;
  scheduled_for: string;
  sent_at: string | null;
  outcome: string | null;
  failure_reason: string | null;
  created_at: string;
}

function toCycle(row: CycleRow): Cycle {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    seq: row.seq,
    dueDate: String(row.due_date).slice(0, 10),
    amount: row.amount,
    status: row.status,
    interTxid: row.inter_txid,
    endToEndId: row.end_to_end_id,
    paidAt: row.paid_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAttempt(row: AttemptRow): CycleAttempt {
  return {
    id: row.id,
    cycleId: row.cycle_id,
    attemptNumber: row.attempt_number,
    scheduledFor: String(row.scheduled_for).slice(0, 10),
    sentAt: row.sent_at,
    outcome: row.outcome,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
  };
}

export async function insertCycle(input: {
  subscriptionId: string;
  seq: number;
  dueDate: string;
  amount: string;
}): Promise<Cycle> {
  const rows = await query<CycleRow>(
    `INSERT INTO cycles (subscription_id, seq, due_date, amount)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.subscriptionId, input.seq, input.dueDate, input.amount],
  );
  return toCycle(rows[0]);
}

export async function findCycleById(id: string): Promise<Cycle | null> {
  const rows = await query<CycleRow>('SELECT * FROM cycles WHERE id = $1', [id]);
  return rows[0] ? toCycle(rows[0]) : null;
}

export async function findCycleByTxid(txid: string): Promise<Cycle | null> {
  const rows = await query<CycleRow>('SELECT * FROM cycles WHERE inter_txid = $1', [txid]);
  return rows[0] ? toCycle(rows[0]) : null;
}

export async function findCurrentCycle(subscriptionId: string): Promise<Cycle | null> {
  const rows = await query<CycleRow>(
    `SELECT * FROM cycles WHERE subscription_id = $1 ORDER BY seq DESC LIMIT 1`,
    [subscriptionId],
  );
  return rows[0] ? toCycle(rows[0]) : null;
}

export async function listCyclesBySubscription(subscriptionId: string): Promise<Cycle[]> {
  const rows = await query<CycleRow>(
    'SELECT * FROM cycles WHERE subscription_id = $1 ORDER BY seq',
    [subscriptionId],
  );
  return rows.map(toCycle);
}

export async function listCyclesByStatus(statuses: CycleStatus[]): Promise<Cycle[]> {
  const rows = await query<CycleRow>(
    'SELECT * FROM cycles WHERE status = ANY($1::cycle_status[]) ORDER BY due_date',
    [statuses],
  );
  return rows.map(toCycle);
}

export async function updateCycleStatus(
  id: string,
  status: CycleStatus,
  patch: { interTxid?: string; endToEndId?: string; paidAt?: string } = {},
): Promise<Cycle> {
  const rows = await query<CycleRow>(
    `UPDATE cycles SET
       status = $2,
       inter_txid = COALESCE($3, inter_txid),
       end_to_end_id = COALESCE($4, end_to_end_id),
       paid_at = COALESCE($5, paid_at),
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, status, patch.interTxid ?? null, patch.endToEndId ?? null, patch.paidAt ?? null],
  );
  return toCycle(rows[0]);
}

export async function insertCycleAttempt(input: {
  cycleId: string;
  attemptNumber: number;
  scheduledFor: string;
}): Promise<CycleAttempt> {
  const rows = await query<AttemptRow>(
    `INSERT INTO cycle_attempts (cycle_id, attempt_number, scheduled_for, sent_at)
     VALUES ($1, $2, $3, now())
     RETURNING *`,
    [input.cycleId, input.attemptNumber, input.scheduledFor],
  );
  return toAttempt(rows[0]);
}

export async function countCycleAttempts(cycleId: string): Promise<number> {
  const rows = await query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM cycle_attempts WHERE cycle_id = $1',
    [cycleId],
  );
  return Number(rows[0].count);
}

export async function markAttemptOutcome(
  cycleId: string,
  attemptNumber: number,
  outcome: string,
  failureReason?: string,
): Promise<void> {
  await query(
    `UPDATE cycle_attempts SET outcome = $3, failure_reason = $4
     WHERE cycle_id = $1 AND attempt_number = $2`,
    [cycleId, attemptNumber, outcome, failureReason ?? null],
  );
}
```

- [ ] **Step 6: Implementar `src/repositories/events.ts`**

```ts
import { query } from '../shared/db';

export interface StoredEvent {
  id: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

export async function insertEvent(input: {
  subscriptionId?: string;
  cycleId?: string;
  type: string;
  payload: unknown;
}): Promise<{ id: string }> {
  const rows = await query<{ id: string }>(
    `INSERT INTO events (subscription_id, cycle_id, type, payload)
     VALUES ($1, $2, $3, $4)
     RETURNING id::text AS id`,
    [input.subscriptionId ?? null, input.cycleId ?? null, input.type, JSON.stringify(input.payload)],
  );
  return rows[0];
}

export async function listEventsBySubscription(subscriptionId: string): Promise<StoredEvent[]> {
  const rows = await query<{
    id: string;
    type: string;
    payload: unknown;
    created_at: string;
  }>(
    `SELECT id::text AS id, type, payload, created_at
     FROM events WHERE subscription_id = $1 ORDER BY id`,
    [subscriptionId],
  );
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    payload: row.payload,
    createdAt: row.created_at,
  }));
}
```

- [ ] **Step 7: Rodar os testes e confirmar que passam**

Run: `npx vitest run src/repositories`
Expected: PASS, 10 testes

- [ ] **Step 8: Commit**

```bash
git add src/repositories src/test/factories.ts
git commit -m "feat: adiciona repositorios de assinatura, ciclo, tentativa e evento"
```

---

### Task 8: Provider do Inter para Pix Automático

**Files:**
- Modify: `src/shared/api.ts:56`
- Create: `src/providers/inter/pixAutomatico.ts`
- Create: `src/providers/inter/pixAutomatico.test.ts`
- Create: `src/providers/inter/types.ts`

**Interfaces:**
- Consumes: `api` de `src/shared/api.ts`, `config`
- Produces:
  - `createRecurrence(input: CreateRecurrenceInput): Promise<RecurrenceResponse>` — cria a `rec` com retentativa habilitada
  - `requestAuthorization(recId: string, input: { payerRequest?: string }): Promise<AuthorizationResponse>` — `solicrec`
  - `getRecurrence(recId: string): Promise<RecurrenceResponse>`
  - `cancelRecurrence(recId: string): Promise<void>`
  - `createCharge(input: CreateChargeInput): Promise<ChargeResponse>` — `cobr`
  - `getChargeByTxid(txid: string): Promise<ChargeResponse>`
  - Tipos `RecurrenceResponse = { recId: string; status: string; solicrecId?: string; pixCopyPaste?: string; url?: string }` e `ChargeResponse = { txid: string; status: string; endToEndId?: string; paidAt?: string; failureReason?: string }`
  - Toda falha de rede/HTTP vira `AppError.upstream()`, com o erro original no log.

> **Pendência bloqueante:** os paths e nomes de campo abaixo seguem o padrão `/pix/v2/...` da API do Inter. Antes de implementar, confirmar na documentação oficial de Pix Automático os paths exatos, os nomes de campo em português e o flag que habilita retentativa. Se divergirem, ajustar apenas este arquivo — nada fora de `providers/inter` conhece o formato do Inter.

- [ ] **Step 1: Ampliar os escopos do OAuth**

Em `src/shared/api.ts`, na linha do `params.append('scope', ...)`, trocar por:

```ts
params.append(
  'scope',
  'cob.read cob.write cobv.read cobv.write pix.read rec.read rec.write cobr.read cobr.write webhook.read webhook.write',
);
```

- [ ] **Step 2: Escrever o teste que falha**

Criar `src/providers/inter/pixAutomatico.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../shared/api';
import { AppError } from '../../shared/errors';
import { createCharge, createRecurrence, getChargeByTxid } from './pixAutomatico';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createRecurrence', () => {
  it('sempre envia a recorrencia com retentativa habilitada', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      data: { idRec: 'rec-1', status: 'CRIADA' },
    } as never);

    await createRecurrence({
      amount: '29.90',
      intervalMonths: 1,
      firstDueDate: '2026-09-20',
      debtorTaxId: '12345678901',
      debtorName: 'Fulano',
      planCode: 'mensal_29_90',
    });

    const body = post.mock.calls[0][1] as Record<string, unknown>;
    expect(body.permiteRetentativa).toBe(true);
  });

  it('mapeia a resposta do Inter para o formato interno', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({
      data: { idRec: 'rec-2', status: 'CRIADA' },
    } as never);

    const result = await createRecurrence({
      amount: '29.90',
      intervalMonths: 1,
      firstDueDate: '2026-09-20',
      debtorTaxId: '12345678901',
      debtorName: 'Fulano',
      planCode: 'mensal_29_90',
    });

    expect(result.recId).toBe('rec-2');
    expect(result.status).toBe('CRIADA');
  });

  it('converte falha do Inter em AppError.upstream sem vazar o corpo', async () => {
    vi.spyOn(api, 'post').mockRejectedValue({
      isAxiosError: true,
      response: { status: 500, data: { detalhe: 'segredo interno' } },
      message: 'boom',
    });

    await expect(
      createRecurrence({
        amount: '29.90',
        intervalMonths: 1,
        firstDueDate: '2026-09-20',
        debtorTaxId: '12345678901',
        debtorName: 'Fulano',
        planCode: 'mensal_29_90',
      }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });
});

describe('createCharge', () => {
  it('reusa o txid recebido, para respeitar a regra de retentativa', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({
      data: { txid: 'txid-fixo', status: 'CRIADA' },
    } as never);

    await createCharge({
      recId: 'rec-1',
      txid: 'txid-fixo',
      dueDate: '2026-09-20',
      amount: '29.90',
    });

    expect(put.mock.calls[0][0]).toContain('txid-fixo');
  });
});

describe('getChargeByTxid', () => {
  it('mapeia cobranca liquidada', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { txid: 'txid-1', status: 'LIQUIDADA', endToEndId: 'E123', horario: '2026-09-20T10:00:00Z' },
    } as never);

    const result = await getChargeByTxid('txid-1');

    expect(result.status).toBe('LIQUIDADA');
    expect(result.endToEndId).toBe('E123');
    expect(result.paidAt).toBe('2026-09-20T10:00:00Z');
  });
});
```

- [ ] **Step 3: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/providers`
Expected: FAIL com "Failed to resolve import './pixAutomatico'"

- [ ] **Step 4: Implementar `src/providers/inter/types.ts`**

```ts
export interface CreateRecurrenceInput {
  amount: string;
  intervalMonths: number;
  firstDueDate: string;
  debtorTaxId: string;
  debtorName: string;
  planCode: string;
}

export interface RecurrenceResponse {
  recId: string;
  status: string;
  solicrecId?: string;
  pixCopyPaste?: string;
  url?: string;
}

export interface CreateChargeInput {
  recId: string;
  txid: string;
  dueDate: string;
  amount: string;
}

export interface ChargeResponse {
  txid: string;
  status: string;
  endToEndId?: string;
  paidAt?: string;
  failureReason?: string;
}
```

- [ ] **Step 5: Implementar `src/providers/inter/pixAutomatico.ts`**

```ts
import { AxiosError } from 'axios';
import { api } from '../../shared/api';
import { config } from '../../shared/config';
import { AppError } from '../../shared/errors';
import { logger } from '../../shared/logger';
import {
  ChargeResponse,
  CreateChargeInput,
  CreateRecurrenceInput,
  RecurrenceResponse,
} from './types';

function fail(operation: string, error: unknown): never {
  const axiosError = error as AxiosError;
  logger.error('falha na api do inter', {
    operation,
    status: axiosError.response?.status,
    body: axiosError.response?.data,
    message: axiosError.message,
  });
  throw AppError.upstream();
}

function toRecurrence(data: Record<string, unknown>): RecurrenceResponse {
  return {
    recId: String(data.idRec ?? data.id),
    status: String(data.status),
    solicrecId: data.idSolicRec ? String(data.idSolicRec) : undefined,
    pixCopyPaste: data.pixCopiaECola ? String(data.pixCopiaECola) : undefined,
    url: data.location ? String(data.location) : undefined,
  };
}

function toCharge(data: Record<string, unknown>): ChargeResponse {
  return {
    txid: String(data.txid),
    status: String(data.status),
    endToEndId: data.endToEndId ? String(data.endToEndId) : undefined,
    paidAt: data.horario ? String(data.horario) : undefined,
    failureReason: data.motivoRejeicao ? String(data.motivoRejeicao) : undefined,
  };
}

export async function createRecurrence(
  input: CreateRecurrenceInput,
): Promise<RecurrenceResponse> {
  const body = {
    chave: config.pixKey,
    permiteRetentativa: true,
    valor: { valorRec: input.amount },
    calendario: {
      dataInicial: input.firstDueDate,
      periodicidade: input.intervalMonths === 12 ? 'ANUAL' : 'MENSAL',
    },
    devedor: { cpf: input.debtorTaxId, nome: input.debtorName },
    politicaRetentativa: 'PERMITE_3R_7D',
    objeto: input.planCode,
  };

  try {
    const response = await api.post('/pix/v2/rec', body, {
      headers: { 'Content-Type': 'application/json' },
    });
    return toRecurrence(response.data);
  } catch (error) {
    fail('createRecurrence', error);
  }
}

export async function requestAuthorization(
  recId: string,
  input: { payerRequest?: string } = {},
): Promise<RecurrenceResponse> {
  try {
    const response = await api.post(
      '/pix/v2/solicrec',
      { idRec: recId, solicitacaoPagador: input.payerRequest },
      { headers: { 'Content-Type': 'application/json' } },
    );
    return toRecurrence(response.data);
  } catch (error) {
    fail('requestAuthorization', error);
  }
}

export async function getRecurrence(recId: string): Promise<RecurrenceResponse> {
  try {
    const response = await api.get(`/pix/v2/rec/${recId}`);
    return toRecurrence(response.data);
  } catch (error) {
    fail('getRecurrence', error);
  }
}

export async function cancelRecurrence(recId: string): Promise<void> {
  try {
    await api.patch(
      `/pix/v2/rec/${recId}`,
      { status: 'CANCELADA' },
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    fail('cancelRecurrence', error);
  }
}

export async function createCharge(input: CreateChargeInput): Promise<ChargeResponse> {
  const body = {
    idRec: input.recId,
    calendario: { dataDeVencimento: input.dueDate },
    valor: { original: input.amount },
  };

  try {
    const response = await api.put(`/pix/v2/cobr/${input.txid}`, body, {
      headers: { 'Content-Type': 'application/json' },
    });
    return toCharge(response.data);
  } catch (error) {
    fail('createCharge', error);
  }
}

export async function getChargeByTxid(txid: string): Promise<ChargeResponse> {
  try {
    const response = await api.get(`/pix/v2/cobr/${txid}`);
    return toCharge(response.data);
  } catch (error) {
    fail('getChargeByTxid', error);
  }
}
```

- [ ] **Step 6: Rodar o teste e confirmar que passa**

Run: `npx vitest run src/providers`
Expected: PASS, 5 testes

- [ ] **Step 7: Commit**

```bash
git add src/providers src/shared/api.ts
git commit -m "feat: adiciona provider do inter para pix automatico"
```

---

### Task 9: Serviço de assinatura e rota de criação

**Files:**
- Create: `src/domain/subscriptionService.ts`
- Create: `src/domain/subscriptionService.test.ts`
- Create: `src/http/routes/subscriptions.ts`
- Create: `src/http/routes/subscriptions.test.ts`
- Modify: `src/http/app.ts`

**Interfaces:**
- Consumes: repositórios da Task 7, provider da Task 8, `assertSubscriptionTransition`, `insertEvent`
- Produces:
  - `createSubscription(input: CreateSubscriptionInput): Promise<{ subscription: Subscription; authorization: { pixCopyPaste?: string; url?: string } }>`
  - `CreateSubscriptionInput = { externalUserId, planCode, amount, intervalMonths, firstDueDate, debtor: { taxId, name } }`
  - `getSubscriptionDetail(id: string): Promise<{ subscription: Subscription; cycles: Cycle[] }>`
  - Rota `POST /subscriptions` e `GET /subscriptions/:id` montadas por `subscriptionRoutes(): Router`

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/http/routes/subscriptions.test.ts`:

```ts
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { config } from '../../shared/config';
import { closePool } from '../../shared/db';
import * as inter from '../../providers/inter/pixAutomatico';

const app = createApp();
const auth = { Authorization: `Bearer ${config.apiToken}` };

const validBody = {
  externalUserId: 'usr_1',
  planCode: 'mensal_29_90',
  amount: '29.90',
  intervalMonths: 1,
  firstDueDate: '2026-12-20',
  debtor: { taxId: '12345678901', name: 'Fulano de Tal' },
};

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closePool();
});

describe('POST /subscriptions', () => {
  it('cria a assinatura em PENDING_AUTH e devolve o payload de autorizacao', async () => {
    vi.spyOn(inter, 'createRecurrence').mockResolvedValue({ recId: 'rec-9', status: 'CRIADA' });
    vi.spyOn(inter, 'requestAuthorization').mockResolvedValue({
      recId: 'rec-9',
      status: 'PENDENTE',
      solicrecId: 'sol-9',
      pixCopyPaste: '00020126aaa',
      url: 'https://inter/autorizacao/9',
    });

    const response = await request(app).post('/subscriptions').set(auth).send(validBody);

    expect(response.status).toBe(201);
    expect(response.body.status).toBe('PENDING_AUTH');
    expect(response.body.authorization.pixCopyPaste).toBe('00020126aaa');
    expect(response.body.id).toBeTruthy();
  });

  it('recusa body invalido com 400 e detalhes de validacao', async () => {
    const response = await request(app)
      .post('/subscriptions')
      .set(auth)
      .send({ ...validBody, amount: 'nao-e-numero' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('BAD_REQUEST');
  });

  it('recusa firstDueDate no passado', async () => {
    const response = await request(app)
      .post('/subscriptions')
      .set(auth)
      .send({ ...validBody, firstDueDate: '2020-01-01' });

    expect(response.status).toBe(400);
  });

  it('devolve 502 sem vazar detalhe quando o Inter falha', async () => {
    vi.spyOn(inter, 'createRecurrence').mockRejectedValue(
      Object.assign(new Error('x'), { status: 502, code: 'UPSTREAM_ERROR', name: 'AppError' }),
    );

    const response = await request(app).post('/subscriptions').set(auth).send(validBody);

    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).not.toContain('segredo');
  });

  it('exige autenticacao', async () => {
    const response = await request(app).post('/subscriptions').send(validBody);
    expect(response.status).toBe(401);
  });
});

describe('GET /subscriptions/:id', () => {
  it('devolve a assinatura com a lista de ciclos', async () => {
    vi.spyOn(inter, 'createRecurrence').mockResolvedValue({ recId: 'rec-10', status: 'CRIADA' });
    vi.spyOn(inter, 'requestAuthorization').mockResolvedValue({
      recId: 'rec-10',
      status: 'PENDENTE',
      pixCopyPaste: '00020126bbb',
    });

    const created = await request(app).post('/subscriptions').set(auth).send(validBody);
    const response = await request(app).get(`/subscriptions/${created.body.id}`).set(auth);

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(created.body.id);
    expect(Array.isArray(response.body.cycles)).toBe(true);
  });

  it('devolve 404 para assinatura inexistente', async () => {
    const response = await request(app)
      .get('/subscriptions/00000000-0000-0000-0000-000000000000')
      .set(auth);

    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/http/routes`
Expected: FAIL com 404 nas rotas de `/subscriptions`

- [ ] **Step 3: Implementar `src/domain/subscriptionService.ts`**

```ts
import { AppError } from '../shared/errors';
import * as inter from '../providers/inter/pixAutomatico';
import {
  findSubscriptionById,
  insertSubscription,
  updateSubscriptionStatus,
} from '../repositories/subscriptions';
import { listCyclesBySubscription } from '../repositories/cycles';
import { insertEvent } from '../repositories/events';
import { Cycle, Subscription } from './types';

export interface CreateSubscriptionInput {
  externalUserId: string;
  planCode: string;
  amount: string;
  intervalMonths: number;
  firstDueDate: string;
  debtor: { taxId: string; name: string };
}

export interface CreateSubscriptionResult {
  subscription: Subscription;
  authorization: { pixCopyPaste?: string; url?: string };
}

export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<CreateSubscriptionResult> {
  const subscription = await insertSubscription({
    externalUserId: input.externalUserId,
    planCode: input.planCode,
    amount: input.amount,
    intervalMonths: input.intervalMonths,
    debtorTaxId: input.debtor.taxId,
    debtorName: input.debtor.name,
    nextDueDate: input.firstDueDate,
  });

  const recurrence = await inter.createRecurrence({
    amount: input.amount,
    intervalMonths: input.intervalMonths,
    firstDueDate: input.firstDueDate,
    debtorTaxId: input.debtor.taxId,
    debtorName: input.debtor.name,
    planCode: input.planCode,
  });

  const authorization = await inter.requestAuthorization(recurrence.recId, {
    payerRequest: input.planCode,
  });

  const updated = await updateSubscriptionStatus(subscription.id, 'PENDING_AUTH', {
    interRecId: recurrence.recId,
    interSolicrecId: authorization.solicrecId,
  });

  await insertEvent({
    subscriptionId: updated.id,
    type: 'subscription.created',
    payload: { recId: recurrence.recId, planCode: input.planCode },
  });

  return {
    subscription: updated,
    authorization: {
      pixCopyPaste: authorization.pixCopyPaste,
      url: authorization.url,
    },
  };
}

export async function getSubscriptionDetail(
  id: string,
): Promise<{ subscription: Subscription; cycles: Cycle[] }> {
  const subscription = await findSubscriptionById(id);

  if (!subscription) {
    throw AppError.notFound('Assinatura');
  }

  const cycles = await listCyclesBySubscription(id);
  return { subscription, cycles };
}
```

- [ ] **Step 4: Implementar `src/http/routes/subscriptions.ts`**

```ts
import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../shared/errors';
import {
  createSubscription,
  getSubscriptionDetail,
} from '../../domain/subscriptionService';

const createSchema = z.object({
  externalUserId: z.string().min(1).max(128),
  planCode: z.string().min(1).max(64),
  amount: z.string().regex(/^\d+\.\d{2}$/),
  intervalMonths: z.number().int().min(1).max(12),
  firstDueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => value >= new Date().toISOString().slice(0, 10), {
      message: 'firstDueDate nao pode estar no passado',
    }),
  debtor: z.object({
    taxId: z.string().regex(/^\d{11}$|^\d{14}$/),
    name: z.string().min(1).max(200),
  }),
});

export function subscriptionRoutes(): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    const parsed = createSchema.safeParse(req.body);

    if (!parsed.success) {
      next(AppError.badRequest('Payload invalido.', parsed.error.issues));
      return;
    }

    try {
      const result = await createSubscription(parsed.data);
      res.status(201).json({
        id: result.subscription.id,
        status: result.subscription.status,
        externalUserId: result.subscription.externalUserId,
        planCode: result.subscription.planCode,
        amount: result.subscription.amount,
        nextDueDate: result.subscription.nextDueDate,
        authorization: result.authorization,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { subscription, cycles } = await getSubscriptionDetail(req.params.id);
      res.status(200).json({
        id: subscription.id,
        status: subscription.status,
        externalUserId: subscription.externalUserId,
        planCode: subscription.planCode,
        amount: subscription.amount,
        nextDueDate: subscription.nextDueDate,
        authorizedAt: subscription.authorizedAt,
        canceledAt: subscription.canceledAt,
        cycles: cycles.map((cycle) => ({
          seq: cycle.seq,
          dueDate: cycle.dueDate,
          amount: cycle.amount,
          status: cycle.status,
          paidAt: cycle.paidAt,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
```

- [ ] **Step 5: Montar a rota em `src/http/app.ts`**

Entre `app.use(requireAuth)` e `app.use(notFoundHandler)`, adicionar:

```ts
app.use('/subscriptions', subscriptionRoutes());
```

E o import correspondente no topo:

```ts
import { subscriptionRoutes } from './routes/subscriptions';
```

- [ ] **Step 6: Rodar os testes e confirmar que passam**

Run: `npx vitest run src/http`
Expected: PASS, 14 testes

- [ ] **Step 7: Commit**

```bash
git add src/domain/subscriptionService.ts src/http/routes/subscriptions.ts src/http/routes/subscriptions.test.ts src/http/app.ts
git commit -m "feat: adiciona criacao e consulta de assinatura"
```

---

### Task 10: Cancelamento com a regra da véspera

**Files:**
- Modify: `src/domain/subscriptionService.ts`
- Modify: `src/http/routes/subscriptions.ts`
- Create: `src/domain/cancelSubscription.test.ts`

**Interfaces:**
- Consumes: `canCancelCycle` da Task 6, `cancelRecurrence` da Task 8
- Produces: `cancelSubscription(id: string, today?: string): Promise<{ subscription: Subscription; pendingCycle: Cycle | null }>` — `pendingCycle` é o ciclo que seguirá seu curso porque já passou da véspera.

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/domain/cancelSubscription.test.ts`:

```ts
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { closePool } from '../shared/db';
import * as inter from '../providers/inter/pixAutomatico';
import { createSubscription as createFixture } from '../test/factories';
import { insertCycle, updateCycleStatus } from '../repositories/cycles';
import { updateSubscriptionStatus } from '../repositories/subscriptions';
import { cancelSubscription } from './subscriptionService';

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closePool();
});

describe('cancelSubscription', () => {
  it('cancela a assinatura e o ciclo agendado quando ainda ha vespera', async () => {
    vi.spyOn(inter, 'cancelRecurrence').mockResolvedValue(undefined);

    const subscription = await createFixture({ nextDueDate: '2026-09-20' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: 'rec-c1' });
    await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-20',
      amount: '29.90',
    });

    const result = await cancelSubscription(subscription.id, '2026-09-18');

    expect(result.subscription.status).toBe('CANCELED');
    expect(result.pendingCycle).toBeNull();
  });

  it('cancela a assinatura mas devolve o ciclo que seguira seu curso apos a vespera', async () => {
    vi.spyOn(inter, 'cancelRecurrence').mockResolvedValue(undefined);

    const subscription = await createFixture({ nextDueDate: '2026-09-20' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: 'rec-c2' });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-20',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: 'txid-c2' });

    const result = await cancelSubscription(subscription.id, '2026-09-20');

    expect(result.subscription.status).toBe('CANCELED');
    expect(result.pendingCycle?.id).toBe(cycle.id);
    expect(result.pendingCycle?.status).toBe('SENT');
  });

  it('recusa cancelar assinatura ja cancelada', async () => {
    vi.spyOn(inter, 'cancelRecurrence').mockResolvedValue(undefined);

    const subscription = await createFixture();
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: 'rec-c3' });
    await cancelSubscription(subscription.id, '2026-09-01');

    await expect(cancelSubscription(subscription.id, '2026-09-01')).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/domain/cancelSubscription.test.ts`
Expected: FAIL com "cancelSubscription is not a function"

- [ ] **Step 3: Adicionar `cancelSubscription` em `src/domain/subscriptionService.ts`**

```ts
export async function cancelSubscription(
  id: string,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<{ subscription: Subscription; pendingCycle: Cycle | null }> {
  const subscription = await findSubscriptionById(id);

  if (!subscription) {
    throw AppError.notFound('Assinatura');
  }

  assertSubscriptionTransition(subscription.status, 'CANCELED');

  const current = await findCurrentCycle(id);
  let pendingCycle: Cycle | null = null;

  if (current && ['SCHEDULED', 'SENT', 'FAILED', 'RETRYING'].includes(current.status)) {
    if (canCancelCycle(current.dueDate, today)) {
      await updateCycleStatus(current.id, 'CANCELED');
    } else {
      pendingCycle = current;
    }
  }

  if (subscription.interRecId) {
    await inter.cancelRecurrence(subscription.interRecId);
  }

  const updated = await updateSubscriptionStatus(id, 'CANCELED', {
    canceledAt: new Date().toISOString(),
  });

  await insertEvent({
    subscriptionId: id,
    type: 'subscription.canceled',
    payload: { pendingCycleId: pendingCycle?.id ?? null },
  });

  return { subscription: updated, pendingCycle };
}
```

Adicionar aos imports do arquivo:

```ts
import { assertSubscriptionTransition } from './stateMachine';
import { canCancelCycle } from './schedule';
import { findCurrentCycle, updateCycleStatus } from '../repositories/cycles';
```

- [ ] **Step 4: Adicionar a rota em `src/http/routes/subscriptions.ts`**

```ts
router.post('/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await cancelSubscription(req.params.id);
    res.status(200).json({
      id: result.subscription.id,
      status: result.subscription.status,
      canceledAt: result.subscription.canceledAt,
      pendingCycle: result.pendingCycle
        ? {
            seq: result.pendingCycle.seq,
            dueDate: result.pendingCycle.dueDate,
            status: result.pendingCycle.status,
            note: 'Cobranca ja enviada; nao pode ser cancelada e seguira seu curso.',
          }
        : null,
    });
  } catch (error) {
    next(error);
  }
});
```

E incluir `cancelSubscription` no import de `subscriptionService`.

- [ ] **Step 5: Rodar os testes e confirmar que passam**

Run: `npx vitest run src/domain src/http`
Expected: PASS, todos os testes anteriores mais 3

- [ ] **Step 6: Commit**

```bash
git add src/domain/subscriptionService.ts src/domain/cancelSubscription.test.ts src/http/routes/subscriptions.ts
git commit -m "feat: adiciona cancelamento de assinatura respeitando a regra da vespera"
```

---

### Task 11: Webhook de entrada do Inter

**Files:**
- Create: `src/http/routes/interWebhook.ts`
- Create: `src/http/routes/interWebhook.test.ts`
- Create: `src/domain/webhookProcessor.ts`
- Create: `src/repositories/webhookReceipts.ts`
- Modify: `src/http/app.ts`

**Interfaces:**
- Consumes: repositórios, `getChargeByTxid`, `getRecurrence`, máquina de estados
- Produces:
  - `insertReceipt(dedupeKey: string, payload: unknown): Promise<{ id: string; isNew: boolean }>`
  - `markReceiptProcessed(id: string): Promise<void>`
  - `processInterEvent(dedupeKey: string, payload: InterWebhookPayload): Promise<void>` — idempotente
  - `InterWebhookPayload = { txid?: string; idRec?: string }`
  - Rota `POST /webhooks/inter`, montada **antes** de `requireAuth`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/http/routes/interWebhook.test.ts`:

```ts
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { closePool } from '../../shared/db';
import * as inter from '../../providers/inter/pixAutomatico';
import { createSubscription as createFixture } from '../../test/factories';
import { insertCycle, findCycleById, updateCycleStatus } from '../../repositories/cycles';
import { updateSubscriptionStatus, findSubscriptionById } from '../../repositories/subscriptions';

const app = createApp();

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closePool();
});

describe('POST /webhooks/inter', () => {
  it('nao exige o bearer token', async () => {
    const response = await request(app).post('/webhooks/inter').send({ txid: 'inexistente' });
    expect(response.status).toBe(200);
  });

  it('nunca confia no corpo: consulta o Inter antes de marcar como pago', async () => {
    const subscription = await createFixture();
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: 'rec-w1' });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-20',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: 'txid-w1' });

    const getCharge = vi.spyOn(inter, 'getChargeByTxid').mockResolvedValue({
      txid: 'txid-w1',
      status: 'LIQUIDADA',
      endToEndId: 'E1',
      paidAt: '2026-09-20T10:00:00Z',
    });

    await request(app)
      .post('/webhooks/inter')
      .send({ txid: 'txid-w1', status: 'MENTIRA_DO_ATACANTE' });

    expect(getCharge).toHaveBeenCalledWith('txid-w1');
    const updated = await findCycleById(cycle.id);
    expect(updated?.status).toBe('PAID');
    expect(updated?.endToEndId).toBe('E1');
  });

  it('ignora corpo que diz pago quando o Inter diz que nao foi', async () => {
    const subscription = await createFixture();
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: 'rec-w2' });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-20',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: 'txid-w2' });

    vi.spyOn(inter, 'getChargeByTxid').mockResolvedValue({
      txid: 'txid-w2',
      status: 'NAO_LIQUIDADA',
      failureReason: 'saldo insuficiente',
    });

    await request(app).post('/webhooks/inter').send({ txid: 'txid-w2', status: 'LIQUIDADA' });

    const updated = await findCycleById(cycle.id);
    expect(updated?.status).toBe('FAILED');
  });

  it('e idempotente: o mesmo evento duas vezes nao duplica efeito', async () => {
    const subscription = await createFixture();
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: 'rec-w3' });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-09-20',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: 'txid-w3' });

    const getCharge = vi.spyOn(inter, 'getChargeByTxid').mockResolvedValue({
      txid: 'txid-w3',
      status: 'LIQUIDADA',
      endToEndId: 'E3',
      paidAt: '2026-09-20T10:00:00Z',
    });

    const body = { txid: 'txid-w3', eventId: 'evt-3' };
    await request(app).post('/webhooks/inter').send(body);
    await request(app).post('/webhooks/inter').send(body);

    expect(getCharge).toHaveBeenCalledTimes(1);
  });

  it('promove a assinatura para ACTIVE quando a recorrencia e aprovada', async () => {
    const subscription = await createFixture();
    await updateSubscriptionStatus(subscription.id, 'PENDING_AUTH', { interRecId: 'rec-w4' });

    vi.spyOn(inter, 'getRecurrence').mockResolvedValue({ recId: 'rec-w4', status: 'APROVADA' });

    await request(app).post('/webhooks/inter').send({ idRec: 'rec-w4', eventId: 'evt-4' });

    const updated = await findSubscriptionById(subscription.id);
    expect(updated?.status).toBe('ACTIVE');
    expect(updated?.authorizedAt).toBeTruthy();
  });

  it('responde 200 mesmo quando o processamento falha, para o Inter nao reenviar em loop', async () => {
    vi.spyOn(inter, 'getChargeByTxid').mockRejectedValue(new Error('inter fora do ar'));

    const response = await request(app)
      .post('/webhooks/inter')
      .send({ txid: 'txid-inexistente', eventId: 'evt-5' });

    expect(response.status).toBe(200);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/http/routes/interWebhook.test.ts`
Expected: FAIL com 404

- [ ] **Step 3: Implementar `src/repositories/webhookReceipts.ts`**

```ts
import { query } from '../shared/db';

export async function insertReceipt(
  dedupeKey: string,
  payload: unknown,
): Promise<{ id: string; isNew: boolean }> {
  const rows = await query<{ id: string }>(
    `INSERT INTO inter_webhook_receipts (dedupe_key, raw_payload)
     VALUES ($1, $2)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id::text AS id`,
    [dedupeKey, JSON.stringify(payload)],
  );

  if (rows[0]) {
    return { id: rows[0].id, isNew: true };
  }

  const existing = await query<{ id: string }>(
    'SELECT id::text AS id FROM inter_webhook_receipts WHERE dedupe_key = $1',
    [dedupeKey],
  );
  return { id: existing[0].id, isNew: false };
}

export async function markReceiptProcessed(id: string): Promise<void> {
  await query('UPDATE inter_webhook_receipts SET processed_at = now() WHERE id = $1', [id]);
}
```

- [ ] **Step 4: Implementar `src/domain/webhookProcessor.ts`**

```ts
import * as inter from '../providers/inter/pixAutomatico';
import { logger } from '../shared/logger';
import { findCycleByTxid, markAttemptOutcome, countCycleAttempts, updateCycleStatus } from '../repositories/cycles';
import {
  findSubscriptionById,
  findSubscriptionByRecId,
  updateSubscriptionStatus,
} from '../repositories/subscriptions';
import { insertEvent } from '../repositories/events';
import { insertReceipt, markReceiptProcessed } from '../repositories/webhookReceipts';
import { assertCycleTransition, assertSubscriptionTransition } from './stateMachine';
import { enqueueDelivery } from './webhookDispatcher';

export interface InterWebhookPayload {
  txid?: string;
  idRec?: string;
  eventId?: string;
}

const PAID_STATUSES = new Set(['LIQUIDADA', 'CONCLUIDA', 'PAGA']);
const APPROVED_STATUSES = new Set(['APROVADA', 'ATIVA']);
const DENIED_STATUSES = new Set(['NEGADA', 'REJEITADA', 'EXPIRADA', 'CANCELADA']);

function dedupeKeyFor(payload: InterWebhookPayload): string {
  if (payload.eventId) {
    return `evt:${payload.eventId}`;
  }
  return `raw:${JSON.stringify(payload)}`;
}

async function processCharge(txid: string): Promise<void> {
  const cycle = await findCycleByTxid(txid);

  if (!cycle) {
    logger.warn('webhook para txid desconhecido', { txid });
    return;
  }

  const charge = await inter.getChargeByTxid(txid);

  if (PAID_STATUSES.has(charge.status)) {
    assertCycleTransition(cycle.status, 'PAID');
    await updateCycleStatus(cycle.id, 'PAID', {
      endToEndId: charge.endToEndId,
      paidAt: charge.paidAt ?? new Date().toISOString(),
    });

    const subscription = await findSubscriptionById(cycle.subscriptionId);
    if (subscription && subscription.status === 'PAST_DUE') {
      await updateSubscriptionStatus(subscription.id, 'ACTIVE');
    }

    const event = await insertEvent({
      subscriptionId: cycle.subscriptionId,
      cycleId: cycle.id,
      type: 'cycle.paid',
      payload: { txid, endToEndId: charge.endToEndId, amount: cycle.amount, seq: cycle.seq },
    });
    await enqueueDelivery(event.id, 'cycle.paid', {
      subscriptionId: cycle.subscriptionId,
      cycleSeq: cycle.seq,
      amount: cycle.amount,
      paidAt: charge.paidAt,
    });
    return;
  }

  if (cycle.status === 'SENT' || cycle.status === 'RETRYING') {
    assertCycleTransition(cycle.status, 'FAILED');
    await updateCycleStatus(cycle.id, 'FAILED');

    const attempts = await countCycleAttempts(cycle.id);
    if (attempts > 0) {
      await markAttemptOutcome(cycle.id, attempts, 'FAILED', charge.failureReason);
    }

    const event = await insertEvent({
      subscriptionId: cycle.subscriptionId,
      cycleId: cycle.id,
      type: 'cycle.failed',
      payload: { txid, reason: charge.failureReason, seq: cycle.seq },
    });
    await enqueueDelivery(event.id, 'cycle.failed', {
      subscriptionId: cycle.subscriptionId,
      cycleSeq: cycle.seq,
      reason: charge.failureReason,
    });
  }
}

async function processRecurrence(recId: string): Promise<void> {
  const subscription = await findSubscriptionByRecId(recId);

  if (!subscription) {
    logger.warn('webhook para rec desconhecida', { recId });
    return;
  }

  const recurrence = await inter.getRecurrence(recId);

  if (APPROVED_STATUSES.has(recurrence.status)) {
    assertSubscriptionTransition(subscription.status, 'ACTIVE');
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', {
      authorizedAt: new Date().toISOString(),
    });

    const event = await insertEvent({
      subscriptionId: subscription.id,
      type: 'subscription.authorized',
      payload: { recId },
    });
    await enqueueDelivery(event.id, 'subscription.authorized', {
      subscriptionId: subscription.id,
      externalUserId: subscription.externalUserId,
    });
    return;
  }

  if (DENIED_STATUSES.has(recurrence.status) && subscription.status === 'PENDING_AUTH') {
    assertSubscriptionTransition(subscription.status, 'AUTH_DENIED');
    await updateSubscriptionStatus(subscription.id, 'AUTH_DENIED');

    const event = await insertEvent({
      subscriptionId: subscription.id,
      type: 'subscription.auth_denied',
      payload: { recId, status: recurrence.status },
    });
    await enqueueDelivery(event.id, 'subscription.auth_denied', {
      subscriptionId: subscription.id,
      externalUserId: subscription.externalUserId,
    });
  }
}

export async function processInterEvent(payload: InterWebhookPayload): Promise<void> {
  const receipt = await insertReceipt(dedupeKeyFor(payload), payload);

  if (!receipt.isNew) {
    return;
  }

  if (payload.txid) {
    await processCharge(payload.txid);
  } else if (payload.idRec) {
    await processRecurrence(payload.idRec);
  }

  await markReceiptProcessed(receipt.id);
}
```

- [ ] **Step 5: Implementar `src/http/routes/interWebhook.ts`**

```ts
import { Request, Response, Router } from 'express';
import { logger } from '../../shared/logger';
import { processInterEvent } from '../../domain/webhookProcessor';

export function interWebhookRoutes(): Router {
  const router = Router();

  router.post('/inter', async (req: Request, res: Response) => {
    res.status(200).json({ received: true });

    try {
      await processInterEvent(req.body ?? {});
    } catch (error) {
      logger.error('falha ao processar webhook do inter', {
        message: (error as Error).message,
      });
    }
  });

  return router;
}
```

- [ ] **Step 6: Montar a rota antes do `requireAuth` em `src/http/app.ts`**

```ts
app.use('/webhooks', interWebhookRoutes());
app.use(requireAuth);
```

- [ ] **Step 7: Rodar o teste e confirmar que passa**

Run: `npx vitest run src/http/routes/interWebhook.test.ts`
Expected: PASS, 6 testes

- [ ] **Step 8: Commit**

```bash
git add src/http/routes/interWebhook.ts src/http/routes/interWebhook.test.ts src/domain/webhookProcessor.ts src/repositories/webhookReceipts.ts src/http/app.ts
git commit -m "feat: adiciona webhook de entrada do inter com idempotencia e reconsulta"
```

---

### Task 12: Webhook de saída assinado para o SaaS

**Files:**
- Create: `src/domain/webhookDispatcher.ts`
- Create: `src/domain/webhookDispatcher.test.ts`
- Create: `src/repositories/webhookDeliveries.ts`

**Interfaces:**
- Consumes: `config`, `insertEvent`
- Produces:
  - `signPayload(body: string, timestamp: string, secret: string): string` — HMAC-SHA256 em hex sobre `${timestamp}.${body}`
  - `enqueueDelivery(eventId: string, type: string, data: Record<string, unknown>): Promise<void>`
  - `deliverPending(now?: Date): Promise<{ delivered: number; failed: number }>`
  - `RETRY_SCHEDULE_MINUTES = [1, 5, 15, 60, 360, 1440]`

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/domain/webhookDispatcher.test.ts`:

```ts
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createHmac } from 'crypto';
import { closePool, query } from '../shared/db';
import { config } from '../shared/config';
import { insertEvent } from '../repositories/events';
import { createSubscription as createFixture } from '../test/factories';
import { deliverPending, enqueueDelivery, signPayload } from './webhookDispatcher';

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closePool();
});

describe('signPayload', () => {
  it('produz HMAC-SHA256 de timestamp.body', () => {
    const expected = createHmac('sha256', 'segredo').update('123.corpo').digest('hex');
    expect(signPayload('corpo', '123', 'segredo')).toBe(expected);
  });
});

describe('deliverPending', () => {
  it('envia com os headers de assinatura e marca como entregue', async () => {
    const subscription = await createFixture();
    const event = await insertEvent({
      subscriptionId: subscription.id,
      type: 'cycle.paid',
      payload: {},
    });
    await enqueueDelivery(event.id, 'cycle.paid', { subscriptionId: subscription.id });

    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200 } as never);

    const result = await deliverPending();

    expect(result.delivered).toBeGreaterThanOrEqual(1);
    const headers = post.mock.calls[0][2]?.headers as Record<string, string>;
    expect(headers['X-Signature']).toBeTruthy();
    expect(headers['X-Timestamp']).toBeTruthy();

    const body = JSON.stringify(post.mock.calls[0][1]);
    const expectedSignature = createHmac('sha256', config.saasWebhookSecret)
      .update(`${headers['X-Timestamp']}.${body}`)
      .digest('hex');
    expect(headers['X-Signature']).toBe(expectedSignature);
  });

  it('agenda retry crescente quando a entrega falha', async () => {
    const subscription = await createFixture();
    const event = await insertEvent({
      subscriptionId: subscription.id,
      type: 'cycle.failed',
      payload: {},
    });
    await enqueueDelivery(event.id, 'cycle.failed', { subscriptionId: subscription.id });

    vi.spyOn(axios, 'post').mockRejectedValue(new Error('saas fora do ar'));

    await deliverPending();

    const rows = await query<{ status: string; attempts: number; next_retry_at: string }>(
      'SELECT status, attempts, next_retry_at FROM webhook_deliveries WHERE event_id = $1',
      [event.id],
    );

    expect(rows[0].status).toBe('PENDING');
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].next_retry_at).toBeTruthy();
  });

  it('marca FAILED depois de esgotar a escala de retry', async () => {
    const subscription = await createFixture();
    const event = await insertEvent({
      subscriptionId: subscription.id,
      type: 'cycle.failed',
      payload: {},
    });
    await enqueueDelivery(event.id, 'cycle.failed', { subscriptionId: subscription.id });
    await query('UPDATE webhook_deliveries SET attempts = 6 WHERE event_id = $1', [event.id]);

    vi.spyOn(axios, 'post').mockRejectedValue(new Error('saas fora do ar'));

    await deliverPending();

    const rows = await query<{ status: string }>(
      'SELECT status FROM webhook_deliveries WHERE event_id = $1',
      [event.id],
    );
    expect(rows[0].status).toBe('FAILED');
  });

  it('nao entrega antes do next_retry_at', async () => {
    const subscription = await createFixture();
    const event = await insertEvent({
      subscriptionId: subscription.id,
      type: 'cycle.paid',
      payload: {},
    });
    await enqueueDelivery(event.id, 'cycle.paid', { subscriptionId: subscription.id });
    await query(
      "UPDATE webhook_deliveries SET next_retry_at = now() + interval '1 hour' WHERE event_id = $1",
      [event.id],
    );

    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200 } as never);

    await deliverPending();

    const called = post.mock.calls.some(
      (call) => (call[1] as Record<string, unknown>).type === 'cycle.paid',
    );
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/domain/webhookDispatcher.test.ts`
Expected: FAIL com "Failed to resolve import './webhookDispatcher'"

- [ ] **Step 3: Implementar `src/repositories/webhookDeliveries.ts`**

```ts
import { query } from '../shared/db';

export interface PendingDelivery {
  id: string;
  eventId: string;
  targetUrl: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export async function insertDelivery(input: {
  eventId: string;
  targetUrl: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await query(
    `INSERT INTO webhook_deliveries (event_id, target_url, payload, next_retry_at)
     VALUES ($1, $2, $3, now())`,
    [input.eventId, input.targetUrl, JSON.stringify(input.payload)],
  );
}

export async function listDueDeliveries(limit: number): Promise<PendingDelivery[]> {
  const rows = await query<{
    id: string;
    event_id: string;
    target_url: string;
    payload: Record<string, unknown>;
    attempts: number;
  }>(
    `SELECT id::text AS id, event_id::text AS event_id, target_url, payload, attempts
     FROM webhook_deliveries
     WHERE status = 'PENDING' AND (next_retry_at IS NULL OR next_retry_at <= now())
     ORDER BY id
     LIMIT $1`,
    [limit],
  );

  return rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    targetUrl: row.target_url,
    payload: row.payload,
    attempts: row.attempts,
  }));
}

export async function markDelivered(id: string): Promise<void> {
  await query(
    `UPDATE webhook_deliveries
     SET status = 'DELIVERED', delivered_at = now(), attempts = attempts + 1, last_error = NULL
     WHERE id = $1`,
    [id],
  );
}

export async function markRetry(
  id: string,
  error: string,
  delayMinutes: number,
): Promise<void> {
  await query(
    `UPDATE webhook_deliveries
     SET attempts = attempts + 1,
         last_error = $2,
         next_retry_at = now() + ($3 || ' minutes')::interval
     WHERE id = $1`,
    [id, error, String(delayMinutes)],
  );
}

export async function markFailed(id: string, error: string): Promise<void> {
  await query(
    `UPDATE webhook_deliveries
     SET status = 'FAILED', attempts = attempts + 1, last_error = $2, next_retry_at = NULL
     WHERE id = $1`,
    [id],
  );
}
```

- [ ] **Step 4: Implementar `src/domain/webhookDispatcher.ts`**

```ts
import axios from 'axios';
import { createHmac } from 'crypto';
import { config } from '../shared/config';
import { logger } from '../shared/logger';
import {
  insertDelivery,
  listDueDeliveries,
  markDelivered,
  markFailed,
  markRetry,
} from '../repositories/webhookDeliveries';

export const RETRY_SCHEDULE_MINUTES = [1, 5, 15, 60, 360, 1440];

export function signPayload(body: string, timestamp: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export async function enqueueDelivery(
  eventId: string,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  await insertDelivery({
    eventId,
    targetUrl: config.saasWebhookUrl,
    payload: { type, data, eventId },
  });
}

export async function deliverPending(): Promise<{ delivered: number; failed: number }> {
  const pending = await listDueDeliveries(50);
  let delivered = 0;
  let failed = 0;

  for (const delivery of pending) {
    const timestamp = Date.now().toString();
    const body = JSON.stringify(delivery.payload);
    const signature = signPayload(body, timestamp, config.saasWebhookSecret);

    try {
      await axios.post(delivery.targetUrl, delivery.payload, {
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': signature,
          'X-Timestamp': timestamp,
        },
      });
      await markDelivered(delivery.id);
      delivered += 1;
    } catch (error) {
      const message = (error as Error).message;
      const nextDelay = RETRY_SCHEDULE_MINUTES[delivery.attempts];

      if (nextDelay === undefined) {
        await markFailed(delivery.id, message);
        failed += 1;
        logger.error('entrega de webhook esgotou as tentativas', {
          deliveryId: delivery.id,
          message,
        });
      } else {
        await markRetry(delivery.id, message, nextDelay);
        logger.warn('entrega de webhook falhou, reagendada', {
          deliveryId: delivery.id,
          nextDelay,
        });
      }
    }
  }

  return { delivered, failed };
}
```

- [ ] **Step 5: Rodar o teste e confirmar que passa**

Run: `npx vitest run src/domain/webhookDispatcher.test.ts`
Expected: PASS, 5 testes

- [ ] **Step 6: Commit**

```bash
git add src/domain/webhookDispatcher.ts src/domain/webhookDispatcher.test.ts src/repositories/webhookDeliveries.ts
git commit -m "feat: adiciona entrega de webhook assinado com retry exponencial"
```

---

### Task 13: Jobs de ciclo, cobrança, retentativa, suspensão e reconciliação

**Files:**
- Create: `src/jobs/lock.ts`
- Create: `src/jobs/billingJobs.ts`
- Create: `src/jobs/billingJobs.test.ts`
- Create: `src/jobs/scheduler.ts`

**Interfaces:**
- Consumes: repositórios, provider, `schedule`, `stateMachine`, `enqueueDelivery`
- Produces:
  - `withAdvisoryLock<T>(key: number, fn: () => Promise<T>): Promise<T | null>` — devolve `null` se outra réplica já tem o lock
  - `generateCycles(today: string): Promise<number>`
  - `sendCharges(today: string): Promise<number>`
  - `retryFailed(today: string): Promise<number>`
  - `expireOverdue(today: string): Promise<number>`
  - `reconcile(): Promise<number>`
  - `startScheduler(): void`

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/jobs/billingJobs.test.ts`:

```ts
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { closePool } from '../shared/db';
import * as inter from '../providers/inter/pixAutomatico';
import { createSubscription as createFixture } from '../test/factories';
import {
  countCycleAttempts,
  findCycleById,
  insertCycle,
  listCyclesBySubscription,
  updateCycleStatus,
} from '../repositories/cycles';
import { findSubscriptionById, updateSubscriptionStatus } from '../repositories/subscriptions';
import { expireOverdue, generateCycles, retryFailed, sendCharges } from './billingJobs';
import { withAdvisoryLock } from './lock';

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closePool();
});

describe('generateCycles', () => {
  it('cria o primeiro ciclo de uma assinatura ativa sem ciclos', async () => {
    const subscription = await createFixture({ nextDueDate: '2026-11-20' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: 'rec-j1' });

    await generateCycles('2026-11-20');

    const cycles = await listCyclesBySubscription(subscription.id);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].seq).toBe(1);
    expect(cycles[0].dueDate).toBe('2026-11-20');
  });

  it('nao duplica ciclo quando roda duas vezes no mesmo dia', async () => {
    const subscription = await createFixture({ nextDueDate: '2026-11-21' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: 'rec-j2' });

    await generateCycles('2026-11-21');
    await generateCycles('2026-11-21');

    const cycles = await listCyclesBySubscription(subscription.id);
    expect(cycles).toHaveLength(1);
  });
});

describe('sendCharges', () => {
  it('envia cobr apenas dentro da janela e registra a primeira tentativa', async () => {
    const createCharge = vi
      .spyOn(inter, 'createCharge')
      .mockResolvedValue({ txid: 'txid-j3', status: 'CRIADA' });

    const subscription = await createFixture({ nextDueDate: '2026-11-25' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: 'rec-j3' });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-11-25',
      amount: '29.90',
    });

    await sendCharges('2026-11-22');

    expect(createCharge).toHaveBeenCalled();
    const updated = await findCycleById(cycle.id);
    expect(updated?.status).toBe('SENT');
    expect(updated?.interTxid).toBeTruthy();
    expect(await countCycleAttempts(cycle.id)).toBe(1);
  });

  it('nao envia fora da janela de 10 a 2 dias', async () => {
    const createCharge = vi.spyOn(inter, 'createCharge');

    const subscription = await createFixture({ nextDueDate: '2026-11-26' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: 'rec-j4' });
    await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-11-26',
      amount: '29.90',
    });

    await sendCharges('2026-11-25');

    expect(createCharge).not.toHaveBeenCalled();
  });
});

describe('retryFailed', () => {
  it('reenvia com o mesmo txid e incrementa a tentativa', async () => {
    const createCharge = vi
      .spyOn(inter, 'createCharge')
      .mockResolvedValue({ txid: 'txid-j5', status: 'CRIADA' });

    const subscription = await createFixture({ nextDueDate: '2026-11-27' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: 'rec-j5' });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-11-27',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: 'txid-j5' });
    await updateCycleStatus(cycle.id, 'FAILED');

    await retryFailed('2026-11-28');

    expect(createCharge.mock.calls[0][0].txid).toBe('txid-j5');
    const updated = await findCycleById(cycle.id);
    expect(updated?.status).toBe('RETRYING');
    expect(await countCycleAttempts(cycle.id)).toBe(1);
  });

  it('nao reenvia depois dos 7 dias de janela', async () => {
    const createCharge = vi.spyOn(inter, 'createCharge');

    const subscription = await createFixture({ nextDueDate: '2026-11-01' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: 'rec-j6' });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-11-01',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: 'txid-j6' });
    await updateCycleStatus(cycle.id, 'FAILED');

    await retryFailed('2026-11-20');

    expect(createCharge).not.toHaveBeenCalled();
  });
});

describe('expireOverdue', () => {
  it('abandona o ciclo e suspende a assinatura apos a janela', async () => {
    const subscription = await createFixture({ nextDueDate: '2026-11-02' });
    await updateSubscriptionStatus(subscription.id, 'ACTIVE', { interRecId: 'rec-j7' });
    const cycle = await insertCycle({
      subscriptionId: subscription.id,
      seq: 1,
      dueDate: '2026-11-02',
      amount: '29.90',
    });
    await updateCycleStatus(cycle.id, 'SENT', { interTxid: 'txid-j7' });
    await updateCycleStatus(cycle.id, 'FAILED');
    await updateSubscriptionStatus(subscription.id, 'PAST_DUE');

    await expireOverdue('2026-11-11');

    expect((await findCycleById(cycle.id))?.status).toBe('ABANDONED');
    expect((await findSubscriptionById(subscription.id))?.status).toBe('SUSPENDED');
  });
});

describe('withAdvisoryLock', () => {
  it('impede execucao concorrente da mesma chave', async () => {
    let running = 0;
    let maxConcurrent = 0;

    const task = async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((resolve) => setTimeout(resolve, 50));
      running -= 1;
      return true;
    };

    await Promise.all([withAdvisoryLock(9001, task), withAdvisoryLock(9001, task)]);

    expect(maxConcurrent).toBe(1);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `npx vitest run src/jobs`
Expected: FAIL com "Failed to resolve import './billingJobs'"

- [ ] **Step 3: Implementar `src/jobs/lock.ts`**

```ts
import { pool } from '../shared/db';

export async function withAdvisoryLock<T>(
  key: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const client = await pool.connect();

  try {
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [key],
    );

    if (!result.rows[0].locked) {
      return null;
    }

    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]);
    }
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Implementar `src/jobs/billingJobs.ts`**

```ts
import { randomUUID } from 'crypto';
import { config } from '../shared/config';
import { logger } from '../shared/logger';
import * as inter from '../providers/inter/pixAutomatico';
import {
  listActiveSubscriptionsDueFor,
  findSubscriptionById,
  updateSubscriptionStatus,
} from '../repositories/subscriptions';
import {
  countCycleAttempts,
  findCurrentCycle,
  insertCycle,
  insertCycleAttempt,
  listCyclesByStatus,
  updateCycleStatus,
} from '../repositories/cycles';
import { insertEvent } from '../repositories/events';
import { addMonths, nextRetryDate, shouldSendCharge } from '../domain/schedule';
import { assertCycleTransition, assertSubscriptionTransition } from '../domain/stateMachine';
import { enqueueDelivery } from '../domain/webhookDispatcher';

function newTxid(): string {
  return randomUUID().replace(/-/g, '');
}

export async function generateCycles(today: string): Promise<number> {
  const horizon = addMonths(today, 1);
  const subscriptions = await listActiveSubscriptionsDueFor(horizon);
  let created = 0;

  for (const subscription of subscriptions) {
    const current = await findCurrentCycle(subscription.id);

    if (current && ['SCHEDULED', 'SENT', 'FAILED', 'RETRYING'].includes(current.status)) {
      continue;
    }

    const seq = current ? current.seq + 1 : 1;
    const dueDate = current
      ? addMonths(current.dueDate, subscription.intervalMonths)
      : subscription.nextDueDate;

    if (!dueDate) {
      continue;
    }

    await insertCycle({
      subscriptionId: subscription.id,
      seq,
      dueDate,
      amount: subscription.amount,
    });
    await updateSubscriptionStatus(subscription.id, subscription.status, { nextDueDate: dueDate });
    created += 1;
  }

  return created;
}

export async function sendCharges(today: string): Promise<number> {
  const cycles = await listCyclesByStatus(['SCHEDULED']);
  let sent = 0;

  for (const cycle of cycles) {
    if (!shouldSendCharge(cycle.dueDate, today, config.chargeLeadDays)) {
      continue;
    }

    const subscription = await findSubscriptionById(cycle.subscriptionId);

    if (!subscription?.interRecId) {
      continue;
    }

    const txid = cycle.interTxid ?? newTxid();

    try {
      await inter.createCharge({
        recId: subscription.interRecId,
        txid,
        dueDate: cycle.dueDate,
        amount: cycle.amount,
      });

      assertCycleTransition(cycle.status, 'SENT');
      await updateCycleStatus(cycle.id, 'SENT', { interTxid: txid });
      await insertCycleAttempt({
        cycleId: cycle.id,
        attemptNumber: 1,
        scheduledFor: cycle.dueDate,
      });
      await insertEvent({
        subscriptionId: cycle.subscriptionId,
        cycleId: cycle.id,
        type: 'cycle.sent',
        payload: { txid, dueDate: cycle.dueDate },
      });
      sent += 1;
    } catch (error) {
      logger.error('falha ao enviar cobranca', {
        cycleId: cycle.id,
        message: (error as Error).message,
      });
    }
  }

  return sent;
}

export async function retryFailed(today: string): Promise<number> {
  const cycles = await listCyclesByStatus(['FAILED']);
  let retried = 0;

  for (const cycle of cycles) {
    const scheduledFor = nextRetryDate(cycle.dueDate, today, config.dunningWindowDays);

    if (!scheduledFor || !cycle.interTxid) {
      continue;
    }

    const subscription = await findSubscriptionById(cycle.subscriptionId);

    if (!subscription?.interRecId) {
      continue;
    }

    try {
      await inter.createCharge({
        recId: subscription.interRecId,
        txid: cycle.interTxid,
        dueDate: scheduledFor,
        amount: cycle.amount,
      });

      assertCycleTransition(cycle.status, 'RETRYING');
      await updateCycleStatus(cycle.id, 'RETRYING');

      const attempts = await countCycleAttempts(cycle.id);
      await insertCycleAttempt({
        cycleId: cycle.id,
        attemptNumber: attempts + 1,
        scheduledFor,
      });

      if (subscription.status === 'ACTIVE') {
        assertSubscriptionTransition(subscription.status, 'PAST_DUE');
        await updateSubscriptionStatus(subscription.id, 'PAST_DUE');
        const event = await insertEvent({
          subscriptionId: subscription.id,
          cycleId: cycle.id,
          type: 'subscription.past_due',
          payload: { retryDate: scheduledFor },
        });
        await enqueueDelivery(event.id, 'subscription.past_due', {
          subscriptionId: subscription.id,
          externalUserId: subscription.externalUserId,
          retryDate: scheduledFor,
        });
      }

      retried += 1;
    } catch (error) {
      logger.error('falha ao reenviar cobranca', {
        cycleId: cycle.id,
        message: (error as Error).message,
      });
    }
  }

  return retried;
}

export async function expireOverdue(today: string): Promise<number> {
  const cycles = await listCyclesByStatus(['FAILED', 'RETRYING']);
  let expired = 0;

  for (const cycle of cycles) {
    if (nextRetryDate(cycle.dueDate, today, config.dunningWindowDays)) {
      continue;
    }

    assertCycleTransition(cycle.status, 'ABANDONED');
    await updateCycleStatus(cycle.id, 'ABANDONED');

    const subscription = await findSubscriptionById(cycle.subscriptionId);

    if (subscription && ['ACTIVE', 'PAST_DUE'].includes(subscription.status)) {
      if (subscription.status === 'ACTIVE') {
        await updateSubscriptionStatus(subscription.id, 'PAST_DUE');
      }
      await updateSubscriptionStatus(subscription.id, 'SUSPENDED');

      const event = await insertEvent({
        subscriptionId: subscription.id,
        cycleId: cycle.id,
        type: 'subscription.suspended',
        payload: { cycleSeq: cycle.seq },
      });
      await enqueueDelivery(event.id, 'subscription.suspended', {
        subscriptionId: subscription.id,
        externalUserId: subscription.externalUserId,
      });
    }

    expired += 1;
  }

  return expired;
}

export async function reconcile(): Promise<number> {
  const cycles = await listCyclesByStatus(['SENT', 'RETRYING']);
  let checked = 0;

  for (const cycle of cycles) {
    if (!cycle.interTxid) {
      continue;
    }

    try {
      const charge = await inter.getChargeByTxid(cycle.interTxid);

      if (['LIQUIDADA', 'CONCLUIDA', 'PAGA'].includes(charge.status)) {
        assertCycleTransition(cycle.status, 'PAID');
        await updateCycleStatus(cycle.id, 'PAID', {
          endToEndId: charge.endToEndId,
          paidAt: charge.paidAt ?? new Date().toISOString(),
        });

        const event = await insertEvent({
          subscriptionId: cycle.subscriptionId,
          cycleId: cycle.id,
          type: 'cycle.paid',
          payload: { txid: cycle.interTxid, source: 'reconcile' },
        });
        await enqueueDelivery(event.id, 'cycle.paid', {
          subscriptionId: cycle.subscriptionId,
          cycleSeq: cycle.seq,
          amount: cycle.amount,
        });
      }

      checked += 1;
    } catch (error) {
      logger.error('falha na reconciliacao', {
        cycleId: cycle.id,
        message: (error as Error).message,
      });
    }
  }

  return checked;
}
```

- [ ] **Step 5: Implementar `src/jobs/scheduler.ts`**

```ts
import cron from 'node-cron';
import { logger } from '../shared/logger';
import { deliverPending } from '../domain/webhookDispatcher';
import { withAdvisoryLock } from './lock';
import { expireOverdue, generateCycles, reconcile, retryFailed, sendCharges } from './billingJobs';

const LOCK_KEYS = {
  daily: 1001,
  reconcile: 1002,
  deliveries: 1003,
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function runDaily(): Promise<void> {
  const date = today();
  const generated = await generateCycles(date);
  const sent = await sendCharges(date);
  const retried = await retryFailed(date);
  const expired = await expireOverdue(date);
  logger.info('jobs diarios concluidos', { generated, sent, retried, expired });
}

export function startScheduler(): void {
  cron.schedule('0 8 * * *', () => {
    withAdvisoryLock(LOCK_KEYS.daily, runDaily).catch((error) =>
      logger.error('falha nos jobs diarios', { message: (error as Error).message }),
    );
  });

  cron.schedule('0 * * * *', () => {
    withAdvisoryLock(LOCK_KEYS.reconcile, reconcile).catch((error) =>
      logger.error('falha na reconciliacao', { message: (error as Error).message }),
    );
  });

  cron.schedule('* * * * *', () => {
    withAdvisoryLock(LOCK_KEYS.deliveries, deliverPending).catch((error) =>
      logger.error('falha na entrega de webhooks', { message: (error as Error).message }),
    );
  });
}
```

- [ ] **Step 6: Rodar o teste e confirmar que passa**

Run: `npx vitest run src/jobs`
Expected: PASS, 8 testes

- [ ] **Step 7: Commit**

```bash
git add src/jobs
git commit -m "feat: adiciona jobs de ciclo, cobranca, retentativa, suspensao e reconciliacao"
```

---

### Task 14: Limpeza do legado e novo entrypoint

**Files:**
- Modify: `src/server.ts`
- Rename: `src/recurringPix.ts` → `src/providers/inter/cobv.ts`
- Delete: `src/shared/supabase.ts`
- Modify: `src/repositories/transactions.ts`
- Modify: `package.json`
- Modify: `Dockerfile`
- Modify: `README.md`

**Interfaces:**
- Consumes: `createApp`, `startScheduler`, `runMigrations`, `config`
- Produces: `src/server.ts` que roda migrations, sobe o app e inicia o scheduler.

- [ ] **Step 1: Reescrever `src/server.ts`**

```ts
import { createApp } from './http/app';
import { startScheduler } from './jobs/scheduler';
import { runMigrations } from './shared/migrations';
import { config } from './shared/config';
import { logger } from './shared/logger';

async function main(): Promise<void> {
  const applied = await runMigrations(config.databaseUrl);

  if (applied.length > 0) {
    logger.info('migrations aplicadas', { applied });
  }

  const app = createApp();

  app.listen(config.port, () => {
    logger.info('servidor iniciado', { port: config.port });
  });

  startScheduler();
}

main().catch((error) => {
  logger.error('falha ao iniciar o servidor', { message: (error as Error).message });
  process.exit(1);
});
```

- [ ] **Step 2: Mover o `cobv` para o provider**

```bash
mkdir -p src/providers/inter
git mv src/recurringPix.ts src/providers/inter/cobv.ts
```

Em `src/providers/inter/cobv.ts`, renomear as funções para `createDueCharge`, `getDueCharge` e `authorizeDueCharge`, e ajustar os imports para `../../shared/api` e `../../types`.

- [ ] **Step 3: Remover o Supabase**

```bash
git rm src/shared/supabase.ts
npm uninstall @supabase/supabase-js
```

Reescrever `src/repositories/transactions.ts` sobre `query` de `../shared/db`, mantendo as mesmas assinaturas exportadas (`insertTransaction`, `updateTransactionStatus`, `markTransactionCompleted`, `updateTransactionTaxId`, `listRecentIncompleteTransactions`) e trocando as chamadas do client Supabase por SQL:

```ts
import { query } from '../shared/db';
import { CreateStoredTransaction, StoredTransaction, TransactionStatus } from '../types/transactions';

export async function insertTransaction(
  payload: CreateStoredTransaction,
): Promise<StoredTransaction> {
  const rows = await query<TransactionRow>(
    `INSERT INTO transactions
       (txid, internal_id, tax_id, status, callback_url, amount, pix_copy_paste)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      payload.txid,
      payload.internalId,
      payload.taxId ?? null,
      payload.status,
      payload.callbackUrl ?? null,
      payload.amount,
      payload.pixCopyPaste ?? null,
    ],
  );
  return mapRowToStoredTransaction(rows[0]);
}
```

E criar `migrations/002_transactions.sql` com a tabela `transactions` equivalente à que existia no Supabase, com as colunas `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `txid TEXT UNIQUE NOT NULL`, `internal_id TEXT NOT NULL`, `tax_id TEXT`, `status TEXT NOT NULL`, `callback_url TEXT`, `amount TEXT NOT NULL`, `pix_copy_paste TEXT`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`.

- [ ] **Step 4: Rodar a suíte inteira**

Run: `npm run type-check && npx vitest run`
Expected: type-check sem erro; todos os testes passando

- [ ] **Step 5: Atualizar o README**

Substituir a documentação de endpoints pela nova: `POST /subscriptions`, `GET /subscriptions/:id`, `POST /subscriptions/:id/cancel`, `POST /webhooks/inter`, `GET /health`. Documentar o header `Authorization: Bearer`, o formato do webhook de saída com `X-Signature`/`X-Timestamp` e o exemplo de verificação da assinatura em Node:

```ts
const expected = createHmac('sha256', secret)
  .update(`${req.header('X-Timestamp')}.${rawBody}`)
  .digest('hex');
```

Documentar também que o SaaS libera o plano apenas em `cycle.paid`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove supabase, renomeia cobv e reescreve o entrypoint"
```

---

## Self-Review

**Cobertura do spec:**

| Requisito do spec | Task |
|---|---|
| Config validada e janelas configuráveis | 1 |
| Logger com máscara de CPF/CNPJ | 2 |
| Postgres próprio, migrations, schema completo | 3 |
| Auth bearer timing-safe, error handler, `/health` | 4 |
| Máquina de estados de assinatura e ciclo | 5 |
| Janela 10–2 dias, dunning 7 dias, regra da véspera | 6 |
| Repositórios das cinco tabelas | 7 |
| Provider `rec`/`solicrec`/`cobr` com retentativa habilitada | 8 |
| `POST /subscriptions`, `GET /subscriptions/:id` | 9 |
| `POST /subscriptions/:id/cancel` com ciclo pendente | 10 |
| Webhook de entrada idempotente, sem confiar no corpo | 11 |
| Webhook de saída com HMAC e retry exponencial | 12 |
| Jobs com advisory lock | 13 |
| Remoção do Supabase, rename do `cobv`, README | 14 |
| Métricas | fora de escopo, por decisão |

**Consistência de tipos:** `Subscription`, `Cycle` e `CycleAttempt` definidos na Task 5 são os mesmos usados nas Tasks 7 a 13. `enqueueDelivery(eventId, type, data)` é definida na Task 12 e consumida na Task 11 — a Task 11 deve ser implementada depois da 12, ou o import falha. **Ordem obrigatória: 12 antes de 11.**

**Pendências que bloqueiam tasks específicas:**

- Task 8 depende de confirmar na documentação do Inter os paths de `rec`/`solicrec`/`cobr`, os nomes dos campos em português e o flag de retentativa. O restante do plano não conhece o formato do Inter, então uma divergência afeta só esse arquivo.
- Task 11 depende de confirmar a forma de validação de origem do webhook do Inter. Enquanto não confirmada, o endpoint fica protegido apenas pela reconsulta obrigatória — que já impede forjar pagamento, mas não impede tráfego indesejado.
- A Task 1 exige um Postgres de teste em `DATABASE_URL_TEST`. Sem ele, as Tasks 3, 7, 9 a 13 não rodam.
