const { Server } = require("socket.io");
const { jwtVerify } = require('jose');

const secret = new Uint8Array(Buffer.from(process.env.JWT_SECRET_KEY, 'base64'));

module.exports = (server) => {
    const io = new Server(server, {
        cors: {
            origin: "https://dev-noisse.vercel.app/",
            methods: ["GET", "POST"]
        }
    });

    io.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth.token;
            if (!token) throw new Error('No token provided');

            const { payload } = await jwtVerify(token, secret);
            if (!payload || !payload.user || !payload.user.id) throw new Error('Invalid token payload');

            socket.user = { id: payload.user.id }; // Attach user info to the socket
            next();
        } catch (error) {
            next(new Error('Authentication error'));
        }
    });

    io.on('connection', (socket) => {
        console.log(`User connected: ${socket.user.id}`);

        // Send keep-alive messages every 5 seconds
        const keepAliveInterval = setInterval(() => {
            socket.emit('keep-alive', 'ping');
        }, 5000);

        // Handle ping-pong
        socket.on('pong', () => {
            console.log(`Pong received from ${socket.user.id}`);
        });

        socket.on('disconnect', () => {
            console.log(`User disconnected: ${socket.user.id}`);
            clearInterval(keepAliveInterval);
        });
    });
};
