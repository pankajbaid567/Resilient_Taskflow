# ADR-010: Build Queue from First Principles (No BullMQ)

**Status**: Accepted

**Date**: 2026-08-23

**Deciders**: Architecture Team

## Context

We need to implement a distributed job queue. Several options exist:

1. **BullMQ** - Popular Redis-based queue library for Node.js
2. **Agenda** - MongoDB-based job scheduler
3. **Bee-Queue** - Lightweight Redis queue
4. **Build from scratch** - Implement queue logic directly on Redis Streams

## Decision

We will **NOT** use BullMQ or any high-level queue library.

Instead, we will implement the queue engine from first principles using Redis Streams directly (XADD, XREADGROUP, XACK, XPENDING, XCLAIM).

## Rationale

### Project Goal: Demonstrate Deep Understanding

This is a **portfolio project** targeting **SDE/Backend internships** where the goal is to demonstrate understanding of:

- Distributed systems fundamentals
- Queue internals
- Message delivery semantics
- Consumer groups
- Failure recovery
- Concurrency control

**Using BullMQ defeats this purpose:**

- ❌ Hides distributed systems complexity
- ❌ Abstracts away queue semantics
- ❌ Becomes "just another CRUD project with npm install bullmq"
- ❌ Interviewers will ask: "But do you understand how it works?"

### Interview Defensibility

**Scenario 1: Using BullMQ**

```
Interviewer: "I see you used BullMQ. How does it handle worker failures?"
Candidate: "Um... it has retry mechanisms built-in?"
Interviewer: "But HOW does it detect failures?"
Candidate: "I'm not sure exactly..."
Result: ❌ Superficial understanding
```

**Scenario 2: Built from Scratch**

```
Interviewer: "How does your queue handle worker failures?"
Candidate: "Workers hold a lease with expiration time. If a worker crashes,
           its lease expires. We use XPENDING to find stale messages and XCLAIM
           to transfer ownership to a healthy worker. I can show you the code..."
Interviewer: "What about duplicate processing?"
Candidate: "That's why we use optimistic locking in PostgreSQL. Here's how..."
Result: ✅ Deep understanding demonstrated
```

### Learning Objectives

Building from scratch forces understanding of:

**Redis Streams Operations**:

- `XADD` - How to enqueue messages
- `XREADGROUP` - How to consume with consumer groups
- `XACK` - How to acknowledge processing
- `XPENDING` - How to inspect unacknowledged messages
- `XCLAIM` - How to reclaim stale messages
- `XGROUP CREATE` - How to set up consumer groups

**Distributed Systems Concepts**:

- At-least-once delivery semantics
- Consumer group coordination
- Message acknowledgement protocols
- Stale consumer detection
- Poison message handling
- Backpressure mechanisms

**Failure Modes**:

- Worker crashes before ACK
- Redis crashes with pending messages
- Network partitions
- Message redelivery
- Duplicate processing

### What We Gain

✅ **Deep Knowledge**: Understand every line of queue logic  
✅ **Interview Stories**: Real problems solved, not library usage  
✅ **Debugging Skills**: Know exactly what's happening  
✅ **Portfolio Differentiation**: Most students use libraries  
✅ **Flexibility**: Can customize for specific needs  
✅ **Career Growth**: Knowledge transfers to any queue system

### What We Lose

❌ **Development Speed**: Takes longer to build  
❌ **Battle-Testing**: BullMQ has years of production use  
❌ **Features**: Missing advanced features (rate limiting, repeatable jobs)  
❌ **Maintenance**: We own all bugs

### Why These Trade-Offs Are Acceptable

**For a Portfolio Project**:

- Learning is the primary goal (speed is secondary)
- Don't need every feature (just core queue semantics)
- Bugs are learning opportunities
- Demonstrates engineering depth

**For Production** (future consideration):

- Could use BullMQ after demonstrating understanding
- Or continue with custom implementation (many companies do this)
- Benchmark custom vs BullMQ

## Implementation Approach

### Phase 1: Core Queue Operations

```typescript
class QueueEngine {
  async enqueue(jobId: string, queue: string): Promise<string> {
    // XADD implementation
  }

  async consume(workerId: string, queues: string[]): Promise<Message[]> {
    // XREADGROUP implementation
  }

  async acknowledge(queue: string, messageId: string): Promise<void> {
    // XACK implementation
  }
}
```

### Phase 2: Consumer Groups

```typescript
async function createConsumerGroup(queue: string): Promise<void> {
  await redis.xgroup('CREATE', streamKey, groupName, '0', 'MKSTREAM');
}
```

### Phase 3: Failure Recovery

```typescript
async function claimStaleMessages(
  queue: string,
  workerId: string,
  minIdleMs: number
): Promise<Message[]> {
  // XPENDING + XCLAIM implementation
}
```

### Phase 4: Worker Lifecycle

```typescript
class Worker {
  async start(): Promise<void> {
    while (!this.shutdown) {
      const messages = await this.consume();
      await this.processMessages(messages);
      await this.claimStale();
    }
  }
}
```

## Comparison: Custom vs BullMQ

| Aspect           | Custom Implementation        | BullMQ                  |
| ---------------- | ---------------------------- | ----------------------- |
| Learning Depth   | ✅ Deep                      | ❌ Shallow              |
| Development Time | ❌ Slower                    | ✅ Faster               |
| Interview Value  | ✅ High                      | ⚠️ Medium               |
| Debugging        | ✅ Full control              | ❌ Black box            |
| Features         | ⚠️ Basic                     | ✅ Comprehensive        |
| Performance      | ✅ Optimizable               | ✅ Optimized            |
| Maintenance      | ❌ We own bugs               | ✅ Community maintained |
| Flexibility      | ✅ Fully customizable        | ⚠️ Limited by API       |
| Resume Impact    | ✅ "Built distributed queue" | ⚠️ "Used BullMQ"        |

## Success Criteria

The custom queue implementation must demonstrate:

1. ✅ **Consumer Groups**: Multiple workers consuming from same queue
2. ✅ **Load Balancing**: Automatic distribution across workers
3. ✅ **Acknowledgement**: Explicit message acknowledgement
4. ✅ **Failure Recovery**: Reclaim messages from dead workers
5. ✅ **At-Least-Once**: Guarantee message delivery
6. ✅ **Idempotency**: Handle duplicate delivery safely
7. ✅ **Graceful Shutdown**: Workers finish in-flight jobs
8. ✅ **Observability**: Metrics on queue depth, pending messages
9. ✅ **Testing**: Comprehensive tests including failure scenarios
10. ✅ **Documentation**: Explain every design decision

## Post-Implementation Analysis

After building the custom queue, we will:

1. **Benchmark**: Compare performance against BullMQ
2. **Feature Gap Analysis**: Document what BullMQ has that we don't
3. **Lessons Learned**: Document challenges encountered
4. **Decision Review**: Evaluate if decision was correct

This analysis becomes portfolio content demonstrating:

- Engineering judgment
- Performance analysis skills
- Trade-off evaluation
- Technical writing

## Consequences

### Positive

✅ **Deep Understanding**: Know exactly how queue works  
✅ **Interview Material**: Rich technical stories  
✅ **Debugging Power**: Can troubleshoot any issue  
✅ **Resume Differentiation**: Stands out from "npm install" projects  
✅ **Career Preparation**: Applicable to real distributed systems work  
✅ **Learning**: Forces understanding of Redis Streams internals

### Negative

❌ **Time Investment**: 2-3x longer than using BullMQ  
❌ **Missing Features**: No built-in rate limiting, job scheduling, etc.  
❌ **Potential Bugs**: More likely to have edge case bugs  
❌ **Reinventing Wheel**: Queue is a solved problem

### Mitigation

**For Time Investment**:

- Focus on core features first (MVP)
- Add advanced features incrementally
- Phase-based implementation (Phase 3 in project plan)

**For Missing Features**:

- Implement only what's needed for demonstration
- Document feature roadmap
- Show how to add features (extensibility)

**For Potential Bugs**:

- Comprehensive testing (unit, integration, chaos)
- Code review
- Benchmark against BullMQ to validate correctness

**For Reinventing Wheel**:

- Frame as learning exercise and portfolio differentiation
- Document what BullMQ does better
- Note when production would use existing library

## Future Considerations

### Option 1: Keep Custom Queue

If performance and reliability are good:

- Continue using custom implementation
- Add features as needed
- Maintain as core competency

### Option 2: Migrate to BullMQ

If complexity becomes unmanageable:

- Use custom queue for V1 (learning/portfolio)
- Migrate to BullMQ for V2 (production-ready)
- Document migration as learning exercise

### Option 3: Hybrid Approach

- Keep custom queue for core job processing
- Use BullMQ for advanced features (repeatable jobs, cron)
- Best of both worlds

## Documentation Deliverables

As part of this decision, we will produce:

1. **Queue Design Document**: Complete Redis Streams usage
2. **Failure Recovery Guide**: How every failure is handled
3. **Performance Analysis**: Benchmarks vs BullMQ
4. **Code Comments**: Explain every non-obvious decision
5. **Testing Strategy**: Comprehensive test coverage
6. **README Section**: "Why We Built Our Own Queue"

## Related Decisions

- [ADR-002: Use Redis Streams for Job Delivery](./002-redis-streams-for-delivery.md) - Choice of Redis Streams
- [ADR-004: At-Least-Once Delivery Semantics](./004-at-least-once-delivery.md) - Delivery guarantees
- [ADR-005: Lease-Based Worker Coordination](./005-lease-based-coordination.md) - Worker coordination

## References

- [Redis Streams Introduction](https://redis.io/docs/data-types/streams/)
- [Redis Streams Tutorial](https://redis.io/docs/data-types/streams-tutorial/)
- [BullMQ Documentation](https://docs.bullmq.io/) - Know what we're comparing against
- [Building Reliable Distributed Systems](https://www.oreilly.com/library/view/building-microservices-2nd/9781492034018/)

## Appendix: Interview Question Preparation

Questions this decision helps answer:

**Q: "Why didn't you use BullMQ?"**  
A: "I wanted to demonstrate deep understanding of distributed queue internals rather than just integrating a library. I implemented the queue directly on Redis Streams using XREADGROUP, XACK, and XCLAIM. This forced me to solve problems like consumer group coordination, stale message recovery, and at-least-once delivery semantics. Here's how..."

**Q: "How does your queue compare to BullMQ?"**  
A: "I actually benchmarked them. BullMQ has more features like rate limiting and repeatable jobs, but for core job processing, performance was comparable. My implementation gives full control and understanding. I documented the trade-offs in my ADR..."

**Q: "What would you do differently in production?"**  
A: "For production, I'd evaluate BullMQ for advanced features, but I'd keep the custom core if performance and reliability meet requirements. The key insight is that building from scratch taught me exactly what to look for in a production queue library..."
