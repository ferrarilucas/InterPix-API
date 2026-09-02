import { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { config } from '../../shared/config';
import { AppError } from '../../shared/errors';

const expected = Buffer.from(config.apiToken);

function matches(received: string): boolean {
  const candidate = Buffer.from(received);
  if (candidate.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(candidate, expected);
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('authorization');

  if (!header || !header.startsWith('Bearer ')) {
    next(AppError.unauthorized());
    return;
  }

  if (!matches(header.slice('Bearer '.length))) {
    next(AppError.unauthorized());
    return;
  }

  next();
}
