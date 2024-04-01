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
        const hunterId = await getHunterIdFromUserId(socket.user.id);
        if (hunterId) {
            userSockets.set(hunterId, socket.id);
            console.log(`WebSocket connection established for hunter ID: ${hunterId} with socket ID: ${socket.id}`);
            socket.emit('notification', `Hello, your WebSocket is connected with hunter ID: ${hunterId}`);
        } else {
            console.log(`No hunter ID found for user ID: ${socket.user.id}`);
        }

        const keepAliveInterval = setInterval(() => {
            socket.emit('keep-alive', 'ping');
        }, 5000);

        socket.on('pong', () => {
            console.log(`Pong received from user ${socket.user.id}`);
        });

        socket.on('disconnect', () => {
            console.log(`User disconnected: ${hunterId || socket.user.id}`);
            userSockets.delete(hunterId || socket.user.id);
            clearInterval(keepAliveInterval);
        });
    });

    // Skipping Redis message handling for now to focus on WebSocket connection setup

    app.set('io', io);
};
