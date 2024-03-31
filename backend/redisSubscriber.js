// redisSubscriber.js
require('dotenv').config();
const Redis = require('ioredis');

// Extract the required environment variables
const { REDIS_HOST, REDIS_PORT, REDIS_PASSWORD } = process.env;

// Create a new Redis instance
const redis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    password: REDIS_PASSWORD,
    retryStrategy: times => Math.min(times * 50, 2000)
});

redis.on('connect', () => {
    console.log('Connected to Redis successfully.');
});

redis.on('error', (error) => {
    console.error(`Redis error: ${error}`);
});

redis.on('close', () => {
    console.log('Redis connection closed.');
});

redis.on('reconnecting', () => {
    console.log('Reconnecting to Redis...');
});

function pollMessages(callback) {
    redis.brpop('notification_queue', 0).then(message => {
      if (message) {
        const [queue, data] = message;
        console.log(`Received message from ${queue}: ${data}`);
        // Pass the data to the callback
        callback(data);
      }
    
      // Continue polling
      setImmediate(() => pollMessages(callback));
    }).catch(err => {
      console.error('Error polling messages:', err);
      // Retry polling after a delay
      setTimeout(() => pollMessages(callback), 5000);
    });
  }
  
  module.exports = { redis, pollMessages };
