# Docker Production Deployment Guide

Complete guide for deploying Resilient TaskFlow using Docker in production environments.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Prerequisites](#prerequisites)
- [Security Hardening](#security-hardening)
- [Resource Planning](#resource-planning)
- [Deployment Steps](#deployment-steps)
- [Monitoring](#monitoring)
- [Backup and Recovery](#backup-and-recovery)
- [Scaling](#scaling)
- [Troubleshooting](#troubleshooting)

## Architecture Overview

The production Docker setup includes:

- **API Servers**: 2+ replicas with load balancing
- **Worker Pool**: 3+ replicas processing jobs
- **PostgreSQL**: Primary database with persistent storage
- **Redis**: Cache and queue backend
- **Redpanda**: Kafka-compatible event streaming
- **Dashboard**: React UI served via nginx
- **Prometheus**: Metrics collection
- **Grafana**: Metrics visualization

All services run as non-root users with resource limits and health checks.

## Prerequisites

### System Requirements

**Minimum** (Development/Testing):

- 4 CPU cores
- 8 GB RAM
- 50 GB disk space
- Docker 20.10+
- Docker Compose 2.0+

**Recommended** (Production):

- 8+ CPU cores
- 16+ GB RAM
- 200+ GB SSD storage
- Docker 24.0+
- Docker Compose 2.20+

### Software Requirements

```bash
# Install Docker
curl -fsSL https://get.docker.com | sh

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Verify installation
docker --version
docker-compose --version
```

## Security Hardening

### 1. Non-Root Containers

All services run as non-root users:

- **API/Worker**: `nodejs:1001`
- **Dashboard**: `nginx:101`
- **Database**: `postgres:999`

### 2. Read-Only Filesystems

Services use read-only root filesystems with tmpfs for writable directories:

```yaml
read_only: true
tmpfs:
  - /tmp
  - /var/run
```

### 3. Security Options

- `no-new-privileges:true` - Prevents privilege escalation
- Minimal base images (Alpine Linux)
- Vulnerability scanning with Trivy
- Regular security updates

### 4. Secrets Management

**Never commit secrets to version control!**

```bash
# Generate secure secrets
openssl rand -base64 32  # JWT_SECRET
openssl rand -base64 24  # API_KEY
openssl rand -base64 16  # POSTGRES_PASSWORD
```

Store secrets in:

- Docker secrets (Swarm mode)
- Kubernetes secrets
- AWS Secrets Manager
- HashiCorp Vault

### 5. Network Isolation

Services communicate via dedicated bridge network:

```yaml
networks:
  taskflow:
    driver: bridge
    ipam:
      config:
        - subnet: 172.28.0.0/16
```

### 6. Resource Limits

Prevent resource exhaustion:

```yaml
deploy:
  resources:
    limits:
      cpus: '1.0'
      memory: 1G
    reservations:
      cpus: '0.25'
      memory: 256M
```

## Resource Planning

### CPU Allocation

| Service    | Reserved | Limit | Notes                    |
| ---------- | -------- | ----- | ------------------------ |
| API        | 0.25     | 1.0   | Per replica              |
| Worker     | 0.5      | 2.0   | CPU-intensive processing |
| PostgreSQL | 0.5      | 2.0   | Database queries         |
| Redis      | 0.25     | 1.0   | In-memory operations     |
| Redpanda   | 0.5      | 2.0   | Message streaming        |
| Dashboard  | 0.1      | 0.5   | Static serving           |
| Prometheus | 0.25     | 1.0   | Metrics collection       |
| Grafana    | 0.1      | 0.5   | Dashboard rendering      |

### Memory Allocation

| Service    | Reserved | Limit | Notes                     |
| ---------- | -------- | ----- | ------------------------- |
| API        | 256M     | 1G    | Per replica               |
| Worker     | 512M     | 2G    | Job processing overhead   |
| PostgreSQL | 512M     | 2G    | Query cache + connections |
| Redis      | 256M     | 1G    | LRU cache policy          |
| Redpanda   | 512M     | 1.5G  | Message buffering         |
| Dashboard  | 64M      | 256M  | nginx static serving      |
| Prometheus | 256M     | 1G    | Time-series storage       |
| Grafana    | 128M     | 512M  | Dashboard cache           |

### Storage Requirements

- **PostgreSQL**: 10-50GB+ (depends on job retention)
- **Redis**: 1-5GB (ephemeral cache)
- **Redpanda**: 5-20GB (event log retention)
- **Prometheus**: 10-50GB (30-day retention)
- **Grafana**: 1GB (dashboard configs)

## Deployment Steps

### 1. Prepare Environment

```bash
# Clone repository
git clone https://github.com/YOUR_USERNAME/Resilient_TaskFlow.git
cd Resilient_TaskFlow

# Create production environment file
cp .env.production.example .env.production

# Edit with secure values
nano .env.production
```

### 2. Configure Secrets

Edit `.env.production`:

```bash
# Generate secure secrets
POSTGRES_PASSWORD=$(openssl rand -base64 32)
JWT_SECRET=$(openssl rand -base64 32)
API_KEY=$(openssl rand -base64 24)
GRAFANA_ADMIN_PASSWORD=$(openssl rand -base64 16)
```

### 3. Build Images

```bash
# Build all services
docker-compose -f docker-compose.prod.yml build

# Or pull pre-built images
docker-compose -f docker-compose.prod.yml pull
```

### 4. Initialize Database

```bash
# Start PostgreSQL only
docker-compose -f docker-compose.prod.yml up -d postgres

# Wait for healthy
docker-compose -f docker-compose.prod.yml ps postgres

# Run migrations
docker-compose -f docker-compose.prod.yml run --rm api pnpm db:migrate

# Optional: Seed data
docker-compose -f docker-compose.prod.yml run --rm api pnpm db:seed
```

### 5. Start Services

```bash
# Start all services
docker-compose -f docker-compose.prod.yml up -d

# Check status
docker-compose -f docker-compose.prod.yml ps

# View logs
docker-compose -f docker-compose.prod.yml logs -f
```

### 6. Verify Deployment

```bash
# API health check
curl http://localhost:3000/api/v1/health

# Dashboard
open http://localhost:3001

# Prometheus
open http://localhost:9091

# Grafana (default: admin / <GRAFANA_ADMIN_PASSWORD>)
open http://localhost:3002
```

## Monitoring

### Health Checks

All services include health checks:

```bash
# View health status
docker-compose -f docker-compose.prod.yml ps

# Check specific service
docker inspect --format='{{json .State.Health}}' taskflow-api | jq
```

### Metrics

**Prometheus Metrics:**

- `http://localhost:9091/targets` - Service health
- `http://localhost:9091/graph` - Query metrics

**Key Metrics:**

- `taskflow_jobs_submitted_total` - Job submissions
- `taskflow_jobs_completed_total` - Completed jobs
- `taskflow_jobs_failed_total` - Failed jobs
- `taskflow_queue_depth` - Current queue size
- `taskflow_worker_count` - Active workers
- `taskflow_job_latency_seconds` - Processing time

**Grafana Dashboards:**

1. System Overview
2. Job Processing
3. Worker Performance
4. Database Metrics
5. Redis Performance

### Logging

View logs:

```bash
# All services
docker-compose -f docker-compose.prod.yml logs -f

# Specific service
docker-compose -f docker-compose.prod.yml logs -f api

# Last 100 lines
docker-compose -f docker-compose.prod.yml logs --tail=100 worker

# Since timestamp
docker-compose -f docker-compose.prod.yml logs --since 2024-01-01T00:00:00
```

Configure log rotation in `/etc/docker/daemon.json`:

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

## Backup and Recovery

### Database Backup

```bash
# Backup PostgreSQL
docker exec taskflow-postgres pg_dump -U taskflow -F c taskflow > backup_$(date +%Y%m%d_%H%M%S).dump

# Automated daily backups
cat > backup.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="/backups/postgres"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
docker exec taskflow-postgres pg_dump -U taskflow -F c taskflow > ${BACKUP_DIR}/taskflow_${TIMESTAMP}.dump
# Keep last 7 days
find ${BACKUP_DIR} -name "taskflow_*.dump" -mtime +7 -delete
EOF
chmod +x backup.sh

# Add to crontab (daily at 2 AM)
echo "0 2 * * * /path/to/backup.sh" | crontab -
```

### Restore Database

```bash
# Stop services
docker-compose -f docker-compose.prod.yml stop api worker

# Restore from backup
docker exec -i taskflow-postgres pg_restore -U taskflow -d taskflow -c < backup.dump

# Restart services
docker-compose -f docker-compose.prod.yml start api worker
```

### Volume Backup

```bash
# Backup all volumes
docker run --rm \
  -v taskflow_postgres_data:/data \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/postgres_$(date +%Y%m%d).tar.gz -C /data .

# Restore volume
docker run --rm \
  -v taskflow_postgres_data:/data \
  -v $(pwd)/backups:/backup \
  alpine sh -c "cd /data && tar xzf /backup/postgres_20240101.tar.gz"
```

## Scaling

### Horizontal Scaling

Scale API and Worker replicas:

```bash
# Scale API to 4 replicas
docker-compose -f docker-compose.prod.yml up -d --scale api=4

# Scale Workers to 6 replicas
docker-compose -f docker-compose.prod.yml up -d --scale worker=6

# Or set in .env.production
API_REPLICAS=4
WORKER_REPLICAS=6
```

### Load Balancing

For multiple API replicas, use a load balancer:

**Option 1: nginx**

```nginx
upstream api_backend {
    least_conn;
    server taskflow-api-1:3000;
    server taskflow-api-2:3000;
    server taskflow-api-3:3000;
}

server {
    listen 80;
    location /api {
        proxy_pass http://api_backend;
    }
}
```

**Option 2: Docker Swarm**

```bash
docker stack deploy -c docker-compose.prod.yml taskflow
```

**Option 3: Kubernetes**

See `docs/kubernetes-deployment.md`

### Vertical Scaling

Increase resource limits in `docker-compose.prod.yml`:

```yaml
deploy:
  resources:
    limits:
      cpus: '4.0' # Increased from 2.0
      memory: 4G # Increased from 2G
```

## Troubleshooting

### Container Won't Start

```bash
# Check logs
docker-compose -f docker-compose.prod.yml logs service-name

# Check events
docker events --since 5m

# Inspect container
docker inspect taskflow-api
```

### High Memory Usage

```bash
# Check resource usage
docker stats

# Check specific container
docker stats taskflow-api

# Adjust limits
# Edit deploy.resources.limits in docker-compose.prod.yml
```

### Database Connection Issues

```bash
# Check PostgreSQL logs
docker-compose -f docker-compose.prod.yml logs postgres

# Test connection
docker exec taskflow-postgres psql -U taskflow -c "SELECT 1"

# Check connection count
docker exec taskflow-postgres psql -U taskflow -c "SELECT count(*) FROM pg_stat_activity"
```

### Performance Issues

```bash
# Check slow queries
docker exec taskflow-postgres psql -U taskflow -c "SELECT * FROM pg_stat_statements ORDER BY total_time DESC LIMIT 10"

# Check Redis performance
docker exec taskflow-redis redis-cli --latency

# Check queue depth
docker exec taskflow-redis redis-cli XLEN taskflow:jobs:default
```

### Worker Not Processing Jobs

```bash
# Check worker logs
docker-compose -f docker-compose.prod.yml logs worker

# Check worker health
docker exec taskflow-worker ps aux

# Check queue
docker exec taskflow-redis redis-cli XLEN taskflow:jobs:default
```

## Maintenance

### Updates

```bash
# Pull latest images
docker-compose -f docker-compose.prod.yml pull

# Graceful restart
docker-compose -f docker-compose.prod.yml up -d --no-deps --build service-name

# Zero-downtime deployment
# 1. Scale up new version
docker-compose -f docker-compose.prod.yml up -d --scale api=4
# 2. Wait for health checks
# 3. Scale down old version
docker-compose -f docker-compose.prod.yml up -d --scale api=2
```

### Cleanup

```bash
# Remove stopped containers
docker container prune -f

# Remove unused images
docker image prune -a -f

# Remove unused volumes (CAREFUL!)
docker volume prune -f

# Complete cleanup
docker system prune -a --volumes -f
```

## Best Practices

1. **Always use specific version tags** - Never use `:latest` in production
2. **Enable resource limits** - Prevent resource exhaustion
3. **Monitor health checks** - Set up alerting for failed checks
4. **Regular backups** - Automate daily database backups
5. **Log aggregation** - Use centralized logging (ELK, Loki)
6. **Security scanning** - Scan images with Trivy before deployment
7. **Graceful shutdowns** - Set proper SHUTDOWN_TIMEOUT values
8. **Rolling updates** - Use zero-downtime deployment strategies
9. **Monitor metrics** - Set up Grafana alerts
10. **Test disaster recovery** - Regularly test backup restore procedures

## Production Checklist

Before going live:

- [ ] Secure secrets configured
- [ ] Resource limits set
- [ ] Health checks working
- [ ] Monitoring configured
- [ ] Backup automated
- [ ] Logs aggregated
- [ ] SSL/TLS configured
- [ ] Firewall rules set
- [ ] Load testing completed
- [ ] Disaster recovery tested
- [ ] Documentation updated
- [ ] Team trained
- [ ] Alerting configured
- [ ] Runbook created

## Support

For issues:

1. Check logs: `docker-compose logs`
2. Review health: `docker-compose ps`
3. Check docs: `docs/`
4. Create issue: GitHub Issues

---

**Next**: See `docs/kubernetes-deployment.md` for Kubernetes deployment
