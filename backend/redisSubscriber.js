// redisSubscriber.js
const Redis = require('ioredis');
require('dotenv').config();
const { getHunterIdFromUserId } = require('./dbUtils');


const { REDIS_HOST, REDIS_PORT, REDIS_PASSWORD } = process.env;

// Create a new Redis instance for subscribing
const subscriberRedis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    password: REDIS_PASSWORD,
    retryStrategy: times => Math.min(times * 50, 2000)
});

// Create a separate Redis instance for polling and dequeuing
const pollerRedis = new Redis({
    host: REDIS_HOST,
    port: REDIS_PORT,
    password: REDIS_PASSWORD,
    retryStrategy: times => Math.min(times * 50, 2000)
});

subscriberRedis.on('connect', () => console.log('Subscriber Redis connected'));
subscriberRedis.on('error', (error) => console.error('Subscriber Redis error:', error));
subscriberRedis.on('close', () => console.log('Subscriber Redis connection closed'));
subscriberRedis.on('reconnecting', () => console.log('Reconnecting to Subscriber Redis...'));

pollerRedis.on('connect', () => console.log('Poller Redis connected'));
pollerRedis.on('error', (error) => console.error('Poller Redis error:', error));
pollerRedis.on('close', () => console.log('Poller Redis connection closed'));
pollerRedis.on('reconnecting', () => console.log('Reconnecting to Poller Redis...'));

async function startPolling(userSockets, callback) {
    async function poll() {
        try {
            const messages = await pollerRedis.lrange('notification_queue', 0, 0);
            if (messages.length > 0) {
                const message = messages[0];
                const notification = JSON.parse(message);
                const userId = notification.user_id.toString();

                const hunterId = await getHunterIdFromUserId(userId);
                if (hunterId && userSockets.has(hunterId)) {
                    await pollerRedis.lpop('notification_queue');
                    console.log(`Dequeued and processing message for hunter ID ${hunterId}`);
                    callback({ ...notification, hunterId }); // Pass hunterId in the notification object
                } else {
                    console.log(`No active socket for hunter ID ${hunterId || 'undefined'}. Message requeued.`);
                }
            }
        } catch (err) {
            console.error('Error in polling messages:', err);
        }
        setTimeout(poll, 5000); // Continue polling
    }

    poll(); // Start the polling process
}

module.exports = { subscriberRedis, startPolling };