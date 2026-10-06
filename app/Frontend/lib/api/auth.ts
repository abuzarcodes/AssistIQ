import { apiPost, apiGet } from '@/lib/api-client';

export type PlatformRole = 'USER' | 'PLATFORM_OWNER';

export interface User {
  id: string;
  name: string;
  email: string;
  /**
   * Platform-domain role, independent of any workspace role. Optional because older
   * responses/tokens may not carry it — callers must treat a missing value as 'USER'.
   */
  platformRole?: PlatformRole;
}

export interface AuthResponse {
  user: User;
  token: string;
}

export function login(email: string, password: string) {
  return apiPost<AuthResponse>('/auth/login', { email, password });
}

export function register(name: string, email: string, password: string) {
  return apiPost<AuthResponse>('/auth/register', { name, email, password });
}

export function logout() {
  return apiPost<{ message: string }>('/auth/logout');
}

export function getMe() {
  return apiGet<User>('/users/me');
}
