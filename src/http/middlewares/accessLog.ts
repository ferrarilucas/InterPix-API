import { NextFunction, Request, Response } from 'express';

export function accessLog(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/health') {
    next();
    return;
  }

  const startedAt = Date.now();

  res.on('finish', () => {
    req.log.info('requisicao concluida', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      userAgent: req.header('user-agent') ?? null,
      forwardedFor: req.header('x-forwarded-for') ?? null,
    });
  });

  next();
}
