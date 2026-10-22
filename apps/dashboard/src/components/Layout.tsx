import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '@/auth/auth-context';
import styles from './Layout.module.css';

interface LayoutProps {
  children: React.ReactNode;
}

const NAV_ITEMS = [
  { path: '/dashboard', label: 'Dashboard', icon: '📊' },
  { path: '/jobs', label: 'Jobs', icon: '📋' },
  { path: '/workers', label: 'Workers', icon: '👷' },
  { path: '/queues', label: 'Queues', icon: '📦' },
  { path: '/dlq', label: 'Dead Letter Queue', icon: '💀' },
];

export default function Layout({ children }: LayoutProps) {
  const location = useLocation();
  const { signOut } = useAuth();

  return (
    <div className={styles.container}>
      <nav className={styles.sidebar} aria-label="Main">
        <div className={styles.logo}>
          <h1>TaskFlow</h1>
          <p>Dashboard</p>
        </div>
        <ul className={styles.nav}>
          {NAV_ITEMS.map((item) => {
            const active = location.pathname === item.path;
            return (
              <li key={item.path}>
                <Link
                  to={item.path}
                  className={active ? styles.active : ''}
                  aria-current={active ? 'page' : undefined}
                >
                  <span className={styles.icon} aria-hidden="true">
                    {item.icon}
                  </span>
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
        <button type="button" className={styles.signOut} onClick={signOut}>
          Sign out
        </button>
      </nav>
      <main className={styles.main}>
        <div className={styles.content}>{children}</div>
      </main>
    </div>
  );
}
