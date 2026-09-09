# Redis Optimization Guide

This document covers Redis performance optimization strategies, connection pooling, and best practices for Resilient TaskFlow.

## Table of Contents

- [Overview](#overview)
- [Connection Pooling](#connection-pooling)
- [Command Optimization](#command-optimization)
- [Memory Management](#memory-management)
- [Monitoring](#monitoring)
- [Troubleshooting](#troubleshooting)

## Overview

### Performance Goals

- P95 command latency < 5ms
- P99 command latency < 10ms
- Memory usage < 80% of available
- Network bandwidth < 100MB/s
- Hit rate > 95%

### Redis Configuration

```conf
# redis.conf - Production settings

# Memory
maxmemory 2gb
maxmemory-policy allkeys-lru  # Evict least recently used keys
maxmemory-samples 5

# Persistence
save 900 1       # Save after 900s if 1 key changed
save 300 10      # Save after 300s if 10 keys changed
save 60 10000    # Save after 60s if 10000 keys changed
stop-writes-on-bgsave-error yes
rdbcompression yes
rdbchecksum yes

# AOF (Append Only File)
appendonly yes
appendfilename "appendonly.aof"
appendfsync everysec  # Balance between performance and durability
no-appendfsync-on-rewrite no
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb

# Networking
tcp-backlog 511
timeout 0  # Never close idle connections
tcp-keepalive 300
maxclients 10000

# Performance
hz 10  # Server hz (higher = more CPU, lower latency)
dynamic-hz yes
latency-monitor-threshold 100  # Log commands > 100ms

# Slow log
slowlog-log-slower-than 10000  # Log commands > 10ms
slowlog-max-len 128

# Memory optimization
hash-max-ziplist-entries 512
hash-max-ziplist-value 64
list-max-ziplist-size -2
set-max-intset-entries 512
zset-max-ziplist-entries 128
zset-max-ziplist-value 64

# Lua
lua-time-limit 5000  # 5 seconds max execution
```

## Connection Pooling

### IORedis Configuration

```typescript
import Redis from 'ioredis';

const redis = new Redis({
  host: 'localhost',
  port: 6379,
  
  // Connection pool settings
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  enableOfflineQueue: true,
  
  // Retry strategy
  retryStrategy: (times: number) => {
    if (times > 10) return null; // Stop retrying
    return Math.min(times * 100, 3000); // Exponential backoff
  },
  
  // Reconnection
  reconnectOnError: (err) => {
    const targetErrors = ['READONLY', 'ECONNREFUSED'];
    return targetErrors.some((e) => err.message.includes(e));
  },
  
  // Performance
  lazyConnect: false, // Connect immediately
  keepAlive: 30000, // Keep-alive interval
  family: 4, // IPv4
  
  // Timeouts
  connectTimeout: 10000, // 10s connect timeout
  commandTimeout: 5000, // 5s command timeout
  
  // Connection pool (for Cluster)
  // Not applicable for single Redis instance
});
```

### Connection Pool Sizing

**Formula**: `connections = (CPU cores * 2) + effective disk I/O`

For most applications:
- **Minimum**: 5 connections
- **Recommended**: 10-20 connections
- **Maximum**: 50 connections

**Why not more?**
- Redis is single-threaded
- More connections = more overhead
- Better to use pipelining

## Command Optimization

### 1. Use Pipelining for Batch Operations

❌ **Bad**: Multiple round trips
```typescript
// 100 commands = 100 round trips
for (let i = 0; i < 100; i++) {
  await redis.set(`key:${i}`, `value${i}`);
}
```

✅ **Good**: Single round trip
```typescript
// 100 commands = 1 round trip
const pipeline = redis.pipeline();
for (let i = 0; i < 100; i++) {
  pipeline.set(`key:${i}`, `value${i}`);
}
await pipeline.exec();
```

**Performance**: 100x faster for bulk operations!

### 2. Use MGET/MSET Instead of Multiple GET/SET

❌ **Bad**: N round trips
```typescript
const values = [];
for (const key of keys) {
  values.push(await redis.get(key));
}
```

✅ **Good**: 1 round trip
```typescript
const values = await redis.mget(...keys);
```

### 3. Use UNLINK Instead of DEL for Large Keys

❌ **Bad**: DEL blocks Redis
```typescript
await redis.del('large-key'); // Blocks until deletion complete
```

✅ **Good**: UNLINK is non-blocking
```typescript
await redis.unlink('large-key'); // Returns immediately
```

**Why**: UNLINK deletes asynchronously in background.

### 4. Use SCAN Instead of KEYS

❌ **Bad**: KEYS blocks Redis
```typescript
const keys = await redis.keys('user:*'); // Blocks entire server!
```

✅ **Good**: SCAN is non-blocking
```typescript
const keys: string[] = [];
let cursor = '0';
do {
  const [nextCursor, batch] = await redis.scan(
    cursor,
    'MATCH',
    'user:*',
    'COUNT',
    100
  );
  cursor = nextCursor;
  keys.push(...batch);
} while (cursor !== '0');
```

**Why**: SCAN iterates incrementally without blocking.

### 5. Use Lua Scripts for Atomic Operations

❌ **Bad**: Multiple round trips, not atomic
```typescript
const value = await redis.get('counter');
const newValue = parseInt(value || '0') + 1;
await redis.set('counter', newValue.toString());
await redis.expire('counter', 60);
```

✅ **Good**: Single atomic operation
```typescript
const script = `
  local current = redis.call('INCRBY', KEYS[1], ARGV[1])
  if current == tonumber(ARGV[1]) then
    redis.call('EXPIRE', KEYS[1], ARGV[2])
  end
  return current
`;

const newValue = await redis.eval(
  script,
  1,
  'counter',
  '1',
  '60'
);
```

**Why**: Lua scripts are atomic and reduce round trips.

### 6. Use Hash Commands for Related Data

❌ **Bad**: Multiple keys
```typescript
await redis.set('user:123:name', 'John');
await redis.set('user:123:email', 'john@example.com');
await redis.set('user:123:age', '30');
```

✅ **Good**: Single hash
```typescript
await redis.hmset('user:123', {
  name: 'John',
  email: 'john@example.com',
  age: '30',
});
```

**Why**: Hashes are memory-efficient and atomic.

### 7. Use SETEX Instead of SET + EXPIRE

❌ **Bad**: Two commands
```typescript
await redis.set('session:abc', 'data');
await redis.expire('session:abc', 3600);
```

✅ **Good**: One command
```typescript
await redis.setex('session:abc', 3600, 'data');
```

### 8. Use EXISTS for Checking Key Existence

❌ **Bad**: Fetch entire value
```typescript
const value = await redis.get('key');
const exists = value !== null;
```

✅ **Good**: Only check existence
```typescript
const exists = (await redis.exists('key')) === 1;
```

### 9. Limit SMEMBERS/LRANGE/ZRANGE Results

❌ **Bad**: Return entire set
```typescript
const members = await redis.smembers('large-set'); // Could be millions!
```

✅ **Good**: Use cursor-based iteration
```typescript
const members: string[] = [];
let cursor = '0';
do {
  const [nextCursor, batch] = await redis.sscan('large-set', cursor, 'COUNT', 100);
  cursor = nextCursor;
  members.push(...batch);
} while (cursor !== '0');
```

### 10. Use Transactions for Consistency

```typescript
// Use MULTI/EXEC for transactional updates
const results = await redis
  .multi()
  .set('key1', 'value1')
  .set('key2', 'value2')
  .del('key3')
  .exec();

// Check results
for (const [error, result] of results) {
  if (error) {
    console.error('Command failed:', error);
  }
}
```

## Memory Management

### Key Naming Strategy

Use hierarchical keys with colons:
```
jobs:123:status
jobs:123:payload
queues:default:stats
workers:456:heartbeat
```

**Benefits**:
- Easy to scan/delete by prefix
- Clear ownership and relationships
- Better memory locality

### Key Expiration

Always set TTL on temporary data:

```typescript
// Job results (expire after 24 hours)
await redis.setex('job:123:result', 86400, JSON.stringify(result));

// Session data (expire after 1 hour)
await redis.setex('session:abc', 3600, sessionData);

// Cache (expire after 5 minutes)
await redis.setex('cache:user:123', 300, userData);
```

### Memory Optimization

**1. Use Hashes for Small Objects**
```typescript
// Instead of: job:123:id, job:123:type, job:123:status
// Use: HMSET job:123 id 123 type email status queued
```

**2. Use Appropriate Data Structures**
- **Strings**: Simple values, counters
- **Hashes**: Objects with fields
- **Lists**: Queues, recent items
- **Sets**: Unique items, tags
- **Sorted Sets**: Leaderboards, time-series

**3. Enable Compression**
```conf
# In redis.conf
hash-max-ziplist-entries 512
hash-max-ziplist-value 64
```

**4. Monitor Memory Usage**
```bash
# Check memory info
redis-cli INFO memory

# Find biggest keys
redis-cli --bigkeys

# Memory profiler
redis-cli MEMORY DOCTOR
```

### Eviction Policies

For cache-like workloads:
```conf
maxmemory-policy allkeys-lru  # Evict least recently used
```

For job queue (no eviction):
```conf
maxmemory-policy noeviction  # Return error when full
```

## Monitoring

### Key Metrics

**1. Latency**
```bash
# Monitor latency
redis-cli --latency

# Latency doctor
redis-cli --latency-doctor

# Latency history
redis-cli --latency-history
```

**2. Slow Log**
```bash
# Get slow commands
redis-cli SLOWLOG GET 10

# Slow log length
redis-cli SLOWLOG LEN

# Reset slow log
redis-cli SLOWLOG RESET
```

**3. Commands Stats**
```bash
# Command statistics
redis-cli INFO commandstats

# Output:
# cmdstat_get:calls=1234,usec=567,usec_per_call=0.46
# cmdstat_set:calls=890,usec=345,usec_per_call=0.39
```

**4. Memory Stats**
```bash
redis-cli INFO memory
```

**5. Client Connections**
```bash
redis-cli INFO clients

# List connected clients
redis-cli CLIENT LIST
```

### Monitoring Queries

```typescript
// Get Redis info
const info = await redis.info();

// Get memory usage
const memoryInfo = await redis.info('memory');

// Get command stats
const commandStats = await redis.info('commandstats');

// Get client list
const clients = await redis.client('LIST');

// Get slow log
const slowLog = await redis.slowlog('GET', 10);
```

### Performance Benchmarking

```bash
# Benchmark Redis
redis-benchmark -h localhost -p 6379 -c 50 -n 100000

# Test specific commands
redis-benchmark -t set,get -n 100000 -q

# Test with pipelining
redis-benchmark -t set,get -n 100000 -q -P 16
```

## Troubleshooting

### High Latency

**Symptoms**: Commands taking > 10ms

**Investigation**:
```bash
# Check slow log
redis-cli SLOWLOG GET 10

# Monitor latency
redis-cli --latency

# Check for blocking commands
redis-cli INFO commandstats | grep blocking
```

**Common Causes**:
1. **Slow commands**: KEYS, SMEMBERS on large sets
2. **Persistence**: BGSAVE/BGREWRITEAOF causing I/O pressure
3. **Memory pressure**: Swapping to disk
4. **Network**: High latency between client and Redis

**Fixes**:
- Replace KEYS with SCAN
- Use SSCAN instead of SMEMBERS
- Increase memory or enable eviction
- Move Redis closer to application

### High Memory Usage

**Symptoms**: Memory > 80% of maxmemory

**Investigation**:
```bash
# Find biggest keys
redis-cli --bigkeys

# Memory profiler
redis-cli MEMORY DOCTOR

# Check memory usage
redis-cli INFO memory
```

**Fixes**:
- Set TTL on temporary keys
- Enable eviction policy
- Optimize data structures
- Archive old data

### Connection Timeouts

**Symptoms**: Client connections timing out

**Investigation**:
```bash
# Check connection count
redis-cli INFO clients

# Check connection errors
redis-cli INFO stats | grep rejected
```

**Fixes**:
- Increase maxclients in redis.conf
- Fix connection leaks in application
- Use connection pooling

### Blocking Operations

**Symptoms**: Redis becomes unresponsive

**Investigation**:
```bash
# Check for long-running commands
redis-cli CLIENT LIST

# Check slow log
redis-cli SLOWLOG GET 10
```

**Common Blocking Commands**:
- `KEYS *` - Use SCAN instead
- `SMEMBERS` on large sets - Use SSCAN
- `FLUSHDB`/`FLUSHALL` - Use with caution
- `SAVE` - Use BGSAVE instead

### High CPU Usage

**Symptoms**: Redis using > 80% CPU

**Causes**:
1. Complex Lua scripts
2. High command rate
3. Persistence (BGSAVE/AOF)

**Fixes**:
- Optimize Lua scripts
- Use pipelining to reduce command overhead
- Adjust persistence settings
- Scale horizontally (Redis Cluster)

## Best Practices Summary

### DO ✅

- Use pipelining for bulk operations
- Use MGET/MSET for multiple keys
- Use SCAN instead of KEYS
- Use UNLINK instead of DEL for large keys
- Set TTL on temporary data
- Use hashes for related fields
- Use Lua scripts for atomic operations
- Monitor slow log regularly
- Use connection pooling
- Benchmark before production

### DON'T ❌

- Use KEYS in production (blocks Redis)
- Fetch large sets with SMEMBERS (use SSCAN)
- Store large values (> 1MB) in Redis
- Use SELECT to switch databases (use separate Redis instances)
- Use O(N) commands in loops
- Leave idle connections open
- Run FLUSHDB/FLUSHALL in production
- Ignore slow log warnings
- Use Redis as primary database
- Run blocking commands

## Performance Checklist

Before going to production:

- [ ] Enable connection pooling
- [ ] Set appropriate maxmemory policy
- [ ] Configure persistence (RDB + AOF)
- [ ] Set TTL on temporary keys
- [ ] Replace KEYS with SCAN
- [ ] Use pipelining for bulk operations
- [ ] Enable slow log monitoring
- [ ] Set up monitoring alerts
- [ ] Benchmark under load
- [ ] Plan for backup/restore
- [ ] Document key naming conventions
- [ ] Set maxclients appropriately
- [ ] Configure keepalive
- [ ] Enable compression (ziplist)
- [ ] Test failover procedures

## Summary

**Key Takeaways**:

✅ **Use pipelining** to reduce round trips  
✅ **Use SCAN** instead of KEYS (never block!)  
✅ **Set TTL** on temporary data  
✅ **Use hashes** for related fields  
✅ **Monitor slow log** regularly  
✅ **Use UNLINK** for large deletions  
✅ **Benchmark** before optimizing  
✅ **Connection pool** with 10-20 connections  
✅ **Lua scripts** for atomic operations  
✅ **MGET/MSET** for batch reads/writes  

Redis is fast, but you can make it 100x faster with proper usage patterns!
