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
  /**
   * Optional structured payload for the error response.
   *
   * Exists for the one case where a message string cannot carry the answer: a batch upload
   * in which every file was rejected returns **400 with the per-file reasons**, and those
   * belong in a `results` array so the client parses one shape rather than a prose summary
   * (§12.6). Set it only with data that is safe to show the caller — it is serialized
   * straight into the response body.
   */
  public readonly details?: unknown;

  constructor(message: string, statusCode = 500, isOperational = true, details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.details = details;
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

/**
 * 502 — a call to the AI service could not be completed.
 *
 * The HTTP status is always 502, because that is what happened: a dependency failed. What
 * this class adds is *why*, kept apart from the status because the two answer different
 * questions and only the status belongs in the response envelope.
 *
 * The distinction matters at the call sites. An upstream **404** means the thing is
 * already gone, and the right response is to proceed rather than to fail — deleting a
 * chunk whose vector has vanished should delete the row, not report an error the user
 * cannot act on. An upstream **400** means the AI service rejected *our* request: a
 * malformed PDF, a document with no extractable text. Its message is the only thing that
 * tells the user what to fix, and without it a malformed file is reported as "the AI
 * service is currently unavailable" — which sends someone to check on a service that is
 * running perfectly well.
 *
 * `upstreamDetail` is therefore carried verbatim but never used blindly: it is only shown
 * when the upstream itself said the request was at fault. A 5xx keeps the generic message,
 * because a dependency's internal error text is not the customer's business.
 */
export class AIServiceError extends AppError {
  /** The status the AI service returned, when it answered at all (absent on a timeout). */
  public readonly upstreamStatus?: number;
  /** The `detail` the AI service returned, when it supplied one. */
  public readonly upstreamDetail?: string;

  constructor(message: string, upstream: { status?: number; detail?: string } = {}) {
    super(message, 502);
    this.upstreamStatus = upstream.status;
    this.upstreamDetail = upstream.detail;
  }

  /** The AI service says the request itself was wrong, not that it failed to serve it. */
  public get isCallerFault(): boolean {
    return this.upstreamStatus !== undefined
      && this.upstreamStatus >= 400
      && this.upstreamStatus < 500;
  }

  /** The reason to record or display: the upstream's own words when it explained itself. */
  public get reason(): string {
    return this.isCallerFault && this.upstreamDetail ? this.upstreamDetail : this.message;
  }
}
