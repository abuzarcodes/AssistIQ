'use client';

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react';
import { setToken, clearToken } from '@/lib/api-client';
import * as authApi from '@/lib/api/auth';
import type { PlatformRole, User } from '@/lib/api/auth';
import {
  hasPlatformPermission,
  type PlatformPermission,
} from '@/lib/permissions';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  /** Platform-domain role. Treats a missing value as 'USER' rather than unknown. */
  platformRole: PlatformRole;
  /** True only for PLATFORM_OWNER — the gate for the /platform area and AI Lab. */
  isPlatformOwner: boolean;
  /**
   * Whether the current user holds a *platform-domain* permission. Workspace
   * permissions are not answerable here: they depend on a membership the client does
   * not hold, and are enforced server-side.
   */
  hasPermission: (permission: PlatformPermission) => boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // Check existing token on mount
  useEffect(() => {
    const token = localStorage.getItem('assistiq_token');
    if (!token) {
      setLoading(false);
      return;
    }

    authApi
      .getMe()
      .then(setUser)
      .catch(() => {
        clearToken();
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await authApi.login(email, password);
    setToken(res.token);
    setUser(res.user);
  }, []);

  const register = useCallback(async (name: string, email: string, password: string) => {
    const res = await authApi.register(name, email, password);
    setToken(res.token);
    setUser(res.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      // ignore — clear locally regardless
    }
    clearToken();
    setUser(null);
  }, []);

  // Derived, not stored: the role lives on the user object returned by the API, so
  // there is nothing to keep in sync. A user who has not loaded yet is treated as a
  // plain USER, which fails safe — admin UI stays hidden until the role is known.
  const platformRole: PlatformRole = user?.platformRole ?? 'USER';
  const isPlatformOwner = platformRole === 'PLATFORM_OWNER';

  const hasPermission = useCallback(
    (permission: PlatformPermission) => hasPlatformPermission(platformRole, permission),
    [platformRole],
  );

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        platformRole,
        isPlatformOwner,
        hasPermission,
        login,
        register,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
