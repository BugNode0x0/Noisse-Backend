// redisSubscriber.js
require('dotenv').config(); 
const redis = require('redis');

// Extract the required environment variables
const { REDIS_HOST, REDIS_PORT, REDIS_PASSWORD } = process.env;

// Create a Redis client using the extracted variables
const client = redis.createClient({ 
    host: REDIS_HOST, 
    port: REDIS_PORT, 
    password: REDIS_PASSWORD,
});

client.on('connect', () => {
    console.log('Connected to Redis successfully.');
});

client.on('error', (error) => {
    console.error(`Redis error: ${error}`);
});

client.on('end', () => {
    console.log('Redis connection closed.');
});

client.on('reconnecting', () => {
    console.log('Reconnecting to Redis...');
});

client.subscribe('notification_queue', (err, count) => {
    if (err) {
        console.error('Failed to subscribe: ', err);
    } else {
        console.log(`Subscribed successfully! This client is currently subscribed to ${count} channels.`);
    }
});

client.on('message', (channel, message) => {
    console.log(`Received data from ${channel}: ${message}`);
    // Implement your message handling logic here
});

module.exports = client;
