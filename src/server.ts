import express, { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createCharge, getCharge, getReceivedPixByTxid } from './pix';
import axios from 'axios';
import cron from 'node-cron';
import { insertTransaction, listRecentIncompleteTransactions, markTransactionCompleted, updateTransactionTaxId, updateTransactionStatus } from './repositories/transactions';
import { TransactionStatus } from './types/transactions';
import { authorizeRecurringCharge, createRecurringCharge, getRecurringCharge } from './recurringPix';
import { 
  CreateChargeRequest, 
  CreateRecurringChargePublicRequest,
  mapPublicToInterRecurringCharge,
  mapInterToPublicCharge,
  mapInterToPublicRecurringCharge,
  mapInterToPublicAuthorizeResponse
} from './types';

const app = express();
app.use(express.json());

const PORT = 3000;

app.post('/charge', async (req: Request<{}, any, CreateChargeRequest>, res: Response) => {
  const { value, internalId, callbackUrl, taxId } = req.body;

  if (!value || typeof value !== 'number') {
    return res.status(400).json({ error: 'The "value" field is required and must be a number.' });
  }
  if (!internalId || typeof internalId !== 'string') {
    return res.status(400).json({ error: 'The "internalId" field is required and must be a string.' });
  }

  const txid = uuidv4().replace(/-/g, ''); 

  try {
    const interCharge = await createCharge(txid, value);
    const publicCharge = mapInterToPublicCharge(interCharge);
    try {
      await insertTransaction({
        txid,
        internalId,
        taxId,
        status: publicCharge.status as TransactionStatus,
        callbackUrl,
        amount: publicCharge.value.original,
        pixCopyPaste: publicCharge.pixCopyPaste,
      });
    } catch (dbError) {
      console.error('Error persisting transaction:', dbError);
    }
    res.status(201).json(publicCharge);
  } catch (error) {
    if (error instanceof Error) {
        res.status(500).json({ error: error.message });
    } else {
        res.status(500).json({ error: 'An unknown error occurred.' });
    }
  }
});

app.get('/charge/:txid', async (req: Request, res: Response) => {
  const { txid } = req.params;

  try {
    const interCharge = await getCharge(txid);
    const publicCharge = mapInterToPublicCharge(interCharge);
    res.status(200).json(publicCharge);
  } catch (error) {
    if (error instanceof Error) {
        res.status(500).json({ error: error.message });
    } else {
        res.status(500).json({ error: 'An unknown error occurred.' });
    }
  }
});

app.post('/recurring-charge', async (req: Request<{}, any, CreateRecurringChargePublicRequest>, res: Response) => {
  try {
    const interRequest = mapPublicToInterRecurringCharge(req.body);
    const interCharge = await createRecurringCharge(interRequest);
    const publicCharge = mapInterToPublicRecurringCharge(interCharge);
    res.status(201).json(publicCharge);
  } catch (error) {
    const err = error as Error
    res.status(500).json({ error: err.message });
  }
});

app.get('/recurring-charge/:txid', async (req: Request, res: Response) => {
  try {
    const { txid } = req.params;
    const interCharge = await getRecurringCharge(txid);
    const publicCharge = mapInterToPublicRecurringCharge(interCharge);
    res.json(publicCharge);
  } catch (error) {
    const err = error as Error
    res.status(500).json({ error: err.message });
  }
});

app.post('/recurring-charge/:txid/authorize', async (req: Request, res: Response) => {
  try {
    const { txid } = req.params;
    const interResponse = await authorizeRecurringCharge(txid);
    const publicResponse = mapInterToPublicAuthorizeResponse(interResponse);
    res.json(publicResponse);
  } catch (error) {
    const err = error as Error
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`PIX server with Inter API running at http://localhost:${PORT}`);
});

cron.schedule('*/30 * * * * *', async () => {
  try {
    const since = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const pending = await listRecentIncompleteTransactions(since);
    if (!pending.length) return;
    for (const tx of pending) {
      try {
        const interCharge = await getCharge(tx.txid);
        const status = mapInterToPublicCharge(interCharge).status;
        if (status !== tx.status) {
          if (status === 'COMPLETED') {
            let resolvedTaxId: string | undefined = tx.taxId;
            try {
              const fim = new Date().toISOString();
              const inicio = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
              const received = await getReceivedPixByTxid(tx.txid, inicio, fim);
              const item = received.pix?.[0];
              const fetchedTaxId = item?.pagador?.cpf || item?.pagador?.cnpj;
              if (fetchedTaxId) {
                resolvedTaxId = fetchedTaxId;
                await updateTransactionTaxId(tx.txid, fetchedTaxId);
              }
            } catch (rxErr) {
              console.error('Error fetching received PIX by txid:', rxErr);
            }
            await markTransactionCompleted(tx.txid);
            if (tx.callbackUrl) {
              try {
                await axios.post(tx.callbackUrl, {
                  status,
                  taxId: resolvedTaxId,
                  internalId: tx.internalId,
                }, { timeout: 5000 });
              } catch (cbErr) {
                console.error('Callback error:', cbErr);
              }
            }
          } else {
            try {
              await updateTransactionStatus(tx.txid, status as TransactionStatus);
            } catch (_e) {}
          }
        }
      } catch (err) {
        console.error('Polling error for tx', tx.txid, err);
      }
    }
  } catch (err) {
    console.error('Cron job error:', err);
  }
});