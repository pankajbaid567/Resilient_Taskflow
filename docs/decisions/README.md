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
2. [ADR-004: At-Least-Once Delivery Semantics](./004-at-least-once-delivery.md)
3. [ADR-010: Build Queue from First Principles](./010-build-queue-from-scratch.md)
4. [ADR-011: Graceful shutdown hands leases back and refunds the attempt](./011-shutdown-releases-leases.md)
5. [ADR-012: Priority through a Postgres-ordered, bounded in-flight window](./012-priority-window.md)

Numbers 002, 003 and 005 to 009 are unused: those decisions were planned but never written, and their index entries pointed at files that do not exist.

## ADR Lifecycle

- **Proposed**: Initial proposal, under discussion
- **Accepted**: Decision has been made and implemented
- **Deprecated**: No longer relevant but kept for historical context
- **Superseded**: Replaced by a newer decision (link to superseding ADR)
