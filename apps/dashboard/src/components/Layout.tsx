import { Link, useLocation } from 'react-router-dom';
import styles from './Layout.module.css';

interface LayoutProps {
  children: React.ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const location = useLocation();

  const navItems = [
    { path: '/dashboard', label: 'Dashboard', icon: '📊' },
    { path: '/jobs', label: 'Jobs', icon: '📋' },
    { path: '/workers', label: 'Workers', icon: '👷' },
    { path: '/queues', label: 'Queues', icon: '📦' },
    { path: '/dlq', label: 'Dead Letter Queue', icon: '💀' },
  ];

  return (
    <div className={styles.container}>
      <nav className={styles.sidebar}>
        <div className={styles.logo}>
          <h1>TaskFlow</h1>
          <p>Dashboard</p>
        </div>
        <ul className={styles.nav}>
          {navItems.map((item) => (
            <li key={item.path}>
              <Link
                to={item.path}
                className={location.pathname === item.path ? styles.active : ''}
              >
                <span className={styles.icon}>{item.icon}</span>
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <main className={styles.main}>
        <div className={styles.content}>{children}</div>
      </main>
    </div>
  );
}
