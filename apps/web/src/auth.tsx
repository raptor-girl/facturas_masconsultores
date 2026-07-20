import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { AuthResponse, PublicUser } from '@factuflow/shared-schemas';
import { api, ApiError } from './api.js';

interface AuthContextValue {
  user: PublicUser | null;
  loading: boolean;
  login: (identifier: string, password: string) => Promise<PublicUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const response = await api<AuthResponse>('/auth/me');
      setUser(response.user);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      setUser(null);
    }
  }, []);

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    const unauthenticated = () => setUser(null);
    window.addEventListener('factuflow:unauthorized', unauthenticated);
    return () => window.removeEventListener('factuflow:unauthorized', unauthenticated);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      login: async (identifier, password) => {
        const response = await api<AuthResponse>('/auth/login', {
          method: 'POST',
          body: JSON.stringify({ identifier, password }),
        });
        setUser(response.user);
        return response.user;
      },
      logout: async () => {
        try {
          await api<{ ok: true }>('/auth/logout', { method: 'POST' });
        } finally {
          setUser(null);
        }
      },
      refresh,
    }),
    [loading, refresh, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth debe utilizarse dentro de AuthProvider');
  return value;
}
