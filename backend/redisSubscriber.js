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

// Subscribe to the 'notification_queue' channel
redis.subscribe('notification_queue', (err, count) => {
    if (err) {
        console.error('Failed to subscribe: ', err);
    } else {
        console.log(`Subscribed successfully to ${count} channel(s).`);
    }
});

// Handle incoming messages
redis.on('message', (channel, message) => {
    console.log(`Received message from ${channel}: ${message}`);
    // Implement your message handling logic here
});

module.exports = redis;
