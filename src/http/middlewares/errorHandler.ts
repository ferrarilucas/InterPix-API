import { NextFunction, Request, Response } from 'express';
import { AppError } from '../../shared/errors';
import { logger } from '../../shared/logger';

export function notFoundHandler(_req: Request, _res: Response, next: NextFunction): void {
  next(AppError.notFound('Recurso'));
}

export function errorHandler(
  error: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const log = req.log ?? logger;

  if (error instanceof SyntaxError && 'body' in error) {
    log.warn('corpo json invalido');
    res.status(400).json({ code: 'BAD_REQUEST', message: 'Corpo da requisicao nao e um JSON valido.' });
    return;
  }

  if (error instanceof AppError) {
    if (error.status >= 500) {
      log.error('erro tratado', { code: error.code, message: error.message });
    } else {
      log.warn('requisicao recusada', { code: error.code, message: error.message });
    }
    res.status(error.status).json({
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }

  log.error('erro nao tratado', { message: error.message, stack: error.stack });
  res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Erro interno.' });
}
