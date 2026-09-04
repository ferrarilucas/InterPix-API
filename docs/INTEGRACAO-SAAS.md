# Integração SaaS ↔ InterPix API

Documento de handoff para quem for implementar o lado do SaaS (Next.js). Descreve o contrato
público desta API tal como está implementado — não o que foi planejado.

Tudo aqui foi conferido contra o código em `src/` no commit em que este arquivo foi escrito.
Onde há incerteza, está marcado como incerteza.

---

## 1. Quem faz o quê

| Responsabilidade | Dono |
|---|---|
| Assinaturas, ciclos, máquina de estados, dunning, histórico de eventos | InterPix API |
| Comunicação com o Banco Inter (mTLS, OAuth, `rec`/`cobr`) | InterPix API |
| Entitlements (quem tem acesso a qual plano) | SaaS |
| Identidade do usuário, cobrança na UI, e-mails | SaaS |

O SaaS **nunca** fala com o Banco Inter. Só com esta API.

## 2. Topologia

```
SaaS (Next.js)  --server-side, rede interna-->  InterPix API  --mTLS-->  Banco Inter
     ^                                               |
     |                                               |
     +---- POST assinado com HMAC (webhook saída) ---+

Banco Inter  --POST público, sem auth-->  InterPix API  /webhooks/inter
```

Duas consequências que precisam estar claras:

- As chamadas do SaaS para a API são **server-side**. O `API_TOKEN` é um segredo de servidor;
  nunca exponha em código de cliente nem em variável `NEXT_PUBLIC_*`.
- A rota `POST /webhooks/inter` precisa ser **alcançável pela internet** (o Inter chama de fora).
  As rotas `/subscriptions/*` devem ficar restritas à rede interna.

## 3. Autenticação (SaaS → API)

Todas as rotas exceto `GET /health` e `POST /webhooks/inter`:

```
Authorization: Bearer <API_TOKEN>
```

Token estático, mínimo 24 caracteres, comparado em tempo constante. Header ausente ou token
errado → `401 UNAUTHORIZED`.

## 4. Formato de erro

Toda resposta de erro tem o mesmo formato:

```json
{ "code": "BAD_REQUEST", "message": "Payload invalido.", "details": [] }
```

`details` só aparece em `400 BAD_REQUEST`, como lista de `{ path, message }`.

| HTTP | `code` | Significado |
|---|---|---|
| 400 | `BAD_REQUEST` | Validação falhou, ou corpo não é JSON válido |
| 401 | `UNAUTHORIZED` | Token ausente ou inválido |
| 404 | `NOT_FOUND` | Assinatura inexistente |
| 409 | `INVALID_TRANSITION` | Transição de estado não permitida (ver regra 2) |
| 500 | `INTERNAL_ERROR` | Erro interno. Nunca vaza detalhe do Inter nem stack |

Toda resposta traz `X-Request-Id`. Guarde-o no log do SaaS — é a chave para correlacionar com
o log da API quando algo der errado.

---

## 5. Endpoints

### `POST /subscriptions`

Cria a assinatura e registra a recorrência no Inter. Devolve o Pix Copia-e-Cola que o pagador
usa para autorizar no app do banco dele (Jornada 2 do Pix Automático).

**Request**

```json
{
  "externalUserId": "usr_123",
  "planCode": "mensal_29_90",
  "amount": "29.90",
  "intervalMonths": 1,
  "firstDueDate": "2026-09-20",
  "debtor": { "taxId": "12345678901", "name": "Fulano de Tal" }
}
```

| Campo | Regra |
|---|---|
| `externalUserId` | 1–128 chars. O id do usuário no banco do SaaS. A API não interpreta |
| `planCode` | 1–64 chars. Vai como `vinculo.contrato` para o Inter |
| `amount` | String `"NN.NN"`, exatamente duas casas. `"29.9"` e `29.90` (número) são rejeitados |
| `intervalMonths` | Inteiro 1–12 |
| `firstDueDate` | `YYYY-MM-DD`, no mínimo `CHARGE_LEAD_DAYS` dias à frente (padrão 3, piso do Bacen 2) |
| `debtor.taxId` | 11 dígitos (CPF) ou 14 (CNPJ), só números, sem pontuação |
| `debtor.name` | 1–200 chars |

**Response `201`**

```json
{
  "id": "6a1e...",
  "status": "PENDING_AUTH",
  "externalUserId": "usr_123",
  "planCode": "mensal_29_90",
  "amount": "29.90",
  "nextDueDate": "2026-09-20",
  "authorization": {
    "pixCopyPaste": "00020126...",
    "url": "https://qrcode.inter.com.br/..."
  }
}
```

O SaaS deve renderizar `authorization.pixCopyPaste` como QR Code (qualquer lib de QR serve — é
texto puro) e também oferecê-lo como texto copiável, para quem prefere colar no app do banco.

**Não colete dados bancários do assinante.** Agência, conta e banco do pagador não fazem parte
deste fluxo, de propósito.

Depois da criação, a assinatura fica em `PENDING_AUTH`. **Não libere nada ainda.**

### `GET /subscriptions/:id`

```json
{
  "id": "6a1e...",
  "status": "ACTIVE",
  "externalUserId": "usr_123",
  "planCode": "mensal_29_90",
  "amount": "29.90",
  "nextDueDate": "2026-10-20",
  "authorizedAt": "2026-09-18T14:02:00.000Z",
  "canceledAt": null,
  "cycles": [
    { "seq": 1, "dueDate": "2026-09-20", "amount": "29.90", "status": "PAID", "paidAt": "2026-09-19T09:00:00.000Z" }
  ]
}
```

Este endpoint é a fonte de verdade para reconciliação. Use-o quando desconfiar que perdeu um
webhook (ver seção 8).

### `POST /subscriptions/:id/cancel`

Sem corpo.

```json
{ "id": "6a1e...", "status": "CANCELED", "canceledAt": "2026-09-25T12:00:00.000Z", "pendingCycle": null }
```

Se uma cobrança já foi enviada ao Inter e não pôde ser cancelada a tempo, `pendingCycle` vem
preenchido — o SaaS deve avisar o usuário de que aquele débito específico ainda pode acontecer:

```json
{
  "pendingCycle": {
    "seq": 3,
    "dueDate": "2026-09-26",
    "status": "SENT",
    "note": "Cobranca ja enviada; nao pode ser cancelada e seguira seu curso."
  }
}
```

Regra do Bacen: a instrução de pagamento só pode ser cancelada até a véspera do vencimento.
Depois disso ela segue o curso mesmo com a assinatura cancelada.

---

## 6. Webhook de saída (API → SaaS)

A API faz `POST` em `SAAS_WEBHOOK_URL` com:

```
Content-Type: application/json
X-Signature: <hmac-sha256 hex>
X-Timestamp: <epoch ms>
```

Corpo:

```json
{ "type": "cycle.paid", "data": { "...": "..." }, "eventId": "482" }
```

### 6.1 Eventos e payloads exatos

Estes são os **sete** tipos efetivamente entregues. Os payloads abaixo são os campos reais de
`data`, não um exemplo aproximado.

| `type` | `data` | O que fazer |
|---|---|---|
| `cycle.paid` | `subscriptionId`, `cycleSeq`, `amount`, `paidAt` | **Liberar / renovar o plano** |
| `cycle.failed` | `subscriptionId`, `cycleSeq`, `reason` | Registrar. Plano continua ativo durante o dunning |
| `subscription.authorized` | `subscriptionId`, `externalUserId` | **Não libere nada.** Só atualize a UI |
| `subscription.auth_denied` | `subscriptionId`, `externalUserId` | Marcar como não autorizada. Nenhuma cobrança será enviada |
| `subscription.past_due` | `subscriptionId`, `externalUserId`, `retryDate` | Opcional: avisar o usuário |
| `subscription.suspended` | `subscriptionId`, `externalUserId` | **Suspender o acesso** |
| `subscription.canceled` | `subscriptionId`, `externalUserId`, `pendingCycleSeq` | Encerrar acesso ao fim do período pago |

`subscription.created` e `cycle.sent` existem na tabela `events` da API mas **não** viram
webhook de saída.

**Armadilha:** `cycle.paid` e `cycle.failed` **não trazem `externalUserId`** — só
`subscriptionId`. Como `cycle.paid` é justamente o evento que libera o plano, o SaaS precisa
guardar o mapeamento `subscriptionId → userId` no momento em que chama `POST /subscriptions`.
Não dá para resolver isso só reagindo ao webhook.

Valores possíveis de `cycle.failed.reason`:

- o motivo devolvido pelo Inter (texto livre) ou `null` — falha real de débito, ex. saldo insuficiente
- `"JANELA_DE_ENVIO_EXPIRADA"` — o ciclo não pôde ser enviado dentro da janela de 10–2 dias do Bacen
- `"SEM_CONFIRMACAO_DO_PROVEDOR"` — a cobrança foi enviada e o Inter nunca confirmou desfecho

### 6.2 Verificação da assinatura

HMAC-SHA256 sobre `` `${X-Timestamp}.${corpo bruto}` `` com `SAAS_WEBHOOK_SECRET`, comparado em
tempo constante, rejeitando timestamps com mais de 5 minutos.

É **obrigatório** usar os bytes originais do corpo. `JSON.stringify(req.body)` não é garantido
byte-a-byte igual ao que a API assinou — espaçamento e ordem de chaves podem diferir e a
assinatura não bate.

Em Next.js App Router, `await req.text()` já devolve o corpo bruto:

```ts
import { createHmac, timingSafeEqual } from 'crypto';

export async function POST(req: Request) {
  const raw = await req.text();
  const signature = req.headers.get('x-signature') ?? '';
  const timestamp = req.headers.get('x-timestamp') ?? '';

  if (!isValid(raw, timestamp, signature, process.env.SAAS_WEBHOOK_SECRET!)) {
    return new Response('invalid signature', { status: 401 });
  }

  const event = JSON.parse(raw) as InterPixEvent;
  await handleEvent(event);
  return Response.json({ received: true });
}

function isValid(raw: string, timestamp: string, signature: string, secret: string): boolean {
  const age = Date.now() - Number(timestamp);
  if (!Number.isFinite(age) || age > 5 * 60 * 1000 || age < 0) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Se o SaaS usar Pages Router ou Express, desligue o body parser nessa rota e capture o buffer
bruto antes do parse.

### 6.3 Tipos TypeScript sugeridos

```ts
export type InterPixEventType =
  | 'cycle.paid'
  | 'cycle.failed'
  | 'subscription.authorized'
  | 'subscription.auth_denied'
  | 'subscription.past_due'
  | 'subscription.suspended'
  | 'subscription.canceled';

export type InterPixEvent =
  | { type: 'cycle.paid'; eventId: string; data: { subscriptionId: string; cycleSeq: number; amount: string; paidAt: string } }
  | { type: 'cycle.failed'; eventId: string; data: { subscriptionId: string; cycleSeq: number; reason: string | null } }
  | { type: 'subscription.authorized'; eventId: string; data: { subscriptionId: string; externalUserId: string } }
  | { type: 'subscription.auth_denied'; eventId: string; data: { subscriptionId: string; externalUserId: string } }
  | { type: 'subscription.past_due'; eventId: string; data: { subscriptionId: string; externalUserId: string; retryDate: string } }
  | { type: 'subscription.suspended'; eventId: string; data: { subscriptionId: string; externalUserId: string } }
  | { type: 'subscription.canceled'; eventId: string; data: { subscriptionId: string; externalUserId: string; pendingCycleSeq: number | null } };

export type SubscriptionStatus =
  | 'PENDING_AUTH' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELED' | 'AUTH_DENIED';

export type CycleStatus =
  | 'SCHEDULED' | 'SENT' | 'PAID' | 'FAILED' | 'RETRYING' | 'ABANDONED' | 'CANCELED';
```

### 6.4 Retentativa da entrega

`1, 5, 15, 60, 360, 1440` minutos após cada falha — 6 tentativas. Esgotadas, a entrega é
**abandonada em definitivo**. Não há reenvio manual implementado.

A API considera entrega bem-sucedida qualquer resposta HTTP 2xx. Responda 2xx **assim que
validar a assinatura e persistir o evento**, antes de processar a lógica de negócio pesada —
timeout é 10 segundos.

---

## 7. Regras de integração obrigatórias

### Regra 1 — Libere o plano só em `cycle.paid`

Nunca em `subscription.authorized`. Autorização não é pagamento: o débito acontece depois e pode
falhar. Liberar na autorização dá acesso a quem nunca pagou.

### Regra 2 — Cancelamento não é idempotente

Uma segunda chamada a `POST /subscriptions/:id/cancel` retorna `409 INVALID_TRANSITION`, não
`200`. Isso acontece na prática após um timeout de rede em que a primeira chamada teve sucesso
no servidor.

**Trate `409 INVALID_TRANSITION` nesse endpoint como sucesso.**

### Regra 3 — Descarte eventos fora de ordem, comparando `eventId` como número

Entregas podem chegar fora de ordem depois de uma retentativa. Um `cycle.paid` atrasado
chegando após um `subscription.canceled` mais recente reativaria o acesso de quem já cancelou.

`eventId` é o id `BIGSERIAL` da tabela `events` da API, monotonicamente crescente, **serializado
como string no JSON**. Guarde o maior já aplicado por assinatura e descarte `<=`.

**Compare como número, nunca como string.** Em ordem lexicográfica `"1000" < "999"`, e o bug só
aparece quando a base cruza uma potência de 10 — bem depois do go-live, com sintoma de eventos
silenciosamente ignorados.

```ts
if (BigInt(event.eventId) <= BigInt(lastAppliedEventId)) return;
```

`BigInt` e não `Number` porque `BIGSERIAL` pode exceder `Number.MAX_SAFE_INTEGER`. Na prática
não vai, mas o custo de acertar é zero.

### Regra 4 — Verifique a assinatura HMAC

Ver 6.2. Sem isso, qualquer um que descubra a URL do webhook libera plano de graça.

### Regra 5 — Reconcilie

Depois de 6 falhas o evento é descartado para sempre. Se o SaaS ficar indisponível por mais de
~24h, eventos somem. Rode um job periódico que chame `GET /subscriptions/:id` para assinaturas
em estado não terminal e concilie com o estado local.

---

## 8. Máquina de estados

**Assinatura:**

```
PENDING_AUTH → ACTIVE | AUTH_DENIED | CANCELED
ACTIVE       → PAST_DUE | CANCELED
PAST_DUE     → ACTIVE | SUSPENDED | CANCELED
SUSPENDED    → CANCELED
CANCELED     → (terminal)
AUTH_DENIED  → (terminal)
```

**Ciclo:**

```
SCHEDULED → SENT | CANCELED
SENT      → PAID | FAILED | CANCELED
FAILED    → RETRYING | ABANDONED
RETRYING  → PAID | FAILED | ABANDONED
PAID | ABANDONED | CANCELED → (terminais)
```

Mapeamento sugerido para entitlement no SaaS:

| Status da assinatura | Acesso |
|---|---|
| `PENDING_AUTH` | Sem acesso |
| `ACTIVE` | Com acesso |
| `PAST_DUE` | **Com acesso** — está em dunning, ainda pode pagar |
| `SUSPENDED` | Sem acesso |
| `CANCELED` | Sem acesso ao fim do período já pago |
| `AUTH_DENIED` | Sem acesso |

## 9. Linha do tempo esperada

```
D-0    SaaS chama POST /subscriptions      → PENDING_AUTH, devolve Pix Copia-e-Cola
D-0    Usuário autoriza no app do banco    → subscription.authorized (NÃO libera)
D-10..D-2  API envia a cobrança ao Inter   → ciclo vai para SENT
D-0    Vencimento; Inter debita            → cycle.paid  → LIBERA O PLANO
       Se falhar                           → cycle.failed + subscription.past_due
D+1..D+7   Retentativas dentro da janela   → cycle.paid ou
D+7    Janela esgotada                     → subscription.suspended → SUSPENDE
```

O intervalo entre criar a assinatura e o primeiro `cycle.paid` é de **dias**, não segundos. A UI
precisa de um estado intermediário honesto ("aguardando a primeira cobrança"), não um spinner.

## 10. Como testar sem o Inter

Não há sandbox local nem modo simulado nesta API. Para exercitar o lado do SaaS de forma
isolada, gere você mesmo uma entrega assinada:

```bash
SECRET='seu_saas_webhook_secret'
TS=$(node -e 'console.log(Date.now())')
BODY='{"type":"cycle.paid","data":{"subscriptionId":"6a1e-fake","cycleSeq":1,"amount":"29.90","paidAt":"2026-09-19T09:00:00.000Z"},"eventId":"1"}'
SIG=$(node -e "console.log(require('crypto').createHmac('sha256','$SECRET').update('$TS.$BODY').digest('hex'))")

curl -X POST http://localhost:3000/api/webhooks/billing \
  -H "Content-Type: application/json" \
  -H "X-Signature: $SIG" \
  -H "X-Timestamp: $TS" \
  -d "$BODY"
```

Cubra pelo menos: assinatura inválida (deve dar 401), timestamp velho (401), `eventId` repetido
(ignorado), `eventId` menor que o último (ignorado) e `cycle.paid` de assinatura desconhecida.

## 11. O que ainda não foi validado

Isto não é ressalva de estilo — são coisas que podem quebrar em produção.

- **Nenhuma chamada ao Inter foi aceita em ambiente real.** O corpo de `PUT /pix/v2/cobr/{txid}`,
  incluindo o formato do objeto `recebedor` e os valores de `tipoConta`, foi montado a partir da
  documentação pública. Há divergência entre a documentação do Inter (que lista `nome`, `cnpj`,
  `agencia`, `conta`, `tipoConta`) e o manual técnico do Bacen e a documentação da Efí (que
  listam só `agencia`, `conta`, `tipoConta`). O primeiro teste em sandbox resolve.
- **Os nomes `endToEndId`, `horario` e `motivoRejeicao` na resposta do Inter são inferências.**
  Se estiverem errados, uma cobrança realmente paga mapeia para `UNKNOWN` em vez de `PAID`, e a
  assinatura nunca ativa. É o modo de falha a observar primeiro em sandbox.
- **O registro do webhook junto ao Inter não está implementado.** O endpoint `POST /webhooks/inter`
  existe e funciona, mas nada nesta API diz ao Inter para onde notificar. Enquanto isso não for
  feito, o Inter nunca chama e nenhuma assinatura sai de `PENDING_AUTH`. Este é o bloqueador
  funcional a fechar antes de qualquer teste ponta a ponta.
- **A origem do `POST /webhooks/inter` não é validada** (sem IP allowlist, sem mTLS de entrada).
  A defesa é que o webhook é só um gatilho: todo evento é confirmado reconsultando o Inter antes
  de mudar estado, então não dá para forjar um pagamento. Mas não impede tráfego indesejado.
