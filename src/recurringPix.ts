import { AxiosError } from 'axios';
import 'dotenv/config';
import { api } from './shared/api';
import { CreateRecurringChargeRequest, RecurringPixCharge, AuthorizeRecurringChargeResponse } from './types';

export async function createRecurringCharge(data: CreateRecurringChargeRequest): Promise<RecurringPixCharge> {
  try {
    const response = await api.post(`/pix/v2/cobv`, data, {
      headers: {
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  } catch (error) {
    const err = error as AxiosError;
    console.error("Error creating recurring charge:", err.response?.data || err.message);
    throw new Error("Could not create recurring PIX charge.");
  }
}

export async function getRecurringCharge(txid: string): Promise<RecurringPixCharge> {
    try {
      const response = await api.get(`/pix/v2/cobv/${txid}`);
      return response.data;
    } catch (error) {
      const err = error as AxiosError;
      console.error("Error querying recurring charge:", err.response?.data || err.message);
      throw new Error("Could not query recurring PIX charge.");
    }
  }

export async function authorizeRecurringCharge(txid: string): Promise<AuthorizeRecurringChargeResponse> {
    const data = {
        "txid": txid
    }
    try {
        const response = await api.post(`/pix/v2/cobv/${txid}/autorizar`, data, {
            headers: {
                'Content-Type': 'application/json',
            },
        });
        return response.data;
    } catch (error) {
        const err = error as AxiosError;
        console.error("Error authorizing recurring charge:", err.response?.data || err.message);
        throw new Error("Could not authorize recurring PIX charge.");
    }
} 