import { createContext, useContext } from 'react';

export interface AuthContextValue {
  /** True once an API key has been accepted by the server. */
  isAuthenticated: boolean;
  /**
   * Validate `apiKey` against the API and, on success, keep it for this
   * browser session. Rejects with a user-presentable message otherwise.
   */
  signIn: (apiKey: string) => Promise<void>;
  signOut: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
