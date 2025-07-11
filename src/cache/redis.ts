import Redis from "ioredis";

const { REDIS_HOST, REDIS_PORT, REDIS_PASSWORD, REDIS_DB, REDIS_KEY_PREFIX } = process.env;

const redis = new Redis({
  host: REDIS_HOST,
  port: parseInt(REDIS_PORT || '6379'),
  password: REDIS_PASSWORD,
  db: parseInt(REDIS_DB || '0'),
  maxRetriesPerRequest: null,
  keyPrefix: REDIS_KEY_PREFIX,
});

export { redis };