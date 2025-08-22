import axios, { AxiosError, AxiosHeaders } from 'axios';
import https from 'https';
import fs from 'fs';
import 'dotenv/config';

const { INTER_CERT_PATH, INTER_KEY_PATH, INTER_CLIENT_ID, INTER_CLIENT_SECRET } = process.env;

if (!INTER_CERT_PATH || !INTER_KEY_PATH || !INTER_CLIENT_ID || !INTER_CLIENT_SECRET) {
  throw new Error('Environment variables for Inter integration have not been set in the .env file');
}

const httpsAgent = new https.Agent({
  cert: fs.readFileSync(INTER_CERT_PATH),
  key: fs.readFileSync(INTER_KEY_PATH),
  keepAlive: true,
  maxSockets: 25,
  maxTotalSockets: 50,
  maxFreeSockets: 10,
  timeout: 60_000,
  maxCachedSessions: 0,
});

const baseURL = 'https://cdpj.partners.bancointer.com.br';

const authApi = axios.create({
  baseURL,
  httpsAgent,
  timeout: 15_000,
  maxContentLength: 1 * 1024 * 1024,
  maxBodyLength: 1 * 1024 * 1024,
  maxRedirects: 3,
});

export const api = axios.create({
  baseURL,
  httpsAgent,
  timeout: 20_000,
  maxContentLength: 2 * 1024 * 1024,
  maxBodyLength: 2 * 1024 * 1024,
  maxRedirects: 3,
});

let accessToken: string | null = null;
let tokenExpiresAt: number | null = null;
let pendingTokenPromise: Promise<string> | null = null;

async function getAccessToken(): Promise<string> {
  if (accessToken && tokenExpiresAt && tokenExpiresAt > Date.now()) {
    return accessToken;
  }

  if (pendingTokenPromise) {
    return pendingTokenPromise;
  }

  const params = new URLSearchParams();
  params.append('client_id', INTER_CLIENT_ID || '');
  params.append('client_secret', INTER_CLIENT_SECRET || '');
  params.append('grant_type', 'client_credentials');
  params.append('scope', 'cob.read cob.write cobv.read cobv.write pix.read');

  pendingTokenPromise = (async () => {
    try {
      const response = await authApi.post('/oauth/v2/token', params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        maxContentLength: 64 * 1024,
        maxBodyLength: 64 * 1024,
      });

      const token = response.data?.access_token as string | undefined;
      const expiresIn = response.data?.expires_in as number | undefined;
      if (!token || !expiresIn) {
        throw new Error('Access token not received from Banco Inter.');
      }

      accessToken = token;
      tokenExpiresAt = Date.now() + (expiresIn - 300) * 1000;
      return token;
    } catch (error) {
      const err = error as AxiosError;
      console.error('Error getting access token:', err.response?.data || err.message);
      throw new Error('Could not get access token from Banco Inter.');
    } finally {
      pendingTokenPromise = null;
    }
  })();

  return pendingTokenPromise;
}

api.interceptors.request.use(async (config) => {
  const url = typeof config.url === 'string' ? config.url : '';
  const isOAuthRequest = url.includes('/oauth/');
  if (!isOAuthRequest) {
    const token = await getAccessToken();
    const headers = AxiosHeaders.from(config.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    config.headers = headers;
  }
  return config;
});