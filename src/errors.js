export class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(code, message, details) {
  return new AppError(400, code, message, details);
}
export function unauthenticated(message = 'Authentication required') {
  return new AppError(401, 'UNAUTHENTICATED', message);
}
export function forbidden(message = 'Forbidden') {
  return new AppError(403, 'FORBIDDEN', message);
}
export function notFound(message = 'Not found') {
  return new AppError(404, 'NOT_FOUND', message);
}
export function conflict(code, message, details) {
  return new AppError(409, code, message, details);
}
export function rateLimited(retryAfterSeconds = 60) {
  return new AppError(429, 'RATE_LIMITED', 'Too many requests', { retryAfterSeconds });
}
