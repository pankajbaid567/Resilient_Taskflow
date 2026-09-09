# Architecture Decision Records (ADRs)

## Overview

This directory contains Architecture Decision Records documenting significant architectural decisions made during the development of Resilient TaskFlow.

## Format

Each ADR follows this structure:
- **Status**: Proposed, Accepted, Deprecated, Superseded
- **Context**: What is the issue we're seeing that is motivating this decision?
- **Decision**: What is the change that we're proposing?
- **Consequences**: What becomes easier or more difficult to do because of this change?

## Index

1. [ADR-001: Use PostgreSQL as Source of Truth](./001-postgresql-source-of-truth.md)
2. [ADR-002: Use Redis Streams for Job Delivery](./002-redis-streams-for-delivery.md)
3. [ADR-003: Separate Kafka for Event Propagation](./003-kafka-for-events.md)
4. [ADR-004: At-Least-Once Delivery Semantics](./004-at-least-once-delivery.md)
5. [ADR-005: Lease-Based Worker Coordination](./005-lease-based-coordination.md)
6. [ADR-006: Use Fastify Over Express](./006-fastify-over-express.md)
7. [ADR-007: Use Drizzle ORM](./007-drizzle-orm.md)
8. [ADR-008: Monorepo with pnpm + Turborepo](./008-monorepo-structure.md)
9. [ADR-009: Write-Ahead Consistency for Job Creation](./009-write-ahead-consistency.md)
10. [ADR-010: Build Queue from First Principles](./010-build-queue-from-scratch.md)

## ADR Lifecycle

- **Proposed**: Initial proposal, under discussion
- **Accepted**: Decision has been made and implemented
- **Deprecated**: No longer relevant but kept for historical context
- **Superseded**: Replaced by a newer decision (link to superseding ADR)
