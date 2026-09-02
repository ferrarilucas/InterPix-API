export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static unauthorized(): AppError {
    return new AppError(401, 'UNAUTHORIZED', 'Credencial ausente ou invalida.');
  }

  static notFound(resource: string): AppError {
    return new AppError(404, 'NOT_FOUND', `${resource} nao encontrado.`);
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }

  static conflict(code: string, message: string): AppError {
    return new AppError(409, code, message);
  }

  static upstream(): AppError {
    return new AppError(502, 'UPSTREAM_ERROR', 'Falha na comunicacao com o provedor de pagamento.');
  }
}
