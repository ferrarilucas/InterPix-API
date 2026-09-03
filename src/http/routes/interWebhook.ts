import { Request, Response, Router } from 'express';
import { logger } from '../../shared/logger';
import { processInterEvent } from '../../domain/webhookProcessor';

export function interWebhookRoutes(): Router {
  const router = Router();

  router.post('/inter', async (req: Request, res: Response) => {
    try {
      await processInterEvent(req.body ?? {});
    } catch (error) {
      logger.error('falha ao processar webhook do inter', {
        message: (error as Error).message,
      });
    }

    res.status(200).json({ received: true });
  });

  return router;
}
