import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient, APIError } from '@/lib/api-client';
import { AuthContext, type AuthContextValue } from './auth-context';

/**
 * The key lives in sessionStorage only: it is cleared when the tab closes and
 * is never compiled into the bundle (a VITE_* variable would be public).
 */
const STORAGE_KEY = 'taskflow.apiKey';

function readStoredKey(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // storage blocked: behave as signed out
  }
}

function storeKey(key: string | null): void {
  try {
    if (key === null) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, key);
  } catch {
    // Sign-in still works for this page load; it just will not survive reload.
  }
}

interface AuthProviderProps {
  children: React.ReactNode;
}

export default function AuthProvider({ children }: AuthProviderProps) {
  // Restore synchronously so the first render already sends credentials.
  const [isAuthenticated, setAuthenticated] = useState<boolean>(() => {
    const stored = readStoredKey();
    apiClient.setAPIKey(stored ?? undefined);
    return stored !== null;
  });

  const signOut = useCallback((): void => {
    apiClient.setAPIKey(undefined);
    storeKey(null);
    setAuthenticated(false);
  }, []);

  // The server rejecting a stored key (revoked, expired) returns to sign-in.
  useEffect(() => {
    apiClient.setUnauthorizedHandler(signOut);
    return () => apiClient.setUnauthorizedHandler(undefined);
  }, [signOut]);

  const signIn = useCallback(async (apiKey: string): Promise<void> => {
    const trimmed = apiKey.trim();
    if (!trimmed) throw new Error('Enter an API key.');

    apiClient.setAPIKey(trimmed);
    try {
      // Cheapest authenticated read available to every role.
      await apiClient.listQueues();
    } catch (error) {
      apiClient.setAPIKey(undefined);
      if (error instanceof APIError && error.statusCode === 401) {
        throw new Error('That API key was not accepted.');
      }
      if (error instanceof APIError && error.statusCode === 0) {
        throw new Error('Cannot reach the API. Is it running?');
      }
      throw error instanceof Error ? error : new Error('Sign-in failed.');
    }

    storeKey(trimmed);
    setAuthenticated(true);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ isAuthenticated, signIn, signOut }),
    [isAuthenticated, signIn, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
