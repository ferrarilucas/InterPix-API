import express, { Request, Response, Router } from 'express';
import { z } from 'zod';
import { logger } from '../../shared/logger';
import { extractInterNotifications, processInterEvent } from '../../domain/webhookProcessor';

const interWebhookSchema = z
  .object({
    txid: z.string().max(140).optional(),
    idRec: z.string().max(140).optional(),
    eventId: z.string().max(140).optional(),
  })
  .passthrough();

export function interWebhookRoutes(): Router {
  const router = Router();

  router.use(express.text({ type: () => true, limit: '256kb' }));

  const handle = (req: Request, res: Response): void => {
    res.status(200).json({ received: true });

    req.log.info('webhook do inter recebido', {
      method: req.method,
      path: req.originalUrl,
      contentType: req.header('content-type') ?? null,
      userAgent: req.header('user-agent') ?? null,
      forwardedFor: req.header('x-forwarded-for') ?? null,
      body: req.body ?? null,
    });

    const parsed = interWebhookSchema.safeParse(req.body ?? {});

    if (!parsed.success) {
      req.log.warn('webhook do inter com corpo invalido, ignorado', {
        issues: parsed.error.issues.map((issue) => issue.message),
      });
      return;
    }

    const notifications = extractInterNotifications(parsed.data);

    if (notifications.length === 0) {
      req.log.warn('webhook do inter sem notificacao reconhecivel', {
        keys: Object.keys(parsed.data),
      });
      return;
    }

    for (const notification of notifications) {
      processInterEvent(notification, req.log).catch((error) => {
        req.log.error('falha ao processar webhook do inter', {
          idRec: notification.idRec ?? null,
          txid: notification.txid ?? null,
          message: (error as Error).message,
        });
      });
    }
  };

  router.post('/inter/rec', handle);
  router.post('/inter/cobr', handle);
  router.post('/inter', handle);

  return router;
}
