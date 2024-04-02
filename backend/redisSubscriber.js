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
        console.log('Starting new poll iteration');
        try {
            console.log('Attempting to read messages from notification_queue...');
            const messages = await pollerRedis.lrange('notification_queue', 0, 0);
            
            if (messages.length === 0) {
                console.log('No messages in queue. Will try again in 5 seconds.');
            } else {
                console.log(`Found message in queue: ${messages[0]}`);
                const notification = JSON.parse(messages[0]);
                const userId = notification.user_id;
                console.log(`Notification for user ID ${userId} being processed`);

                const hunterId = await getHunterIdFromUserId(userId);
                if (!hunterId) {
                    console.warn(`Hunter ID not found for user ID ${userId}. Requeuing message.`);
                } else if (!userSockets.has(hunterId)) {
                    console.warn(`No active socket for hunter ID ${hunterId}. Message requeued.`);
                } else {
                    console.log(`Dequeuing message for hunter ID ${hunterId}`);
                    await pollerRedis.lpop('notification_queue');
                    callback(JSON.stringify({ ...notification, hunterId }));
                }
            }
        } catch (err) {
            console.error('Error in polling messages:', err);
        } finally {
            console.log('Setting timeout for next poll iteration');
            setTimeout(poll, 5000);
        }
    }

    console.log('Initiating polling...');
    poll();
}

module.exports = { subscriberRedis, startPolling };