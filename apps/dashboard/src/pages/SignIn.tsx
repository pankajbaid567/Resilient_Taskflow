import { useId, useState } from 'react';
import { useAuth } from '@/auth/auth-context';
import styles from './SignIn.module.css';

export default function SignIn() {
  const { signIn } = useAuth();
  const inputId = useId();
  const errorId = useId();
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await signIn(apiKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.page}>
      <form
        className={styles.card}
        onSubmit={(event) => void handleSubmit(event)}
      >
        <h1 className={styles.title}>TaskFlow</h1>
        <p className={styles.subtitle}>Sign in with an API key</p>

        <label className={styles.label} htmlFor={inputId}>
          API key
        </label>
        <input
          id={inputId}
          className={styles.input}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          disabled={submitting}
          autoFocus
        />

        {error && (
          <p id={errorId} className={styles.error} role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          className={styles.submit}
          disabled={submitting || apiKey.trim() === ''}
        >
          {submitting ? 'Checking…' : 'Sign in'}
        </button>

        <p className={styles.hint}>
          Create one with <code>pnpm db:create-api-key</code>. The key stays in
          this browser tab only and is cleared when you close it.
        </p>
      </form>
    </div>
  );
}
