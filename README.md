# InterPix API

![Node.js](https://img.shields.io/badge/Node.js-18.x-blue?style=for-the-badge&logo=node.js)
![Express.js](https://img.shields.io/badge/Express.js-4.x-green?style=for-the-badge&logo=express)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?style=for-the-badge&logo=typescript)

API facilitada para integração com o sistema de pagamentos PIX do Banco Inter, permitindo a criação e consulta de cobranças imediatas e recorrentes.

## Funcionalidades

- Criação de cobranças PIX imediatas (`/charge`).
- Consulta de cobranças PIX existentes (`/charge/:txid`).
- Criação de cobranças PIX recorrentes (`/recurring-charge`).
- Consulta de cobranças recorrentes (`/recurring-charge/:txid`).
- Autorização de cobranças recorrentes (`/recurring-charge/:txid/authorize`).
- Geração de QR Code e linha digitável (copia e cola).

## Arquitetura

O projeto foi estruturado de forma modular para facilitar a manutenção e evitar duplicação de código:

- **`src/server.ts`**: Servidor Express com as rotas da API
- **`src/shared/api.ts`**: Módulo compartilhado com configuração da API do Banco Inter e autenticação centralizada
- **`src/inter-pix.ts`**: Funções para cobranças PIX imediatas
- **`src/recorrencia-pix.ts`**: Funções para cobranças PIX recorrentes

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

    # Chave PIX que será usada para gerar as cobranças
    PIX_KEY=sua-chave-pix
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

## Desenvolvimento

### Estrutura de Pastas

```
src/
├── shared/
│   └── api.ts          # Configuração compartilhada da API do Banco Inter
├── types/
│   ├── index.ts        # Exportações centralizadas dos tipos
│   ├── api-requests.ts # Interfaces da API pública (inglês)
│   ├── inter-api.ts    # Interfaces da API do Banco Inter (português)
│   └── mappers.ts      # Funções de mapeamento entre formatos
├── inter-pix.ts        # Funções para cobranças imediatas
├── recorrencia-pix.ts  # Funções para cobranças recorrentes
└── server.ts           # Servidor Express e rotas
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

## API Endpoints

A seguir estão os detalhes dos endpoints disponíveis na API.

### Cobrança Imediata

#### 1. Criar Cobrança (`POST /charge`)

Cria uma nova cobrança PIX com um valor específico.

**Request Body:**

```json
{
  "value": 10.50
}
```

**Exemplo com cURL:**

```bash
curl -X POST http://localhost:3000/charge \
-H "Content-Type: application/json" \
-d '{
  "value": 10.50
}'
```

**Response (201 Created):**
Retorna o objeto completo da cobrança criada, incluindo o `txid` e o payload para o QR Code.

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