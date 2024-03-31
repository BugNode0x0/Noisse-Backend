const { Server } = require("socket.io");
const { jwtVerify } = require('jose');
const redisSubscriber = require('./redisSubscriber');
const secret = new Uint8Array(Buffer.from(process.env.JWT_SECRET_KEY, 'base64'));

module.exports = (server, app) => {
    const io = new Server(server, {
        cors: {
            origin: "https://dev-noisse.vercel.app/",
            methods: ["GET", "POST"]
        }
    });

    io.use(async (socket, next) => {
        try {
            console.log("Received token:", socket.handshake.auth.token); // Log the received token
    
            const { payload } = await jwtVerify(socket.handshake.auth.token, secret);
            console.log("Verified payload:", payload); // Log the verified payload
    
            if (!payload || !payload.user || !payload.user.id) throw new Error('Invalid token payload');
    
            socket.user = { id: payload.user.id }; // Attach user info to the socket
            next();
        } catch (error) {
            console.error("WebSocket authentication error:", error);
            next(new Error('Authentication error'));
        }
    });

    const userSockets = new Map();

    io.on('connection', (socket) => {
        console.log(`User connected: ${socket.user.id}, Socket ID: ${socket.id}`);
        userSockets.set(socket.user.id, socket.id);

        // Send keep-alive messages every 5 seconds
        const keepAliveInterval = setInterval(() => {
            socket.emit('keep-alive', 'ping');
        }, 5000);

        // Handle ping-pong
        socket.on('pong', () => {
            console.log(`Pong received from user ${socket.user.id}`);
        });

        socket.on('disconnect', () => {
            console.log(`User disconnected: ${socket.user.id}`);
            userSockets.delete(socket.user.id);
            clearInterval(keepAliveInterval);
        });
    });

    function handleRedisMessage(channel, message) {
        console.log(`Received message on channel ${channel}: ${message}`);
        
        try {
            // Parse the incoming message
            const notification = JSON.parse(message);
    
            // Verify the message structure
            if (!notification || typeof notification !== 'object' || !notification.user_id || !notification.message) {
                throw new Error('Invalid notification format');
            }
    
            // Extract user_id and message
            const userId = notification.user_id;
            const notificationMessage = notification.message;
    
            console.log(`Processing notification for user ${userId}: ${notificationMessage}`);
    
            // Find the socket ID corresponding to the user ID
            const socketId = userSockets.get(userId);
            if (socketId) {
                console.log(`Emitting notification to user ${userId} on socket ${socketId}`);
                // Emit the notification to the specific socket
                io.to(socketId).emit('notification', notificationMessage);
            } else {
                console.log(`No active socket for user ${userId}`);
            }
        } catch (error) {
            console.error(`Error handling Redis message on channel ${channel}:`, error);
        }
    }
    
    redisSubscriber.on('message', handleRedisMessage);

    app.set('io', io);
};
