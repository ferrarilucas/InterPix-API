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
  INTER_WEBHOOK_BASE_URL: z
    .string()
    .url()
    .refine((value) => value.startsWith('https://'), {
      message: 'o Inter so aceita webhook em https',
    }),
  INTER_RECEBEDOR_NOME: z.string().min(1),
  INTER_RECEBEDOR_CNPJ: z.string().regex(/^\d{14}$/, 'deve ter exatamente 14 digitos'),
  INTER_RECEBEDOR_AGENCIA: z.string().min(1),
  INTER_RECEBEDOR_CONTA: z.string().min(1),
  INTER_RECEBEDOR_TIPO_CONTA: z.enum(['CORRENTE', 'POUPANCA', 'PAGAMENTO']),
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
  interWebhookBaseUrl: string;
  interRecebedorNome: string;
  interRecebedorCnpj: string;
  interRecebedorAgencia: string;
  interRecebedorConta: string;
  interRecebedorTipoConta: string;
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
    interWebhookBaseUrl: value.INTER_WEBHOOK_BASE_URL,
    interRecebedorNome: value.INTER_RECEBEDOR_NOME,
    interRecebedorCnpj: value.INTER_RECEBEDOR_CNPJ,
    interRecebedorAgencia: value.INTER_RECEBEDOR_AGENCIA,
    interRecebedorConta: value.INTER_RECEBEDOR_CONTA,
    interRecebedorTipoConta: value.INTER_RECEBEDOR_TIPO_CONTA,
    chargeLeadDays: value.CHARGE_LEAD_DAYS,
    dunningWindowDays: value.DUNNING_WINDOW_DAYS,
    port: value.PORT,
  });
}

export const config = loadConfig(process.env);
