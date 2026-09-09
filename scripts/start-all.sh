#!/bin/bash

# TaskFlow - Complete Startup Script
# This script starts all infrastructure and services

set -e

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║             TaskFlow Complete Startup                         ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Check if Docker is running
echo "1. Checking Docker..."
if ! docker ps > /dev/null 2>&1; then
    echo "   ✗ Docker is not running. Please start Docker Desktop first."
    exit 1
fi
echo "   ✓ Docker is running"
echo ""

# Start infrastructure services
echo "2. Starting infrastructure services..."
cd "$(dirname "$0")/.."

# Remove dashboard from docker-compose temporarily
echo "   Starting PostgreSQL, Redis, Redpanda, Prometheus, Grafana..."
docker-compose up -d postgres redis redpanda prometheus grafana 2>&1 | grep -v "WARNING"

echo "   Waiting for services to be healthy..."
sleep 10

# Check service health
echo ""
echo "3. Checking service health..."

# Check PostgreSQL
if docker exec taskflow-postgres pg_isready -U taskflow > /dev/null 2>&1; then
    echo "   ✓ PostgreSQL is ready"
else
    echo "   ✗ PostgreSQL is not ready"
fi

# Check Redis
if docker exec taskflow-redis redis-cli ping > /dev/null 2>&1; then
    echo "   ✓ Redis is ready"
else
    echo "   ✗ Redis is not ready"
fi

# Check Redpanda
if docker exec taskflow-redpanda rpk cluster info > /dev/null 2>&1; then
    echo "   ✓ Redpanda is ready"
else
    echo "   ⚠ Redpanda might still be starting..."
fi

echo ""
echo "4. Running database migrations..."
pnpm db:migrate

echo ""
echo "5. Infrastructure ready!"
echo ""
echo "   PostgreSQL: localhost:5432"
echo "   Redis:      localhost:6379"
echo "   Redpanda:   localhost:19092"
echo "   Prometheus: http://localhost:9091"
echo "   Grafana:    http://localhost:3002 (admin/admin)"
echo ""
echo "Next steps:"
echo "   Terminal 1: pnpm dev:api"
echo "   Terminal 2: pnpm dev:worker"
echo "   Terminal 3: pnpm demo"
echo ""
