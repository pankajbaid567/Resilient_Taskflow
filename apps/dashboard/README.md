# TaskFlow Dashboard

React-based monitoring dashboard for the Resilient TaskFlow distributed task queue system.

## Features

- **Real-time Monitoring**: Auto-refreshing views with configurable polling intervals
- **Dashboard Overview**: Key metrics including active workers, job counts, success rates, and latency
- **Job Management**: Browse, filter, and manage jobs with detailed views
- **Worker Monitoring**: Track worker health, status, and performance metrics
- **Queue Statistics**: View queue depths, success rates, and priority breakdowns
- **Dead Letter Queue**: Manage failed jobs with requeue functionality
- **System Health**: Monitor database, Redis, and Kafka service status

## Tech Stack

- **React 18** with TypeScript
- **Vite** for fast development and optimized builds
- **React Router** for client-side routing
- **CSS Modules** for component-scoped styling
- **Type-safe API client** with automatic error handling

## Development

### Prerequisites

- Node.js 20+
- pnpm 8+

### Install Dependencies

```bash
pnpm install
```

### Environment Variables

Create a `.env` file in the dashboard directory:

```bash
VITE_API_URL=http://localhost:3000/api/v1
```

### Start Development Server

```bash
# From the dashboard directory
pnpm dev

# Or from the workspace root
pnpm dev:dashboard
```

The dashboard will be available at `http://localhost:3001`.

### Build for Production

```bash
pnpm build
```

Built files will be in the `dist/` directory.

### Preview Production Build

```bash
pnpm preview
```

## Docker Deployment

### Build Docker Image

```bash
docker build -t taskflow-dashboard -f apps/dashboard/Dockerfile .
```

### Run with Docker Compose

```bash
# Start all services including dashboard
docker-compose up -d

# Dashboard will be available at http://localhost:3001
```

### Environment Variables for Docker

Set in `docker-compose.yml` or `.env` file:

```yaml
environment:
  - VITE_API_URL=http://api:3000/api/v1
```

## Project Structure

```
apps/dashboard/
├── src/
│   ├── components/       # Reusable UI components
│   │   ├── ErrorMessage.tsx
│   │   ├── LoadingSpinner.tsx
│   │   ├── MetricCard.tsx
│   │   ├── Modal.tsx
│   │   ├── StatusBadge.tsx
│   │   ├── JobDetailModal.tsx
│   │   └── Layout.tsx
│   ├── pages/            # Route pages
│   │   ├── Dashboard.tsx
│   │   ├── Jobs.tsx
│   │   ├── Workers.tsx
│   │   ├── Queues.tsx
│   │   └── DeadLetterQueue.tsx
│   ├── hooks/            # Custom React hooks
│   │   └── useAPI.ts
│   ├── lib/              # Utilities and API client
│   │   ├── api-client.ts
│   │   └── utils.ts
│   ├── types/            # TypeScript type definitions
│   │   └── index.ts
│   ├── App.tsx           # Root component
│   ├── main.tsx          # Entry point
│   └── index.css         # Global styles
├── public/               # Static assets
├── Dockerfile            # Production Docker image
├── nginx.conf            # Nginx configuration for production
├── vite.config.ts        # Vite configuration
└── tsconfig.json         # TypeScript configuration
```

## API Integration

The dashboard communicates with the TaskFlow API through a type-safe client (`src/lib/api-client.ts`).

### Authentication

Set API key or JWT token:

```typescript
import { apiClient } from '@/lib/api-client';

// API Key authentication
apiClient.setAPIKey('your-api-key');

// Or JWT token
apiClient.setToken('your-jwt-token');
```

### Custom Hooks

```typescript
import { useJobs, useWorkers, useDashboardMetrics } from '@/hooks/useAPI';

// With auto-refresh every 5 seconds
const { data, loading, error, refetch } = useJobs(
  { status: 'queued' },
  { pollingInterval: 5000 }
);
```

## Polling Intervals

- **Dashboard**: 5s (metrics), 10s (health)
- **Workers**: 3s (fastest for real-time status)
- **Jobs**: 5s
- **Queues**: 5s
- **DLQ**: 10s

## Production Considerations

### Nginx Configuration

- Gzip compression enabled
- Static asset caching (1 year)
- Security headers configured
- API proxying with proper timeouts
- SPA fallback routing

### Performance

- Code splitting with React Router
- CSS modules for minimal CSS
- Optimized production build with Vite
- Lazy loading of modals and heavy components

### Security

- No sensitive data in client-side code
- API authentication via headers
- CORS handled by API server
- Security headers in nginx

## Troubleshooting

### Dashboard shows "Network Error"

- Ensure API server is running on `http://localhost:3000`
- Check `VITE_API_URL` environment variable
- Verify CORS is enabled on API server

### Real-time updates not working

- Check browser console for errors
- Verify API endpoints are responding
- Ensure polling intervals are set correctly

### Docker build fails

- Clear Docker cache: `docker system prune -a`
- Ensure pnpm lockfile is present
- Check Node.js version in Dockerfile

## License

MIT
