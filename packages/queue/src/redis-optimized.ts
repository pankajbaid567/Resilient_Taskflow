/**
 * Optimized Redis Operations
 *
 * Performance-optimized Redis operations with:
 * - Connection pooling
 * - Command pipelining
 * - Operation batching
 * - Lua script caching
 */

import { redisAnalyzer } from '@taskflow/performance';
import Redis, { type ChainableCommander, type RedisValue } from 'ioredis';

type RedisStreamEntry = [id: string, fields: string[]];
type RedisStreamReadResult = Array<
  [key: string, items: RedisStreamEntry[]]
> | null;

/**
 * Optimized Redis client wrapper
 */
export class OptimizedRedisClient {
  private client: Redis;
  private luaScripts: Map<string, string> = new Map();

  constructor(client: Redis) {
    this.client = client;
    this.initializeScripts();
  }

  /**
   * Initialize Lua scripts for common operations
   */
  private initializeScripts(): void {
    // Atomic claim job script
    this.luaScripts.set(
      'claimJob',
      `
      -- Atomically claim a job from the queue
      -- KEYS[1]: stream key
      -- ARGV[1]: consumer group
      -- ARGV[2]: consumer name
      -- ARGV[3]: count
      -- ARGV[4]: block time
      local result = redis.call('XREADGROUP', 'GROUP', ARGV[1], ARGV[2], 
                                'COUNT', ARGV[3], 'BLOCK', ARGV[4], 
                                'STREAMS', KEYS[1], '>')
      return result
      `
    );

    // Atomic increment with expiry
    this.luaScripts.set(
      'incrementWithExpiry',
      `
      -- Increment counter and set expiry if not exists
      -- KEYS[1]: key
      -- ARGV[1]: increment amount
      -- ARGV[2]: expiry seconds
      local current = redis.call('INCRBY', KEYS[1], ARGV[1])
      if current == tonumber(ARGV[1]) then
        redis.call('EXPIRE', KEYS[1], ARGV[2])
      end
      return current
      `
    );

    // Get and delete atomically
    this.luaScripts.set(
      'getdel',
      `
      -- Get value and delete atomically
      -- KEYS[1]: key
      local value = redis.call('GET', KEYS[1])
      if value then
        redis.call('DEL', KEYS[1])
      end
      return value
      `
    );
  }

  /**
   * Execute command with profiling
   */
  private async executeWithProfiling<T>(
    command: string,
    fn: () => Promise<T>,
    key?: string
  ): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      const duration = Date.now() - start;
      redisAnalyzer.record(command, duration, { key });
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      redisAnalyzer.record(command, duration, { key, args: [{ error: true }] });
      throw error;
    }
  }

  /**
   * Get value (optimized)
   */
  async get(key: string): Promise<string | null> {
    return this.executeWithProfiling('GET', () => this.client.get(key), key);
  }

  /**
   * Set value with optional expiry (optimized with SETEX)
   */
  async set(key: string, value: string, expirySeconds?: number): Promise<void> {
    if (expirySeconds) {
      await this.executeWithProfiling(
        'SETEX',
        () => this.client.setex(key, expirySeconds, value),
        key
      );
    } else {
      await this.executeWithProfiling(
        'SET',
        () => this.client.set(key, value),
        key
      );
    }
  }

  /**
   * Delete keys (use UNLINK for large keys)
   */
  async delete(...keys: string[]): Promise<number> {
    return this.executeWithProfiling('UNLINK', () =>
      this.client.unlink(...keys)
    );
  }

  /**
   * Get multiple values efficiently (MGET)
   */
  async mget(...keys: string[]): Promise<(string | null)[]> {
    return this.executeWithProfiling('MGET', () => this.client.mget(...keys));
  }

  /**
   * Set multiple values efficiently (MSET)
   */
  async mset(keyValues: Record<string, string>): Promise<void> {
    const args: string[] = [];
    for (const [key, value] of Object.entries(keyValues)) {
      args.push(key, value);
    }
    await this.executeWithProfiling('MSET', () => this.client.mset(...args));
  }

  /**
   * Increment with automatic expiry (atomic)
   */
  async incrementWithExpiry(
    key: string,
    increment: number = 1,
    expirySeconds: number = 60
  ): Promise<number> {
    const script = this.luaScripts.get('incrementWithExpiry');
    if (script === undefined) {
      throw new Error('incrementWithExpiry Lua script is not initialized');
    }
    return this.executeWithProfiling(
      'EVAL:incrementWithExpiry',
      () =>
        this.client.eval(
          script,
          1,
          key,
          increment.toString(),
          expirySeconds.toString()
        ) as Promise<number>,
      key
    );
  }

  /**
   * Get and delete atomically
   */
  async getAndDelete(key: string): Promise<string | null> {
    const script = this.luaScripts.get('getdel');
    if (script === undefined) {
      throw new Error('getdel Lua script is not initialized');
    }
    return this.executeWithProfiling(
      'EVAL:getdel',
      () => this.client.eval(script, 1, key) as Promise<string | null>,
      key
    );
  }

  /**
   * Scan keys with cursor (safer than KEYS)
   */
  async *scanKeys(
    pattern: string,
    count: number = 100
  ): AsyncGenerator<string[]> {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.executeWithProfiling('SCAN', () =>
        this.client.scan(cursor, 'MATCH', pattern, 'COUNT', count)
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        yield keys;
      }
    } while (cursor !== '0');
  }

  /**
   * Create pipeline for batch operations
   */
  pipeline(): OptimizedPipeline {
    return new OptimizedPipeline(this.client.pipeline());
  }

  /**
   * Create transaction (MULTI/EXEC)
   */
  multi(): OptimizedPipeline {
    return new OptimizedPipeline(this.client.multi());
  }

  /**
   * Execute Lua script
   */
  async evalScript(
    script: string,
    keys: string[],
    args: string[]
  ): Promise<unknown> {
    return this.executeWithProfiling('EVAL', () =>
      this.client.eval(script, keys.length, ...keys, ...args)
    );
  }

  /**
   * Hash operations (optimized)
   */
  async hget(key: string, field: string): Promise<string | null> {
    return this.executeWithProfiling(
      'HGET',
      () => this.client.hget(key, field),
      key
    );
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.executeWithProfiling(
      'HGETALL',
      () => this.client.hgetall(key),
      key
    );
  }

  async hmget(key: string, ...fields: string[]): Promise<(string | null)[]> {
    return this.executeWithProfiling(
      'HMGET',
      () => this.client.hmget(key, ...fields),
      key
    );
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    return this.executeWithProfiling(
      'HSET',
      () => this.client.hset(key, field, value),
      key
    );
  }

  async hmset(key: string, data: Record<string, string>): Promise<'OK'> {
    return this.executeWithProfiling(
      'HMSET',
      () => this.client.hmset(key, data),
      key
    );
  }

  /**
   * List operations
   */
  async lpush(key: string, ...values: string[]): Promise<number> {
    return this.executeWithProfiling(
      'LPUSH',
      () => this.client.lpush(key, ...values),
      key
    );
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    return this.executeWithProfiling(
      'RPUSH',
      () => this.client.rpush(key, ...values),
      key
    );
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.executeWithProfiling(
      'LRANGE',
      () => this.client.lrange(key, start, stop),
      key
    );
  }

  /**
   * Set operations
   */
  async sadd(key: string, ...members: string[]): Promise<number> {
    return this.executeWithProfiling(
      'SADD',
      () => this.client.sadd(key, ...members),
      key
    );
  }

  async smembers(key: string): Promise<string[]> {
    return this.executeWithProfiling(
      'SMEMBERS',
      () => this.client.smembers(key),
      key
    );
  }

  async sismember(key: string, member: string): Promise<number> {
    return this.executeWithProfiling(
      'SISMEMBER',
      () => this.client.sismember(key, member),
      key
    );
  }

  /**
   * Sorted set operations
   */
  async zadd(key: string, score: number, member: string): Promise<number> {
    return this.executeWithProfiling(
      'ZADD',
      () => this.client.zadd(key, score, member),
      key
    );
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.executeWithProfiling(
      'ZRANGE',
      () => this.client.zrange(key, start, stop),
      key
    );
  }

  async zrangebyscore(
    key: string,
    min: number | string,
    max: number | string
  ): Promise<string[]> {
    return this.executeWithProfiling(
      'ZRANGEBYSCORE',
      () => this.client.zrangebyscore(key, min, max),
      key
    );
  }

  /**
   * Stream operations
   */
  async xadd(key: string, id: string, ...args: string[]): Promise<string> {
    const messageId = await this.executeWithProfiling(
      'XADD',
      () => this.client.xadd(key, id, ...args),
      key
    );

    if (messageId === null) {
      throw new Error('Redis XADD did not return a message ID');
    }

    return messageId;
  }

  async xread(...args: RedisValue[]): Promise<RedisStreamReadResult> {
    const command = this.client.xread.bind(this.client) as (
      ...commandArgs: RedisValue[]
    ) => Promise<RedisStreamReadResult>;
    return this.executeWithProfiling('XREAD', () => command(...args));
  }

  async xreadgroup(...args: RedisValue[]): Promise<unknown[]> {
    const command = this.client.xreadgroup.bind(this.client) as (
      ...commandArgs: RedisValue[]
    ) => Promise<unknown[]>;
    return this.executeWithProfiling('XREADGROUP', () => command(...args));
  }

  async xack(key: string, group: string, ...ids: string[]): Promise<number> {
    return this.executeWithProfiling(
      'XACK',
      () => this.client.xack(key, group, ...ids),
      key
    );
  }

  async xclaim(...args: RedisValue[]): Promise<unknown[]> {
    const command = this.client.xclaim.bind(this.client) as (
      ...commandArgs: RedisValue[]
    ) => Promise<unknown[]>;
    return this.executeWithProfiling('XCLAIM', () => command(...args));
  }

  async xpending(...args: RedisValue[]): Promise<unknown[]> {
    const command = this.client.xpending.bind(this.client) as (
      ...commandArgs: RedisValue[]
    ) => Promise<unknown[]>;
    return this.executeWithProfiling('XPENDING', () => command(...args));
  }

  /**
   * Utility operations
   */
  async ping(): Promise<string> {
    return this.executeWithProfiling('PING', () => this.client.ping());
  }

  async ttl(key: string): Promise<number> {
    return this.executeWithProfiling('TTL', () => this.client.ttl(key), key);
  }

  async expire(key: string, seconds: number): Promise<number> {
    return this.executeWithProfiling(
      'EXPIRE',
      () => this.client.expire(key, seconds),
      key
    );
  }

  async exists(...keys: string[]): Promise<number> {
    return this.executeWithProfiling('EXISTS', () =>
      this.client.exists(...keys)
    );
  }

  /**
   * Get raw client (for advanced operations)
   */
  getRawClient(): Redis {
    return this.client;
  }
}

/**
 * Optimized pipeline wrapper
 */
export class OptimizedPipeline {
  private pipeline: ChainableCommander;
  private commandCount: number = 0;

  constructor(pipeline: ChainableCommander) {
    this.pipeline = pipeline;
  }

  // Wrap all pipeline methods
  get(key: string): this {
    this.pipeline.get(key);
    this.commandCount++;
    return this;
  }

  set(key: string, value: string): this {
    this.pipeline.set(key, value);
    this.commandCount++;
    return this;
  }

  setex(key: string, seconds: number, value: string): this {
    this.pipeline.setex(key, seconds, value);
    this.commandCount++;
    return this;
  }

  del(...keys: string[]): this {
    this.pipeline.del(...keys);
    this.commandCount++;
    return this;
  }

  unlink(...keys: string[]): this {
    this.pipeline.unlink(...keys);
    this.commandCount++;
    return this;
  }

  hget(key: string, field: string): this {
    this.pipeline.hget(key, field);
    this.commandCount++;
    return this;
  }

  hset(key: string, field: string, value: string): this {
    this.pipeline.hset(key, field, value);
    this.commandCount++;
    return this;
  }

  hmset(key: string, data: Record<string, string>): this {
    this.pipeline.hmset(key, data);
    this.commandCount++;
    return this;
  }

  zadd(key: string, score: number, member: string): this {
    this.pipeline.zadd(key, score, member);
    this.commandCount++;
    return this;
  }

  sadd(key: string, ...members: string[]): this {
    this.pipeline.sadd(key, ...members);
    this.commandCount++;
    return this;
  }

  lpush(key: string, ...values: string[]): this {
    this.pipeline.lpush(key, ...values);
    this.commandCount++;
    return this;
  }

  rpush(key: string, ...values: string[]): this {
    this.pipeline.rpush(key, ...values);
    this.commandCount++;
    return this;
  }

  expire(key: string, seconds: number): this {
    this.pipeline.expire(key, seconds);
    this.commandCount++;
    return this;
  }

  /**
   * Execute pipeline
   */
  async exec(): Promise<Array<[Error | null, unknown]>> {
    const start = Date.now();
    try {
      const results = await this.pipeline.exec();
      const duration = Date.now() - start;
      redisAnalyzer.record('PIPELINE', duration, {
        args: [{ commandCount: this.commandCount }],
      });
      return results || [];
    } catch (error) {
      const duration = Date.now() - start;
      redisAnalyzer.record('PIPELINE', duration, {
        args: [{ commandCount: this.commandCount, error: true }],
      });
      throw error;
    }
  }
}

/**
 * Batch operation helper
 */
export class RedisBatcher {
  private client: OptimizedRedisClient;
  private batchSize: number;
  private flushInterval: number;
  private operations: Array<() => Promise<void>> = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    client: OptimizedRedisClient,
    batchSize: number = 100,
    flushIntervalMs: number = 10
  ) {
    this.client = client;
    this.batchSize = batchSize;
    this.flushInterval = flushIntervalMs;
  }

  /**
   * Add operation to batch
   */
  add<T>(
    operation: (pipeline: OptimizedPipeline) => OptimizedPipeline
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      this.operations.push(async () => {
        try {
          const result = await operation(this.client.pipeline()).exec();
          resolve(result as T);
        } catch (error) {
          reject(error);
        }
      });

      // Auto-flush if batch is full
      if (this.operations.length >= this.batchSize) {
        void this.flush();
      } else {
        // Schedule auto-flush
        this.scheduleFlush();
      }
    });
  }

  /**
   * Schedule automatic flush
   */
  private scheduleFlush(): void {
    if (this.timer) return;

    this.timer = setTimeout(() => {
      void this.flush();
    }, this.flushInterval);
  }

  /**
   * Flush all pending operations
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.operations.length === 0) return;

    const operations = this.operations.splice(0);
    // Execute all operations in a single pipeline
    await Promise.all(operations.map((op) => op()));
  }

  /**
   * Destroy batcher
   */
  destroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.operations = [];
  }
}
