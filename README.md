# InterPix API

![Node.js](https://img.shields.io/badge/Node.js-18.x-blue?style=for-the-badge&logo=node.js)
![Express.js](https://img.shields.io/badge/Express.js-4.x-green?style=for-the-badge&logo=express)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?style=for-the-badge&logo=typescript)

API facilitada para integração com o sistema de pagamentos PIX do Banco Inter, permitindo a criação e consulta de cobranças imediatas e recorrentes, armazenamento de transações no Supabase e callbacks automáticos quando o pagamento é concluído.

## Funcionalidades

- Criação de cobranças PIX imediatas (`/charge`).
- Consulta de cobranças PIX existentes (`/charge/:txid`).
- Criação de cobranças PIX recorrentes (`/recurring-charge`).
- Consulta de cobranças recorrentes (`/recurring-charge/:txid`).
- Autorização de cobranças recorrentes (`/recurring-charge/:txid/authorize`).
- Geração de QR Code e linha digitável (copia e cola).

## Arquitetura

O projeto foi estruturado de forma modular para facilitar a manutenção e evitar duplicação de código:

- **`src/server.ts`**: Servidor Express com as rotas da API e job de cron
- **`src/shared/api.ts`**: Configuração da API do Banco Inter e autenticação (OAuth)
- **`src/pix.ts`**: Cobranças PIX imediatas e consulta de recebimentos
- **`src/recurringPix.ts`**: Cobranças PIX com vencimento/recorrentes
- **`src/shared/supabase.ts`**: Cliente do Supabase
- **`src/repositories/transactions.ts`**: Persistência de transações e atualizações de status/taxId
- **`src/types/transactions.ts`**: Tipos de transações persistidas

## Pré-requisitos

- Node.js (versão 18.x ou superior)
- Conta PJ no Banco Inter com API PIX habilitada.

## Configuração do Projeto

1.  **Clone o repositório:**

    ```bash
    git clone https://github.com/seu-usuario/interpix-api.git
    cd interpix-api
    ```

2.  **Instale as dependências:**

    Como o projeto usa `package-lock.json`, o `npm` é o gerenciador de pacotes recomendado.

    ```bash
    npm install
    ```

3.  **Certificados do Banco Inter:**

    Para se comunicar com a API do Inter, você precisará dos certificados de autenticação.

    - Siga o [tutorial oficial do Banco Inter](https://developers.bancointer.com.br/docs/introducao) para criar sua aplicação e obter os arquivos de certificado (`.cer`) e chave (`.key`).
    - Salve esses arquivos em uma pasta chamada `certs` na raiz do projeto.

4.  **Variáveis de Ambiente:**

    Crie um arquivo `.env` na raiz do projeto, baseado no exemplo abaixo. Substitua os valores pelas suas credenciais e caminhos de arquivo.

    ```env
    # Certificados (caminhos relativos à raiz do projeto)
    INTER_CERT_PATH=./certs/seu-certificado.cer
    INTER_KEY_PATH=./certs/sua-chave.key

    # Credenciais da sua aplicação no Banco Inter
    INTER_CLIENT_ID=seu-client-id
    INTER_CLIENT_SECRET=seu-client-secret

    # Chave PIX usada para gerar as cobranças
    PIX_KEY=sua-chave-pix

    # Supabase (use Service Role Key no backend)
    SUPABASE_URL=https://xxxx.supabase.co
    SUPABASE_KEY=eyJhbGciOiJI...service_role
    # Opcional: nome da tabela; default: transactions
    SUPABASE_TRANSACTIONS_TABLE=transactions
    ```

## Como Executar

1.  **Compile o código TypeScript:**

    ```bash
    npm run build
    ```

2.  **Inicie o servidor:**

    ```bash
    npm run start
    ```

    O servidor estará rodando em `http://localhost:3000`.

## Banco de Dados (Supabase)

Crie a tabela (ajuste o nome conforme `SUPABASE_TRANSACTIONS_TABLE`):

```sql
create extension if not exists pgcrypto;

create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  txid text not null unique,
  internal_id text not null,
  tax_id text null,
  status text not null check (status in ('ACTIVE','COMPLETED','REMOVED_BY_USER','REMOVED_BY_PSP')),
  callback_url text null,
  amount text not null,
  pix_copy_paste text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_transactions_status on transactions (status);
create index if not exists idx_transactions_created_at on transactions (created_at);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_transactions_set_updated_at on transactions;
create trigger trg_transactions_set_updated_at
before update on transactions
for each row execute function set_updated_at();
```

RLS: utilize a Service Role Key no backend OU crie políticas que permitam INSERT/SELECT/UPDATE para o role adequado.

## Desenvolvimento

### Estrutura de Pastas

```
src/
├── shared/
│   ├── api.ts            # Configuração da API do Banco Inter (OAuth)
│   └── supabase.ts       # Cliente Supabase
├── repositories/
│   └── transactions.ts   # Persistência de transações
├── types/
│   ├── index.ts          # Exportações centralizadas dos tipos
│   ├── api-requests.ts   # Interfaces da API pública (inglês)
│   ├── inter-api.ts      # Interfaces da API do Banco Inter (pt-BR)
│   ├── transactions.ts   # Tipos da entidade persistida
│   └── mappers.ts        # Mapeamentos entre formatos
├── pix.ts                # Cobranças imediatas e recebimentos
├── recurringPix.ts       # Cobranças com vencimento
└── server.ts             # Servidor Express, rotas e cron
```

### Scripts Disponíveis

- `npm run build`: Compila o código TypeScript
- `npm run start`: Inicia o servidor em produção
- `npm run dev`: Compila e inicia o servidor em desenvolvimento
- `npm run type-check`: Verifica os tipos sem gerar arquivos

### Mapeamento de Dados

A API utiliza um sistema de mapeamento automático que converte:

- **Entrada (API Pública)**: Campos em inglês (`calendar`, `debtor`, `value`, `key`, etc.)
- **Processamento Interno**: Campos em português para comunicação com o Banco Inter (`calendario`, `devedor`, `valor`, `chave`, etc.)
- **Saída (API Pública)**: Resposta mapeada de volta para inglês com status traduzidos

Isso garante que a API seja internacional e fácil de usar, enquanto mantém compatibilidade total com a API do Banco Inter.

---

## Persistência e Cron

- Ao criar `/charge`, a API salva no Supabase: `txid`, `internalId`, `taxId` (opcional), `status`, `callbackUrl` (opcional), `amount` e `pix_copy_paste`.
- Um cron job roda a cada 30 segundos e verifica transações `ACTIVE` criadas nos últimos 40 minutos:
  - Consulta o status no Inter; se mudar para `COMPLETED`, registra no banco
  - Busca o CPF/CNPJ do pagador via `GET /pix/v2/pix` (requer escopo `pix.read`) e atualiza `tax_id` quando disponível
  - Se houver `callbackUrl`, envia POST com `{ status, taxId, internalId }`

---

## API Endpoints

A seguir estão os detalhes dos endpoints disponíveis na API.

### Cobrança Imediata

#### 1. Criar Cobrança (`POST /charge`)

Cria uma nova cobrança PIX com um valor específico e registra metadados para acompanhamento.

**Request Body:**

```json
{
  "value": 10.50,
  "internalId": "order-abc-123",
  "callbackUrl": "https://minha.app/callback",
  "taxId": "12345678901"
}
```

**Exemplo com cURL:**

```bash
curl -X POST http://localhost:3000/charge \
-H "Content-Type: application/json" \
-d '{
  "value": 10.50,
  "internalId": "order-abc-123",
  "callbackUrl": "https://minha.app/callback",
  "taxId": "12345678901"
}'
```

**Response (201 Created):**
Retorna o objeto completo da cobrança criada, incluindo `txid`, `status`, `value.original`, `pixCopyPaste` e `location`.

#### 2. Consultar Cobrança (`GET /charge/:txid`)

Consulta uma cobrança PIX existente usando o `txid`.

**Exemplo com cURL:**

```bash
curl http://localhost:3000/charge/seu-txid-aqui
```

**Response (200 OK):**
Retorna os detalhes completos da cobrança.

---

### Cobrança Recorrente

#### 1. Criar Cobrança Recorrente (`POST /recurring-charge`)

Cria uma nova cobrança PIX recorrente. O corpo da requisição deve seguir a [documentação oficial do Banco Inter para cobranças com vencimento](https://developers.bancointer.com.br/docs/pix/cobranca-com-vencimento_v2_requisicao#tag/Cobranca-com-Vencimento/operation/putCobvTxid).

**Request Body (Exemplo):**

```json
{
  "calendar": {
    "dueDate": "2024-12-30",
    "validityAfterDue": 60
  },
  "debtor": {
    "cpf": "12345678901",
    "name": "Cliente Exemplo"
  },
  "value": {
    "original": "50.00"
  },
  "key": "sua-chave-pix"
}
```

**Exemplo com cURL:**

```bash
curl -X POST http://localhost:3000/recurring-charge \
-H "Content-Type: application/json" \
-d '{
  "calendar": { "dueDate": "2024-12-30", "validityAfterDue": 60 },
  "debtor": { "cpf": "12345678901", "name": "Cliente Exemplo" },
  "value": { "original": "50.00" },
  "key": "sua-chave-pix"
}'
```

#### 2. Consultar Cobrança Recorrente (`GET /recurring-charge/:txid`)

Consulta uma cobrança recorrente existente.

**Exemplo com cURL:**

```bash
curl http://localhost:3000/recurring-charge/seu-txid-aqui
```

#### 3. Autorizar Cobrança Recorrente (`POST /recurring-charge/:txid/authorize`)

Autoriza uma cobrança recorrente para que ela possa ser paga.

**Exemplo com cURL:**

```bash
curl -X POST http://localhost:3000/recurring-charge/seu-txid-aqui/authorize
``` 