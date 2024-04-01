const { Server } = require("socket.io");
const { jwtVerify } = require('jose');
const cookie = require('cookie');
const { getHunterIdFromUserId } = require('./dbUtils');
const secret = new Uint8Array(Buffer.from(process.env.JWT_SECRET_KEY, 'base64'));

module.exports = (server, app) => {
    const io = new Server(server, {
        cors: {
            origin: "https://dev-noisse.vercel.app",
            methods: ["GET", "POST"],
            credentials: true
        }
    });

    io.use(async (socket, next) => {
        try {
            if (socket.handshake.headers && socket.handshake.headers.cookie) {
                const cookies = cookie.parse(socket.handshake.headers.cookie);
                const token = cookies['token'];

                if (!token) {
                    throw new Error('No token provided');
                }

                const { payload } = await jwtVerify(token, secret);
                if (!payload || !payload.user || !payload.user.id) {
                    throw new Error('Invalid token payload');
                }

                socket.user = { id: payload.user.id };
                next();
            } else {
                throw new Error('No cookie headers found');
            }
        } catch (error) {
            next(new Error('Authentication error'));
        }
    });

    const userSockets = new Map();

    io.on('connection', async (socket) => {
        console.log(`User connected: ${socket.user.id}, Socket ID: ${socket.id}`);
        try {
            const hunterId = socket.user.id;
            userSockets.set(hunterId, socket.id);
            console.log(`WebSocket connection established for hunter ID: ${hunterId} with socket ID: ${socket.id}`);
            socket.emit('notification', `Hello, your WebSocket is connected with hunter ID: ${hunterId}`);
        } catch (error) {
            console.error(`Error fetching hunter ID for user: ${socket.user.id}, error: ${error}`);
        }

        const keepAliveInterval = setInterval(() => {
            socket.emit('keep-alive', 'ping');
        }, 5000);

        socket.on('pong', () => {
            console.log(`Pong received from user ${socket.user.id}`);
        });

        socket.on('disconnect', () => {
            console.log(`User disconnected: ${socket.user.id}`);
            userSockets.delete(socket.user.id);
            clearInterval(keepAliveInterval);
        });
    });

    async function handleRedisMessage(data) {
        console.log(`Received message from Redis: ${data}`);
        try {
            const notification = JSON.parse(data);
            if (!notification || typeof notification !== 'object' || !notification.user_id || !notification.message) {
                console.error('Invalid notification format:', data);
                return;
            }
            const userIdFromRedis = parseInt(notification.user_id);
            const notificationMessage = notification.message;
    
            console.log(`Processing notification for user ${userIdFromRedis}: ${notificationMessage}`);
            
            const hunterId = await getHunterIdFromUserId(userIdFromRedis);
            if (hunterId && userSockets.has(hunterId)) {
                const socketId = userSockets.get(hunterId);
                console.log(`Emitting notification to hunter ID ${hunterId} on socket ${socketId}`);
                io.to(socketId).emit('notification', notificationMessage);
            } else {
                console.warn(`No active socket for hunter ID ${hunterId}`);
            }
        } catch (error) {
            console.error(`Error handling Redis message: ${error}`);
        }
    }

    app.set('io', io);
};
