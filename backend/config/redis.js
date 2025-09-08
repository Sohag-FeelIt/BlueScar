const redis = require('redis');
const logger = require('../utils/logger');

let client = null;
let isConnected = false;

// Redis connection configuration
const connectRedis = async () => {
  try {
    client = redis.createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: {
        connectTimeout: 60000,
        lazyConnect: true,
        reconnectDelay: 1000
      },
      retry_strategy: (options) => {
        if (options.error && options.error.code === 'ECONNREFUSED') {
          logger.error('Redis server connection refused');
          return new Error('Redis connection refused');
        }
        if (options.total_retry_time > 1000 * 60 * 60) {
          logger.error('Redis retry time exhausted');
          return new Error('Retry time exhausted');
        }
        if (options.attempt > 10) {
          logger.error('Redis max retry attempts reached');
          return undefined;
        }
        return Math.min(options.attempt * 100, 3000);
      }
    });

    // Event listeners
    client.on('connect', () => {
      logger.info('✅ Redis client connecting...');
    });

    client.on('ready', () => {
      isConnected = true;
      logger.info('✅ Redis connected and ready');
    });

    client.on('error', (err) => {
      isConnected = false;
      logger.error(`❌ Redis error: ${err.message}`);
    });

    client.on('end', () => {
      isConnected = false;
      logger.warn('🔶 Redis connection closed');
    });

    client.on('reconnecting', () => {
      logger.info('🔄 Redis reconnecting...');
    });

    // Connect to Redis
    await client.connect();
    
  } catch (error) {
    logger.warn(`Redis connection failed: ${error.message}. Continuing without cache.`);
    client = null;
    isConnected = false;
  }
};

// Initialize Redis connection
connectRedis();

// Enhanced cache helper functions
const cache = {
  // Check if Redis is available
  isAvailable() {
    return client && isConnected;
  },

  // Get value from cache
  async get(key) {
    if (!this.isAvailable()) {
      logger.debug('Redis not available for GET operation');
      return null;
    }

    try {
      const value = await client.get(key);
      if (!value) return null;
      
      // Try to parse JSON, return as string if parsing fails
      try {
        return JSON.parse(value);
      } catch (parseError) {
        return value;
      }
    } catch (error) {
      logger.error(`Cache GET error for key "${key}": ${error.message}`);
      return null;
    }
  },

  // Set value in cache
  async set(key, value, expiration = 3600) {
    if (!this.isAvailable()) {
      logger.debug('Redis not available for SET operation');
      return false;
    }

    try {
      const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
      
      if (expiration > 0) {
        await client.setEx(key, expiration, stringValue);
      } else {
        await client.set(key, stringValue);
      }
      
      logger.debug(`Cache SET successful for key "${key}" with expiration ${expiration}s`);
      return true;
    } catch (error) {
      logger.error(`Cache SET error for key "${key}": ${error.message}`);
      return false;
    }
  },

  // Delete key(s) from cache
  async del(key) {
    if (!this.isAvailable()) {
      logger.debug('Redis not available for DEL operation');
      return false;
    }

    try {
      let deletedCount = 0;
      
      if (key.includes('*')) {
        // Handle wildcard patterns
        const keys = await client.keys(key);
        if (keys.length > 0) {
          deletedCount = await client.del(keys);
        }
      } else {
        // Handle single key
        deletedCount = await client.del(key);
      }
      
      logger.debug(`Cache DEL successful for pattern "${key}", deleted ${deletedCount} keys`);
      return deletedCount > 0;
    } catch (error) {
      logger.error(`Cache DEL error for key "${key}": ${error.message}`);
      return false;
    }
  },

  // Check if key exists
  async exists(key) {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      const result = await client.exists(key);
      return result === 1;
    } catch (error) {
      logger.error(`Cache EXISTS error for key "${key}": ${error.message}`);
      return false;
    }
  },

  // Set expiration for existing key
  async expire(key, seconds) {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      const result = await client.expire(key, seconds);
      return result === 1;
    } catch (error) {
      logger.error(`Cache EXPIRE error for key "${key}": ${error.message}`);
      return false;
    }
  },

  // Get time to live for key
  async ttl(key) {
    if (!this.isAvailable()) {
      return -1;
    }

    try {
      return await client.ttl(key);
    } catch (error) {
      logger.error(`Cache TTL error for key "${key}": ${error.message}`);
      return -1;
    }
  },

  // Increment numeric value
  async incr(key, amount = 1) {
    if (!this.isAvailable()) {
      return null;
    }

    try {
      if (amount === 1) {
        return await client.incr(key);
      } else {
        return await client.incrBy(key, amount);
      }
    } catch (error) {
      logger.error(`Cache INCR error for key "${key}": ${error.message}`);
      return null;
    }
  },

  // Add item to set
  async sadd(key, ...members) {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      const result = await client.sAdd(key, members);
      return result > 0;
    } catch (error) {
      logger.error(`Cache SADD error for key "${key}": ${error.message}`);
      return false;
    }
  },

  // Get all members of set
  async smembers(key) {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      return await client.sMembers(key);
    } catch (error) {
      logger.error(`Cache SMEMBERS error for key "${key}": ${error.message}`);
      return [];
    }
  },

  // Remove item from set
  async srem(key, ...members) {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      const result = await client.sRem(key, members);
      return result > 0;
    } catch (error) {
      logger.error(`Cache SREM error for key "${key}": ${error.message}`);
      return false;
    }
  },

  // Clear all cache (use with caution)
  async flushall() {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      await client.flushAll();
      logger.info('Cache cleared successfully');
      return true;
    } catch (error) {
      logger.error(`Cache FLUSHALL error: ${error.message}`);
      return false;
    }
  },

  // Get cache statistics
  async getStats() {
    if (!this.isAvailable()) {
      return { connected: false };
    }

    try {
      const info = await client.info('memory');
      const keyspace = await client.info('keyspace');
      
      return {
        connected: true,
        memory: info,
        keyspace: keyspace
      };
    } catch (error) {
      logger.error(`Cache STATS error: ${error.message}`);
      return { connected: false, error: error.message };
    }
  }
};

// Graceful shutdown
const shutdown = async () => {
  if (client && isConnected) {
    try {
      await client.quit();
      logger.info('Redis connection closed gracefully');
    } catch (error) {
      logger.error(`Error closing Redis connection: ${error.message}`);
    }
  }
};

// Handle process termination
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { 
  client, 
  cache, 
  connectRedis, 
  shutdown,
  isConnected: () => isConnected 
};
