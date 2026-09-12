/**
 * @taskflow/queue
 *
 * Redis Streams queue engine built from first principles.
 *
 * Key Components:
 * - Producer: Enqueue jobs to streams
 * - Consumer: Consume jobs with consumer groups
 * - Consumer Groups: Manage distributed workers
 * - Acknowledgement: Track processed messages
 * - Stale Message Recovery: Reclaim from dead workers
 */

// Redis Client
export {
  getRedisClient,
  createRedisClient,
  testRedisConnection,
  closeRedisConnection,
  createPipeline,
  createTransaction,
  initRedis,
} from './redis-client';

// Stream Naming
export {
  JOB_STREAM_PREFIX,
  JOB_STREAM_SUFFIX,
  WORKER_CONSUMER_GROUP,
  WORKER_CONSUMER_PREFIX,
  getStreamKey,
  getConsumerGroupName,
  getConsumerName,
  parseQueueFromStreamKey,
} from './stream-names';

// Producer
export {
  enqueueJob,
  enqueueJobBatch,
  getQueueDepth,
  trimStream,
} from './producer';

// Consumer Groups
export {
  createConsumerGroup,
  createConsumerGroups,
  deleteConsumerGroup,
  getConsumerGroupInfo,
  getConsumers,
  deleteConsumer,
} from './consumer-group';

// Consumer
export {
  consumeJobs,
  acknowledgeMessage,
  acknowledgeMessageBatch,
  getPendingMessages,
  claimStaleMessages,
  getPendingCount,
  resetReclaimCursor,
} from './consumer';

export type { ConsumedMessage } from './consumer';

// Quarantine
export { quarantineEntry } from './quarantine';
