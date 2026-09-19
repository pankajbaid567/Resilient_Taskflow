import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
} from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Jobs from './pages/Jobs';
import Workers from './pages/Workers';
import Queues from './pages/Queues';
import DeadLetterQueue from './pages/DeadLetterQueue';

function App() {
  return (
    <Router>
      <Layout>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/workers" element={<Workers />} />
          <Route path="/queues" element={<Queues />} />
          <Route path="/dlq" element={<DeadLetterQueue />} />
        </Routes>
      </Layout>
    </Router>
  );
}

export default App;
