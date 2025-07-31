import axios, { AxiosError } from 'axios';
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
});

export const api = axios.create({
  baseURL: 'https://cdpj.partners.bancointer.com.br',
  httpsAgent,
});

let accessToken: string | null = null;
let tokenExpiresAt: number | null = null;

async function getAccessToken(): Promise<string> {
  if (accessToken && tokenExpiresAt && tokenExpiresAt > Date.now()) {
    return accessToken;
  }

  const params = new URLSearchParams();
  params.append('client_id', INTER_CLIENT_ID || '');
  params.append('client_secret', INTER_CLIENT_SECRET || '');
  params.append('grant_type', 'client_credentials');
  params.append('scope', 'cob.read cob.write cobv.read cobv.write');

  try {
    const response = await api.post('/oauth/v2/token', params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    
    accessToken = response.data.access_token;
    tokenExpiresAt = Date.now() + (response.data.expires_in - 300) * 1000;
    
    if (!accessToken) {
        throw new Error("Access token not received from Banco Inter.");
    }

    return accessToken;
  } catch (error) {
    const err = error as AxiosError;
    console.error("Error getting access token:", err.response?.data || err.message);
    throw new Error("Could not get access token from Banco Inter.");
  }
}

api.interceptors.request.use(async (config) => {
    const token = await getAccessToken();
    config.headers.Authorization = `Bearer ${token}`;
    return config;
}); 