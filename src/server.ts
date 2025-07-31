import express, { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createCharge, getCharge } from './pix';
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
  const { value } = req.body;

  if (!value || typeof value !== 'number') {
    return res.status(400).json({ error: 'The "value" field is required and must be a number.' });
  }

  const txid = uuidv4().replace(/-/g, ''); 

  try {
    const interCharge = await createCharge(txid, value);
    const publicCharge = mapInterToPublicCharge(interCharge);
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