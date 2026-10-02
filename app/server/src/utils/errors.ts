/**
 * Application error hierarchy.
 *
 * Every operational error carries an HTTP status code so the centralized error
 * middleware can translate it into a clean response without leaking internals.
 * `isOperational` distinguishes expected errors (bad input, missing resource) from
 * unexpected programming/infra failures.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode = 500, isOperational = true) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

/** 400 — request failed validation. */
export class ValidationError extends AppError {
  constructor(message = 'Validation failed') {
    super(message, 400);
  }
}

/** 401 — request is not authenticated (missing/invalid credentials or token). */
export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401);
  }
}

/**
 * 403 — request is authenticated but not permitted (RBAC denial).
 *
 * Reserved for the case where the caller IS a workspace member but their role lacks the
 * required permission. A caller with no membership at all receives 404 instead, so the
 * existence of a tenant they cannot see is never leaked (see authorization.middleware).
 */
export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(message, 403);
  }
}

/** 404 — resource does not exist (or is not visible to this tenant). */
export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404);
  }
}

/** 409 — request conflicts with current state (e.g. duplicate email). */
export class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(message, 409);
  }
}
