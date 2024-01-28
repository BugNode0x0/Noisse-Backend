const { jwtVerify } = require('jose');


const secret = new Uint8Array(
    Buffer.from(process.env.JWT_SECRET_KEY, 'base64')
);

async function authenticateToken(req, res, next) {
    const token = req.cookies.token; // or req.headers.authorization

    if (!token) {
        return res.status(401).json({ message: 'No token provided.' });
    }

    try {
        await jwtVerify(token, secret);
        next(); // Token is valid, proceed to the next handler
    } catch (error) {
        res.status(403).json({ message: 'Invalid or expired token.' });
    }
}

module.exports = authenticateToken;
