import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
} from 'react-router-dom';
import AuthProvider from './auth/AuthProvider';
import { useAuth } from './auth/auth-context';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Jobs from './pages/Jobs';
import Workers from './pages/Workers';
import Queues from './pages/Queues';
import DeadLetterQueue from './pages/DeadLetterQueue';
import SignIn from './pages/SignIn';

function Shell() {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) return <SignIn />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/workers" element={<Workers />} />
        <Route path="/queues" element={<Queues />} />
        <Route path="/dlq" element={<DeadLetterQueue />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Layout>
  );
}

function App() {
  return (
    <AuthProvider>
      <Router>
        <Shell />
      </Router>
    </AuthProvider>
  );
}

export default App;
