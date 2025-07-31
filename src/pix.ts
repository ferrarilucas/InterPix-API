import { AxiosError } from 'axios';
import 'dotenv/config';
import { api } from './shared/api';
import { PixCharge } from './types';

const { PIX_KEY } = process.env;

if (!PIX_KEY) {
  throw new Error('PIX_KEY environment variable not set in .env file');
}

export async function createCharge(txid: string, value: number): Promise<PixCharge> {
  const data = {
    calendario: {
      expiracao: 3600, // 1 hour
    },
    valor: {
      original: value.toFixed(2),
    },
    chave: PIX_KEY,
    solicitacaoPagador: 'Service/product payment',
  };

  try {
    const response = await api.put(`/pix/v2/cob/${txid}`, data, {
      headers: {
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  } catch (error) {
    const err = error as AxiosError;
    console.error("Error creating charge:", err.response?.data || err.message);
    throw new Error("Could not create PIX charge.");
  }
}

export async function getCharge(txid: string): Promise<PixCharge> {
  try {
    const response = await api.get(`/pix/v2/cob/${txid}`);
    return response.data;
  } catch (error) {
    const err = error as AxiosError;
    console.error("Error querying charge:", err.response?.data || err.message);
    throw new Error("Could not query PIX charge.");
  }
}