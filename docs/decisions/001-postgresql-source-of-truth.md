# ADR-001: Use PostgreSQL as Source of Truth

**Status**: Accepted

**Date**: 2026-08-23

**Deciders**: Architecture Team

## Context

In a distributed task queue system, job state must be stored durably to survive component failures. We need to decide which system serves as the authoritative source of truth for job state.

Options considered:

1. **PostgreSQL** - Relational database with ACID transactions
2. **Redis** - In-memory data store with optional persistence
3. **Kafka** - Distributed event log
4. **MongoDB** - Document database

## Decision

We will use **PostgreSQL** as the single source of truth for all durable job state.

All job records, state transitions, attempts, and metadata will be stored in PostgreSQL. Redis will contain derived or ephemeral state only.

## Rationale

### PostgreSQL Advantages

**Durability**

- ACID transactions guarantee data consistency
- Write-Ahead Log (WAL) ensures crash recovery
- Point-in-time recovery for disaster recovery
- Proven durability guarantees

**Consistency**

- Strong consistency model
- Foreign key constraints enforce referential integrity
- CHECK constraints enforce business rules
- Transactions enable atomic multi-table updates

**Queryability**

- Rich SQL query language
- Complex joins for analytics
- Indexes for performance optimization
- Full-text search capabilities

**Operational Maturity**

- Industry-standard database
- Well-understood operational characteristics
- Extensive monitoring and tooling
- Managed service options (AWS RDS, GCP Cloud SQL)

**State Machine Enforcement**

- Triggers can enforce state transitions
- Constraints prevent invalid states
- Audit trail via event log table

### Why Not Other Options?

**Redis**

- Primarily in-memory (ephemeral by default)
- AOF/RDB persistence has trade-offs (performance vs durability)
- Limited query capabilities
- Not designed for complex relational data
- **Verdict**: Good for cache and queues, not for durable state

**Kafka**

- Log-based, append-only
- Not designed for mutable state
- No native indexing or querying
- Complex to model mutable job state
- **Verdict**: Good for events, not for job records

**MongoDB**

- Weaker consistency guarantees (eventual consistency in some configs)
- Less mature transaction support compared to PostgreSQL
- Project already demonstrates MongoDB knowledge (MERN stack)
- **Verdict**: Good for documents, but PostgreSQL better for transactional data

## Consequences

### Positive

✅ **Strong Durability**: Jobs survive any system component failure  
✅ **ACID Guarantees**: State transitions are atomic and consistent  
✅ **Query Power**: Can build complex reports and analytics  
✅ **Proven Technology**: Well-understood failure modes and recovery  
✅ **Industry Standard**: Demonstrates knowledge of relational databases

### Negative

❌ **Write Latency**: Higher latency than in-memory stores (acceptable trade-off)  
❌ **Scalability Ceiling**: Vertical scaling limits (mitigated by read replicas)  
❌ **Operational Complexity**: Requires backup, replication, tuning

### Mitigation Strategies

**For Write Latency**:

- Use connection pooling to reduce connection overhead
- Optimize indexes for common queries
- Use prepared statements
- Consider read replicas for query load

**For Scalability**:

- Start with a single PostgreSQL instance. Measured on one laptop, a job costs about 5 transactions and the instance saturated at roughly 200 to 300 jobs/s (see `docs/benchmarking/RESULTS.md`); that figure is specific to that machine and Docker setup
- Add read replicas for query scaling
- Partition tables if needed (future optimization)
- Consider PostgreSQL cluster solutions (Citus, pg_partman) at scale

**For Operational Complexity**:

- Use managed PostgreSQL service in production (AWS RDS, GCP Cloud SQL)
- Implement automated backups
- Monitor query performance with pg_stat_statements
- Set up alerting for connection pool exhaustion

## Implementation Notes

**Core Tables**:

- `jobs` - Primary job records with state
- `job_attempts` - Execution history
- `job_events` - Audit log of state changes
- `workers` - Worker registrations
- `queues` - Queue configurations
- `idempotency_keys` - Duplicate prevention
- `dead_letter_jobs` - Failed jobs after max retries

**Key Indexes**:

- `jobs(status, queue_id, priority, created_at)` - Worker queries
- `jobs(user_id, created_at DESC)` - User job listings
- `jobs(scheduled_at)` - Delayed job scheduling
- `jobs(lease_expires_at)` - Stale lease detection

**Transaction Boundaries**:

- Job creation: INSERT job + idempotency key + event (atomic)
- State transition: UPDATE job + INSERT event (atomic)
- Retry: UPDATE job + INSERT attempt + possibly INSERT DLQ (atomic)

## Related Decisions

- [ADR-004: At-Least-Once Delivery Semantics](./004-at-least-once-delivery.md) - Durability enables reliable delivery

## References

- [PostgreSQL Durability](https://www.postgresql.org/docs/current/wal-intro.html)
- [ACID Properties](https://en.wikipedia.org/wiki/ACID)
- [Database-as-Source-of-Truth Pattern](https://martinfowler.com/articles/patterns-of-distributed-systems/database-as-source-of-truth.html)
