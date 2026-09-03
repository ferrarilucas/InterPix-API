import { Request, Response, Router } from 'express';
import { logger } from '../../shared/logger';
import { processInterEvent } from '../../domain/webhookProcessor';

export function interWebhookRoutes(): Router {
  const router = Router();

  router.post('/inter', (req: Request, res: Response) => {
    res.status(200).json({ received: true });

    processInterEvent(req.body ?? {}).catch((error) => {
      logger.error('falha ao processar webhook do inter', {
        message: (error as Error).message,
      });
    });
  });

  return router;
}
