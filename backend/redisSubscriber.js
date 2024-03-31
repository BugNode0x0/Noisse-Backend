// redisSubscriber.js
require('dotenv').config();
const Redis = require('ioredis');

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

function startPolling(userSockets, callback) {
    function poll() {
        pollerRedis.lrange('notification_queue', 0, 0).then(messages => {
            if (messages.length > 0) {
                const message = messages[0];
                const notification = JSON.parse(message);
                const userId = notification.user_id.toString();

                if (userSockets.has(userId)) {
                    pollerRedis.lpop('notification_queue').then(() => {
                        console.log(`Dequeued and processing message for user ${userId}`);
                        callback(notification);
                    }).catch(err => console.error('Error dequeuing message:', err));
                } else {
                    console.log(`No active socket for user ${userId}. Message requeued.`);
                    setTimeout(poll, 5000);
                }
            } else {
                setTimeout(poll, 5000);
            }
        }).catch(err => {
            console.error('Error polling messages:', err);
            setTimeout(poll, 5000);
        });
    }

    poll();
}

module.exports = { subscriberRedis, startPolling };
