import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { logger } from '../../shared/logger';
import { processInterEvent } from '../../domain/webhookProcessor';

const interWebhookSchema = z
  .object({
    txid: z.string().max(140).optional(),
    idRec: z.string().max(140).optional(),
    eventId: z.string().max(140).optional(),
  })
  .passthrough();

export function interWebhookRoutes(): Router {
  const router = Router();

  router.post('/inter', (req: Request, res: Response) => {
    res.status(200).json({ received: true });

    const parsed = interWebhookSchema.safeParse(req.body ?? {});

    if (!parsed.success) {
      logger.warn('webhook do inter com corpo invalido, ignorado');
      return;
    }

    processInterEvent(parsed.data).catch((error) => {
      logger.error('falha ao processar webhook do inter', {
        message: (error as Error).message,
      });
    });
  });

  return router;
}
