import express, { Express, Request, Response } from 'express';
import { requestContext } from './middlewares/requestContext';
import { requireAuth } from './middlewares/auth';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler';

export function createApp(): Express {
  const app = express();

  app.use(express.json({ limit: '256kb' }));
  app.use(requestContext);

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use(requireAuth);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
