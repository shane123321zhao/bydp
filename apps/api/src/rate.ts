/**
 * 共享限流计数（上线前置 #8）：部署环境（REDIS_URL）用 Redis，多实例共享窗口；本地 / 测试退回进程内。
 * 用于 postback 失败计数与投诉 / 证据按用户限流（D-015 #2）。
 */
import { MemoryRateCounter, RedisRateCounter, type RateCounter } from '@bydp/core/identity/auth';
import Redis from 'ioredis';

export function sharedRateCounter(redisUrl = process.env.REDIS_URL): RateCounter {
  return redisUrl ? new RedisRateCounter(new Redis(redisUrl, { maxRetriesPerRequest: 2 })) : new MemoryRateCounter();
}
