# InterPix API

![Node.js](https://img.shields.io/badge/Node.js-18.x-blue?style=for-the-badge&logo=node.js)
![Express.js](https://img.shields.io/badge/Express.js-4.x-green?style=for-the-badge&logo=express)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?style=for-the-badge&logo=typescript)

API de assinaturas com Pix Automático (Banco Inter), usada por um SaaS em Next.js para criar assinaturas, receber cobranças recorrentes e ser notificada por webhook quando um ciclo é pago, falha ou a assinatura muda de estado.

A API guarda o próprio estado em Postgres (assinaturas, ciclos, tentativas, eventos), executa os jobs diários de geração/envio/retentativa de cobrança e entrega eventos ao SaaS via webhook assinado com HMAC, com retentativa exponencial.

## Sumário

- [Arquitetura](#arquitetura)
- [Configuração](#configuração)
- [Como executar](#como-executar)
- [Endpoints](#endpoints)
- [Webhook de saída (API → SaaS)](#webhook-de-saída-api--saas)
- [Regras de integração](#regras-de-integração)
- [Lacunas conhecidas](#lacunas-conhecidas)
- [Notas operacionais](#notas-operacionais)

## Arquitetura

```
src/
├── server.ts                 # Entrypoint: roda migrations, sobe o Express e o scheduler
├── http/
│   ├── app.ts                 # Monta rotas e middlewares (auth, error handler)
│   ├── middlewares/            # requireAuth (Bearer), errorHandler, requestContext
│   └── routes/                 # subscriptions, interWebhook
├── domain/                    # Máquina de estados, regras de janela/dunning, dispatcher de webhook
├── jobs/                      # scheduler (cron) + billingJobs (geração/envio/retentativa/reconciliação)
├── providers/inter/            # Integração com a API do Banco Inter (rec, cobr)
├── repositories/               # Acesso a Postgres (subscriptions, cycles, events, webhookDeliveries, ...)
└── shared/                    # config validada (zod), logger com máscara de CPF/CNPJ, db (pg), migrations
```

O código legado de cobrança avulsa (`/charge` e `/recurring-charge`, endpoints que existiam em versões anteriores desta API) e sua dependência do Supabase foram removidos: não há mais rotas, providers ou repositório para isso. O `server.ts` atual só sobe o app de assinaturas descrito abaixo.

## Configuração

Variáveis de ambiente obrigatórias (validadas por `src/shared/config.ts`; o processo não sobe se alguma faltar):

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | String de conexão Postgres usada em runtime |
| `API_TOKEN` | Token estático (mínimo 24 caracteres) exigido no header `Authorization: Bearer` |
| `SAAS_WEBHOOK_URL` | URL do SaaS que recebe os eventos de webhook |
| `SAAS_WEBHOOK_SECRET` | Segredo (mínimo 24 caracteres) usado para assinar o webhook em HMAC-SHA256 |
| `INTER_CLIENT_ID` | Client ID da aplicação no Banco Inter |
| `INTER_CLIENT_SECRET` | Client secret da aplicação no Banco Inter |
| `INTER_CERT_PATH` | Caminho do certificado `.crt`/`.cer` usado no mTLS com o Inter |
| `INTER_KEY_PATH` | Caminho da chave privada correspondente ao certificado |
| `PIX_KEY` | Chave Pix usada para gerar as cobranças |
| `INTER_RECEBEDOR_NOME` | Nome da conta recebedora registrada no Inter (obrigatório em toda cobrança) |
| `INTER_RECEBEDOR_CNPJ` | CNPJ (14 dígitos) da conta recebedora registrada no Inter |
| `INTER_RECEBEDOR_AGENCIA` | Agência da conta recebedora registrada no Inter |
| `INTER_RECEBEDOR_CONTA` | Número da conta recebedora registrada no Inter |
| `INTER_RECEBEDOR_TIPO_CONTA` | Tipo da conta recebedora no Inter (`CORRENTE`, `POUPANCA` ou `PAGAMENTO`) |
| `CHARGE_LEAD_DAYS` | Dias de antecedência para envio da cobrança (padrão 3, entre 2 e 10) |
| `DUNNING_WINDOW_DAYS` | Janela de retentativa após vencimento (padrão 7, entre 1 e 7) |
| `PORT` | Porta HTTP (padrão 3000) |

Além de `DATABASE_URL`, a suíte de testes precisa de `DATABASE_URL_TEST` apontando para um Postgres alcançável (local ou em container) — os testes de repositório rodam migrations reais e fazem I/O contra esse banco. Sem ele, `npm test` falha ao subir. Veja `.env.example` para um modelo completo.

## Como executar

```bash
npm install
npm run build
npm run migrate     # aplica as migrations pendentes em migrations/*.sql contra DATABASE_URL
npm start
```

Em desenvolvimento, `npm run dev` compila e sobe o servidor. `npm run type-check` roda apenas o `tsc --noEmit`. O próprio `server.ts` também roda `runMigrations` automaticamente ao subir, então `npm run migrate` é redundante em produção — útil principalmente para aplicar migrations sem subir o servidor (ex.: em um step de deploy separado).

Testes: `npm test` (ou `npx vitest run`). Requer `DATABASE_URL_TEST` configurado em `.env.test` e um Postgres alcançável nesse endereço.

## Endpoints

Todos os endpoints abaixo, exceto `GET /health` e `POST /webhooks/inter`, exigem o header:

```
Authorization: Bearer <API_TOKEN>
```

A comparação do token é feita em tempo constante (`timingSafeEqual`). Requisição sem o header, ou com token incorreto, recebe `401 UNAUTHORIZED`.

Todo erro segue o formato:

```json
{ "code": "NOT_FOUND", "message": "Assinatura nao encontrada.", "details": [] }
```

(`details` só aparece em erros de validação, `400 BAD_REQUEST`.)

### `GET /health`

Sem autenticação. Usado para checagem de liveness.

```bash
curl http://localhost:3000/health
```

```json
{ "status": "ok" }
```

### `POST /subscriptions`

Cria uma assinatura e registra a recorrência (`rec`) no Inter. A autorização segue a Jornada 2 do Pix
Automático: a API nunca coleta dados bancários do pagador (agência/conta/banco); em vez disso ela devolve
um QR Code contendo os dados da recorrência, que o pagador le e autoriza no próprio app do banco dele.

```bash
curl -X POST http://localhost:3000/subscriptions \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "externalUserId": "usr_123",
    "planCode": "mensal_29_90",
    "amount": "29.90",
    "intervalMonths": 1,
    "firstDueDate": "2026-09-20",
    "debtor": { "taxId": "12345678901", "name": "Fulano de Tal" }
  }'
```

Regras de validação (rejeitadas com `400 BAD_REQUEST`):
- `amount`: string no formato `"99.90"` (duas casas decimais).
- `intervalMonths`: inteiro entre 1 e 12.
- `firstDueDate`: `YYYY-MM-DD`, precisa de no mínimo `CHARGE_LEAD_DAYS` dias de antecedência (padrão 3, nunca menos que os 2 dias mínimos do Bacen). Uma data mais próxima que isso geraria um ciclo que nunca poderia ser enviado, porque a instrução de pagamento só é aceita entre 10 e 2 dias antes do vencimento.
- `debtor.taxId`: 11 dígitos (CPF) ou 14 dígitos (CNPJ), só números.

Resposta (`201`):

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

`authorization.pixCopyPaste` e o Pix Copia-e-Cola do QR Code da recorrência: o SaaS deve exibi-lo como
QR Code (ou deixar o cliente colar o texto no app do banco) para que o pagador autorize a recorrência.
Nenhum dado bancário do pagador (agência, conta, banco) precisa ser coletado nesse fluxo. A assinatura
fica em `PENDING_AUTH` até o Inter confirmar a autorização (ver [webhook de saída](#webhook-de-saída-api--saas)).

### `GET /subscriptions/:id`

```bash
curl http://localhost:3000/subscriptions/6a1e... \
  -H "Authorization: Bearer $API_TOKEN"
```

Resposta (`200`):

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

`404 NOT_FOUND` se o id não existir.

### `POST /subscriptions/:id/cancel`

```bash
curl -X POST http://localhost:3000/subscriptions/6a1e.../cancel \
  -H "Authorization: Bearer $API_TOKEN"
```

Resposta (`200`) quando não há ciclo pendente:

```json
{ "id": "6a1e...", "status": "CANCELED", "canceledAt": "2026-09-25T12:00:00.000Z", "pendingCycle": null }
```

Se já existia uma cobrança enviada (ou falhada, em retentativa) que não pôde ser cancelada a tempo, `pendingCycle` vem preenchido para o SaaS avisar o usuário que aquela cobrança específica ainda pode ser debitada:

```json
{
  "id": "6a1e...",
  "status": "CANCELED",
  "canceledAt": "2026-09-25T12:00:00.000Z",
  "pendingCycle": {
    "seq": 3,
    "dueDate": "2026-09-26",
    "status": "SENT",
    "note": "Cobranca ja enviada; nao pode ser cancelada e seguira seu curso."
  }
}
```

Ver [regra 2](#regras-de-integração) sobre o comportamento em retry.

### `POST /webhooks/inter`

Sem autenticação por `Authorization` (ver [lacunas conhecidas](#lacunas-conhecidas)). É o endpoint de entrada de notificações do Banco Inter. Responde `200 { "received": true }` imediatamente e processa o evento de forma assíncrona, reconsultando sempre o status real no Inter antes de mudar qualquer coisa — o corpo do webhook nunca é tratado como verdade absoluta.

Este endpoint é consumido pelo Banco Inter, não pelo SaaS. Documentado aqui só para contexto operacional.

## Webhook de saída (API → SaaS)

A API entrega eventos para `SAAS_WEBHOOK_URL` via `POST`, com o corpo:

```json
{ "type": "cycle.paid", "eventId": "482", "data": { "subscriptionId": "6a1e...", "cycleSeq": 1, "amount": "29.90", "paidAt": "2026-09-19T09:00:00.000Z" } }
```

Headers:

```
Content-Type: application/json
X-Signature: <hmac-sha256 hex>
X-Timestamp: <epoch ms>
```

Eventos emitidos:

| `type` | Quando ocorre | O que o SaaS deve fazer |
|---|---|---|
| `cycle.paid` | O ciclo (cobrança do mês) foi confirmado como pago no Inter | **Liberar o acesso ao plano** para o `externalUserId`/assinatura (ver [regra 1](#regras-de-integração)) |
| `cycle.failed` | O débito automático do ciclo falhou (ex.: saldo insuficiente) | Registrar a falha; o plano continua ativo enquanto a API tenta novamente dentro da janela de dunning |
| `subscription.authorized` | O pagador autorizou a recorrência no Inter | **Não** liberar o plano ainda — é só autorização, o débito acontece depois (ver [regra 1](#regras-de-integração)). Pode ser usado para UI ("autorização confirmada, aguardando primeira cobrança") |
| `subscription.auth_denied` | O pagador negou ou a autorização expirou | Marcar a assinatura como não autorizada; nenhuma cobrança será enviada |
| `subscription.past_due` | O ciclo atual falhou e a assinatura entrou em atraso, mas ainda dentro da janela de retentativa | Opcional: avisar o usuário que há uma cobrança pendente |
| `subscription.suspended` | A janela de dunning esgotou sem pagamento | Suspender o acesso ao plano |

| `subscription.canceled` | A assinatura foi cancelada via `POST /subscriptions/:id/cancel` | Encerrar o acesso ao fim do período já pago. `data.pendingCycleSeq` indica um ciclo que ainda pode ser debitado |

Criação (`subscription.created`) e envio de cobrança (`cycle.sent`) são registrados na tabela `events` mas **não** geram webhook de saída.

Atenção: `cycle.paid` e `cycle.failed` carregam apenas `subscriptionId`, **sem** `externalUserId`. Como `cycle.paid` é o evento que libera o plano, o SaaS precisa guardar o mapeamento `subscriptionId → userId` no momento em que chama `POST /subscriptions`.

Para o contrato completo — payloads exatos de cada evento, tipos TypeScript e checklist de implementação — ver [docs/INTEGRACAO-SAAS.md](docs/INTEGRACAO-SAAS.md).

Retentativa (ver [regra 5](#regras-de-integração)): agendamento em minutos `[1, 5, 15, 60, 360, 1440]` a partir da primeira falha (1 min, 5 min, 15 min, 1h, 6h, 24h). Esgotadas as 6 tentativas, a entrega é marcada como definitivamente falha e abandonada — não há mais retentativa depois disso.

## Regras de integração

Estas cinco regras vieram de decisões de design tomadas durante a implementação. Cada uma evita um bug específico do lado do SaaS.

1. **Libere o plano só em `cycle.paid`, nunca em `subscription.authorized`.** Autorização não é pagamento: o débito acontece depois e pode falhar (saldo insuficiente, cancelamento pelo pagador, etc.). Liberar acesso na autorização dá acesso a quem nunca pagou.

2. **O cancelamento não é idempotente.** Uma segunda chamada a `POST /subscriptions/:id/cancel` depois de um timeout de rede — mesmo que a primeira chamada tenha sido bem-sucedida no servidor — retorna `409` com `code: "INVALID_TRANSITION"`, não `200`. O SaaS deve tratar `409 INVALID_TRANSITION` nesse endpoint como equivalente a sucesso (a assinatura já está cancelada).

3. **Ignore qualquer evento cujo `eventId` seja menor que o último já processado para aquela assinatura.** Entregas podem chegar fora de ordem após uma retentativa — um `cycle.paid` atrasado chegando depois de um `subscription.canceled` mais recente reativaria indevidamente o acesso de alguém que já cancelou. `eventId` é monotonicamente crescente (é o id sequencial do evento no Postgres da API), então basta guardar o maior `eventId` já aplicado por assinatura e descartar qualquer entrega com `eventId` menor ou igual.

4. **Verifique a assinatura do webhook.** HMAC-SHA256 sobre `${X-Timestamp}.${corpo bruto}` com `SAAS_WEBHOOK_SECRET`, comparado em tempo constante, rejeitando timestamps com mais de 5 minutos. Exemplo em Node usando o corpo bruto (é obrigatório usar os bytes originais — um corpo reserializado, mesmo com o mesmo conteúdo lógico, não bate com a assinatura por causa de diferenças de espaçamento/ordem de chaves):

   ```ts
   import { createHmac, timingSafeEqual } from 'crypto';

   function isValidWebhook(rawBody: Buffer, timestamp: string, signature: string, secret: string): boolean {
     const age = Date.now() - Number(timestamp);
     if (!Number.isFinite(age) || age > 5 * 60 * 1000 || age < 0) {
       return false;
     }

     const expected = createHmac('sha256', secret)
       .update(`${timestamp}.${rawBody}`)
       .digest('hex');

     const expectedBuf = Buffer.from(expected, 'hex');
     const receivedBuf = Buffer.from(signature, 'hex');
     if (expectedBuf.length !== receivedBuf.length) {
       return false;
     }
     return timingSafeEqual(expectedBuf, receivedBuf);
   }
   ```

   Em Express, isso exige capturar o corpo bruto antes do parse JSON (ex.: `express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })`), já que `JSON.stringify(req.body)` não é garantido ser byte-a-byte igual ao que a API assinou.

5. **Retentativa do webhook de saída.** A API tenta entregar cada evento em `1, 5, 15, 60, 360 e 1440` minutos após a falha anterior (6 tentativas ao todo). Esgotadas as tentativas, a entrega é abandonada e **não há mais nenhum reenvio automático**. Isso significa que o SaaS precisa estar disponível para receber o webhook, ou reconciliar por outro meio (ex.: consultar `GET /subscriptions/:id` periodicamente) para não perder eventos definitivamente descartados após uma indisponibilidade prolongada.

## Lacunas conhecidas

- **A Pix Automático foi implementada como Jornada 2 (autorização via QR Code), de propósito**: a API nunca coleta dados bancários do assinante (agência/conta/banco do pagador). Se um dia for preciso trocar para a Jornada 1 (notificação no app do pagador, sem QR Code), isso exige tanto reintroduzir a chamada a `POST /solicrec` quanto novos campos em `POST /subscriptions` para identificar o pagador (CPF/CNPJ, ISPB do banco, agência e conta) — não é uma troca de configuração, é uma mudança de contrato público.
- **O payload de `createCharge` (`PUT /pix/v2/cobr/{txid}`) não foi verificado ponta a ponta contra o sandbox do Inter.** O corpo inteiro — incluindo o formato do objeto `recebedor` e os valores aceitos de `tipoConta` — foi montado a partir da documentação pública do Inter, nunca confirmado por uma chamada real aceita em sandbox. O mesmo vale para `vinculo.contrato` (enviado como `planCode` em `POST /rec`): confirmado como campo obrigatório na documentação, mas nunca visto sendo aceito de fato. Também não confirmados: os nomes dos campos `endToEndId`, `horario` (mapeado para `paidAt`) e `motivoRejeicao` (mapeado para `failureReason`) na resposta de uma cobrança liquidada ou rejeitada — são inferências, não confirmações da doc real. Se algum desses nomes estiver errado, uma cobrança paga de verdade mapeia para status `UNKNOWN` em vez de `PAID`/`FAILED`, e a assinatura correspondente nunca sai de `PENDING_AUTH`/fica presa sem ativar — esse é o modo de falha a observar em sandbox antes de ir para produção.
- **A origem do webhook de entrada (`POST /webhooks/inter`) não é validada.** Não há checagem de IP de origem, mTLS de entrada ou assinatura do lado do Inter nesse endpoint. A defesa atual é que o webhook é tratado apenas como um gatilho: todo evento é confirmado reconsultando o status real no Inter (`getChargeByTxid`/`getRecurrence`) antes de qualquer mudança de estado, então não é possível forjar um pagamento só enviando um POST para esse endpoint. Isso não impede, no entanto, tráfego indesejado ou consumo de recursos por chamadas repetidas.

## Notas operacionais

- **Variáveis de ambiente**: ver tabela em [Configuração](#configuração). `src/shared/config.ts` valida tudo com zod na subida do processo e falha rápido com uma mensagem listando o que está faltando.
- **Migrations**: arquivos SQL em `migrations/*.sql`, aplicados em ordem alfabética por `src/shared/migrations.ts`. Cada arquivo roda dentro de uma transação e é registrado em `schema_migrations` para não rodar duas vezes. `server.ts` roda `runMigrations` automaticamente a cada subida; `npm run migrate` faz o mesmo manualmente contra `DATABASE_URL`.
- **Logger**: `src/shared/logger.ts` mascara CPF/CNPJ e outros dados sensíveis antes de logar — não desabilite isso ao depurar em produção.
- **Testes**: `npm test` roda contra um Postgres real (não há mocks de banco). Configure `DATABASE_URL_TEST` em `.env.test` apontando para uma instância descartável (local, Docker, etc.) antes de rodar a suíte.
- **Jobs**: `startScheduler()` registra três crons — jobs diários (geração/envio/retentativa/expiração de cobranças, `0 8 * * *`), reconciliação horária (`0 * * * *`) e entrega de webhooks pendentes a cada minuto (`* * * * *`). Todos usam advisory lock do Postgres para evitar execução concorrente entre múltiplas instâncias do processo.
