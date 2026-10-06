const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api/v1';

export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('assistiq_token');
}

type ForbiddenListener = (error: ApiError) => void;

const forbiddenListeners = new Set<ForbiddenListener>();

/**
 * Subscribe to 403 responses. This module is plain TypeScript with no React dependency,
 * so it cannot show a toast itself; `ApiErrorBridge` subscribes on mount and renders one.
 *
 * A 403 means "authenticated, but not allowed" — it must never clear the token or bounce
 * the user to the login screen, which would drop a valid session over a permission the
 * user simply does not hold. Only 401 (see below) does that.
 */
export function onForbidden(listener: ForbiddenListener): () => void {
  forbiddenListeners.add(listener);
  return () => {
    forbiddenListeners.delete(listener);
  };
}

function notifyForbidden(error: ApiError): void {
  forbiddenListeners.forEach((listener) => listener(error));
}

/**
 * Turn a failed response into an ApiError, applying the session rules in one place so
 * the JSON and FormData paths cannot drift apart:
 *
 * - **401** — the session is no longer valid: clear the token and go to login.
 * - **403** — the session is fine but the caller lacks permission: keep the token, stay
 *   put, and notify listeners so the user gets an explanation instead of a logout.
 */
function throwApiError(status: number, body: ApiResponse<unknown>): never {
  const error = new ApiError(
    body.error || body.message || `Request failed with status ${status}`,
    status,
    body,
  );

  if (status === 401) {
    clearToken();
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
  } else if (status === 403) {
    notifyForbidden(error);
  }

  throw error;
}

export function setToken(token: string): void {
  localStorage.setItem('assistiq_token', token);
}

export function clearToken(): void {
  localStorage.removeItem('assistiq_token');
}

export async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  // Handle 204 No Content
  if (res.status === 204) {
    return {} as T;
  }

  let body: ApiResponse<T>;
  try {
    body = await res.json();
  } catch {
    throw new ApiError('Failed to parse server response', res.status);
  }

  if (!res.ok || body.success === false) {
    throwApiError(res.status, body);
  }

  return body.data as T;
}

export function apiGet<T>(endpoint: string): Promise<T> {
  return apiRequest<T>(endpoint, { method: 'GET' });
}

export function apiPost<T>(endpoint: string, data?: unknown): Promise<T> {
  return apiRequest<T>(endpoint, {
    method: 'POST',
    body: data ? JSON.stringify(data) : undefined,
  });
}

export function apiPatch<T>(endpoint: string, data: unknown): Promise<T> {
  return apiRequest<T>(endpoint, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export function apiDelete<T>(endpoint: string): Promise<T> {
  return apiRequest<T>(endpoint, { method: 'DELETE' });
}

/**
 * GET a binary resource (the bot avatar) as a `Blob`.
 *
 * `apiRequest` always parses JSON, and the avatar endpoint is deliberately **not** an
 * envelope — it returns the image bytes. It is also authenticated, so an `<img src>` cannot
 * be used: the browser will not attach the bearer token. The caller therefore fetches the
 * blob here and renders it through an object URL.
 */
export async function apiGetBlob(endpoint: string): Promise<Blob> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${endpoint}`, { headers });

  if (!res.ok) {
    // Best-effort envelope so a 401/403 still clears the session or notifies listeners.
    let body: ApiResponse<unknown> = { success: false };
    try {
      body = (await res.json()) as ApiResponse<unknown>;
    } catch {
      // A binary error body carries nothing usable; the status is the message.
    }
    throwApiError(res.status, body);
  }

  return res.blob();
}

/**
 * POST FormData to the API (for file uploads).
 * Does NOT set Content-Type — the browser auto-generates the multipart boundary.
 */
export async function apiPostFormData<T>(
  endpoint: string,
  formData: FormData,
): Promise<T> {
  const token = getToken();

  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (res.status === 204) {
    return {} as T;
  }

  let body: ApiResponse<T>;
  try {
    body = await res.json();
  } catch {
    throw new ApiError('Failed to parse server response', res.status);
  }

  if (!res.ok || body.success === false) {
    throwApiError(res.status, body);
  }

  return body.data as T;
}
