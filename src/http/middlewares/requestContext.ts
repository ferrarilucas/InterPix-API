import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { createRequestLogger, Logger } from '../../shared/logger';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      log: Logger;
    }
  }
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  req.requestId = requestId;
  req.log = createRequestLogger(requestId);
  res.setHeader('X-Request-Id', requestId);
  next();
}
