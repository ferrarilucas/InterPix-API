# Pix Automático: API de assinaturas recorrentes

Data: 2026-09-02
Status: proposto

## Objetivo

Transformar a InterPix-API em um serviço de assinaturas por Pix Automático, consumido
server-side por um SaaS em Next.js. A API é dona do estado de pagamento; o SaaS é dono do
direito de acesso do usuário.

Escopo desta fase: seguro e funcional. Endpoints de métricas ficam de fora, mas o log de
eventos é append-only desde o início, porque histórico não gravado não se reconstrói depois.

## Cenário

1. O SaaS chama `POST /subscriptions` server-side, passando valor, dados do cliente e o id do
   usuário no banco dele (`external_user_id`).
2. A API cria a recorrência no Inter e devolve o payload de autorização.
3. O usuário autoriza a recorrência no app do banco dele.
4. O Inter chama o webhook da API.
5. A API confirma o evento consultando o Inter, atualiza o estado e notifica o webhook do SaaS.
6. O SaaS libera o plano **no pagamento**, não na autorização.

API e SaaS rodam na mesma rede privada (Coolify). O único endpoint exposto à internet é o
webhook do Inter.

## Decisões

| Decisão | Escolha | Motivo |
|---|---|---|
| Modelo de recorrência | Pix Automático (`rec`/`solicrec`/`cobr`) | Débito sem ação do cliente a cada ciclo |
| Dono da assinatura | Esta API | Concentra a máquina de estados num lugar só |
| Banco | Postgres próprio, database `billing` na instância existente | Isolamento sem infra nova; sem credencial da API no banco do produto |
| Cliente do banco | `pg` + migrations em SQL puro | Combina com o estilo do código atual; sem camada mágica sobre transação de cobrança |
| Ingestão de eventos | Webhook do Inter + job de reconciliação | Webhook perdido não pode deixar assinatura com estado errado |
| Liberação de acesso | Apenas em `cycle.paid` | Autorização não é pagamento |
| Auth interna | Bearer token estático via env | Rede privada; simples e suficiente |
| Multi-tenant | Fora de escopo | Um produto com catálogo de planos; `tenant_id` depois é migração, não reescrita |
| Métricas | Fora de escopo | Extraíveis de `events` quando forem necessárias |

## Regras do Pix Automático que restringem o design

Fonte: FAQ Pix Automático para participantes, Banco Central, seções 4.3 a 4.16.

- A instrução de pagamento é enviada entre **10 e 2 dias** antes da data de liquidação. Fora
  dessa janela o envio é recusado.
- Se a liquidação falhar na data prevista, o **PSP do pagador** faz obrigatoriamente uma nova
  tentativa entre 18h e 21h do mesmo dia. Essa tentativa não é disparada pelo recebedor.
- Retentativas do recebedor são possíveis nos **7 dias subsequentes** ao vencimento, e
  **somente se a autorização da recorrência previr retentativa**. Isso é definido na criação da
  `rec` e não pode ser alterado depois.
- A retentativa mantém o **mesmo TxId** da cobrança original; muda apenas a data prevista.
- O envio da instrução de retentativa vai até 23h59 do dia anterior à liquidação.
- O recebedor pode cancelar uma cobrança apenas até a véspera da liquidação, e **não pode
  cancelar uma retentativa**.

Consequências diretas:

1. A `rec` é sempre criada com retentativa habilitada. Não habilitar significa perder o direito
   de cobrar de novo quem falhou por saldo, de forma irreversível para aquela assinatura.
2. Tentativas são filhas do ciclo e compartilham o txid. O txid identifica o ciclo, não a
   tentativa.
3. O job de geração roda em D-3, dentro da janela e com folga para falha e reprocessamento.
4. A janela de dunning é de 7 dias. A suspensão ocorre em D+8.
5. `POST /subscriptions/:id/cancel` valida a véspera antes de tentar cancelar no Inter.

## Arquitetura

Processo único Express com jobs `node-cron` no mesmo container, organizado em camadas para que
extrair um worker depois seja acrescentar um entrypoint, não reescrever:

```
src/
  http/          rotas, middlewares, validação Zod
  domain/        máquina de estados, política de dunning, regras de janela
  providers/inter/   cliente HTTP, rec, solicrec, cobr, webhook
  repositories/  acesso ao Postgres
  jobs/          geração de ciclos, retentativas, reconciliação, entrega de webhooks
  shared/        config, logger, erros
```

Jobs adquirem advisory lock no Postgres antes de rodar, para tolerar duas réplicas.

## Modelo de dados

Database `billing`, usuário próprio sem permissão no banco do SaaS.

```sql
CREATE TYPE subscription_status AS ENUM (
  'PENDING_AUTH', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELED', 'AUTH_DENIED'
);

CREATE TYPE cycle_status AS ENUM (
  'SCHEDULED', 'SENT', 'PAID', 'FAILED', 'RETRYING', 'ABANDONED', 'CANCELED'
);

CREATE TABLE subscriptions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_user_id  TEXT NOT NULL,
  plan_code         TEXT NOT NULL,
  amount            NUMERIC(12,2) NOT NULL,
  interval_months   SMALLINT NOT NULL DEFAULT 1,
  status            subscription_status NOT NULL DEFAULT 'PENDING_AUTH',
  inter_rec_id      TEXT UNIQUE,
  inter_solicrec_id TEXT,
  debtor_tax_id     TEXT NOT NULL,
  debtor_name       TEXT NOT NULL,
  next_due_date     DATE,
  authorized_at     TIMESTAMPTZ,
  canceled_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cycles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES subscriptions(id),
  seq             INTEGER NOT NULL,
  due_date        DATE NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,
  status          cycle_status NOT NULL DEFAULT 'SCHEDULED',
  inter_txid      TEXT UNIQUE,
  end_to_end_id   TEXT,
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, seq)
);

CREATE TABLE cycle_attempts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id         UUID NOT NULL REFERENCES cycles(id),
  attempt_number   SMALLINT NOT NULL,
  scheduled_for    DATE NOT NULL,
  sent_at          TIMESTAMPTZ,
  outcome          TEXT,
  failure_reason   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, attempt_number)
);

CREATE TABLE events (
  id              BIGSERIAL PRIMARY KEY,
  subscription_id UUID REFERENCES subscriptions(id),
  cycle_id        UUID REFERENCES cycles(id),
  type            TEXT NOT NULL,
  payload         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE inter_webhook_receipts (
  id           BIGSERIAL PRIMARY KEY,
  dedupe_key   TEXT NOT NULL UNIQUE,
  raw_payload  JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id            BIGSERIAL PRIMARY KEY,
  event_id      BIGINT NOT NULL REFERENCES events(id),
  target_url    TEXT NOT NULL,
  payload       JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING',
  attempts      SMALLINT NOT NULL DEFAULT 0,
  last_error    TEXT,
  next_retry_at TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON cycles (status, due_date);
CREATE INDEX ON subscriptions (status, next_due_date);
CREATE INDEX ON webhook_deliveries (status, next_retry_at);
CREATE INDEX ON events (subscription_id, created_at);
```

`events` é append-only: sem `UPDATE`, sem `DELETE`.

## Máquina de estados

Assinatura:

```
PENDING_AUTH ──autorizada──> ACTIVE
PENDING_AUTH ──negada/expirada──> AUTH_DENIED
ACTIVE ──ciclo vence sem pagar──> PAST_DUE
PAST_DUE ──pagamento em retentativa──> ACTIVE
PAST_DUE ──7 dias sem pagar──> SUSPENDED
ACTIVE|PAST_DUE|SUSPENDED ──cancelamento──> CANCELED
```

Ciclo:

```
SCHEDULED ──cobr enviada (D-3)──> SENT
SENT ──liquidado──> PAID
SENT ──falha na data prevista──> FAILED
FAILED ──nova instrução dentro dos 7 dias──> RETRYING
RETRYING ──liquidado──> PAID
RETRYING ──esgotou a janela──> ABANDONED
SCHEDULED|SENT ──cancelado até a véspera──> CANCELED
```

Transições são aplicadas por uma função única no domínio, que rejeita transição inválida com
erro. Nenhum repositório escreve `status` diretamente.

## Contratos

Todas as rotas abaixo, exceto o webhook do Inter, exigem `Authorization: Bearer <API_TOKEN>`.

### POST /subscriptions

```json
{
  "externalUserId": "usr_123",
  "planCode": "mensal_29_90",
  "amount": "29.90",
  "intervalMonths": 1,
  "firstDueDate": "2026-09-12",
  "debtor": { "taxId": "12345678901", "name": "Fulano de Tal" }
}
```

Resposta `201`:

```json
{
  "id": "0f8f...",
  "status": "PENDING_AUTH",
  "authorization": {
    "pixCopyPaste": "00020126...",
    "url": "https://..."
  }
}
```

A API devolve o payload de autorização em texto. A renderização do QR fica no Next, para não
adicionar dependência de geração de imagem aqui.

### GET /subscriptions/:id

Estado atual, ciclo corrente e histórico resumido de ciclos.

### POST /subscriptions/:id/cancel

Cancela a recorrência no Inter. Se houver ciclo com liquidação prevista para hoje ou já em
retentativa, o cancelamento da assinatura é registrado mas aquele ciclo segue seu curso, conforme
a regra do Bacen. A resposta informa explicitamente esse caso.

### POST /webhooks/inter

Público. Não exige o bearer token.

Tratamento: grava o corpo cru em `inter_webhook_receipts` com chave de deduplicação, responde
`200` imediatamente e processa de forma assíncrona. **O corpo recebido nunca é fonte de
verdade** — o processamento consulta a `rec` ou a `cobr` correspondente na API do Inter e age
sobre a resposta autenticada.

Além disso, o endpoint só aceita requisições que passem na validação de origem do Inter
(certificado cliente / mTLS conforme a configuração do webhook no Inter). A confirmação da forma
exata de validação é pendência aberta.

### Webhook de saída para o SaaS

`POST` no `SAAS_WEBHOOK_URL`, com cabeçalhos `X-Signature` (HMAC-SHA256 do corpo com
`SAAS_WEBHOOK_SECRET`) e `X-Timestamp`. O SaaS deve rejeitar assinatura inválida e timestamp com
mais de 5 minutos.

Eventos emitidos:

| Evento | Quando | Ação esperada no SaaS |
|---|---|---|
| `subscription.authorized` | Autorização aprovada | Mostrar "aguardando confirmação" |
| `subscription.auth_denied` | Autorização negada ou expirada | Oferecer nova tentativa |
| `cycle.paid` | Liquidação confirmada | **Liberar/renovar o plano** |
| `cycle.failed` | Falha na data prevista | Avisar o usuário |
| `subscription.past_due` | Entrou na janela de retentativa | Avisar; manter acesso a critério do SaaS |
| `subscription.suspended` | Esgotou os 7 dias | Revogar acesso |
| `subscription.canceled` | Cancelamento | Revogar acesso ao fim do período pago |

Entrega com retry exponencial (1min, 5min, 15min, 1h, 6h, 24h) e `FAILED` definitivo depois
disso, mantendo o registro para reprocessamento manual.

## Jobs

| Job | Frequência | Função |
|---|---|---|
| `generateCycles` | diário | Cria o próximo ciclo das assinaturas `ACTIVE` |
| `sendCharges` | diário | Envia `cobr` dos ciclos com vencimento em D-3 |
| `retryFailed` | diário | Nova instrução para ciclos `FAILED`/`RETRYING` dentro dos 7 dias |
| `expireOverdue` | diário | Move para `SUSPENDED` o que passou da janela |
| `reconcile` | de hora em hora | Reconsulta ciclos em aberto, cobrindo webhook perdido |
| `deliverWebhooks` | a cada minuto | Processa a fila de saída |

## Segurança

- Bearer token estático em `API_TOKEN`, comparado com `crypto.timingSafeEqual`
- Todo body validado com Zod antes de chegar ao domínio
- Erro do Inter nunca repassado cru na resposta; log interno completo, resposta genérica
- CPF/CNPJ mascarado no log
- Webhook do Inter é gatilho, nunca fonte de verdade
- Idempotência por `dedupe_key` no webhook de entrada e por `UNIQUE (subscription_id, seq)` nos
  ciclos
- Certificado e chave do Inter montados como secret, fora da imagem

## Configuração

```
DATABASE_URL
API_TOKEN
SAAS_WEBHOOK_URL
SAAS_WEBHOOK_SECRET
INTER_CLIENT_ID
INTER_CLIENT_SECRET
INTER_CERT_PATH
INTER_KEY_PATH
PIX_KEY
CHARGE_LEAD_DAYS=3
DUNNING_WINDOW_DAYS=7
```

## Fora de escopo

- Endpoints de métricas
- Multi-tenant
- Catálogo de planos em tabela (o plano vem como `planCode` e `amount` na request)
- Fallback para cobrança manual quando a autorização é negada
- Painel administrativo

## Trabalho de limpeza incluído

`src/recurringPix.ts` implementa `cobv`, que é cobrança com vencimento, não recorrência. O nome
mente e vai atrapalhar o debug quando o `cobr` de verdade existir. Renomear para `cobv.ts` e
ajustar tipos e rotas.

Remover `@supabase/supabase-js` e reescrever `src/repositories/transactions.ts` sobre `pg`.

## Riscos e pendências

1. **Escopos de Pix Automático na aplicação do Inter.** Bloqueia tudo. Confirmar antes de
   começar.
2. **Forma de validação do webhook do Inter.** Confirmar na documentação se é mTLS com
   certificado cliente e qual a cadeia esperada.
3. **Nomes reais dos campos da API do Inter** para `rec`, `solicrec` e `cobr`. Os contratos acima
   são do lado público da API; o mapeamento para o Inter será feito na implementação a partir da
   documentação oficial.
4. **Tarifa.** 0,99%, mínimo R$ 0,10 e máximo R$ 1,50, com 60 cobranças isentas em cota única,
   conforme informado pelo SAC. Confirmar por escrito se a regra vale para Pix Automático.
