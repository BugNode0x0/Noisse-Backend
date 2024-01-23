const { jwtVerify } = require('jose');

// Assuming the secret is imported or defined here
const secret = new Uint8Array(Buffer.from(process.env.JWT_SECRET_KEY, 'base64'));

const isAuthenticated = (req, res, next) => {
    const token = req.cookies.token;
    if (!token) {
        return res.status(401).send({ message: 'Not authorized' });
    }
    try {
        const verifiedToken = jwtVerify(token, secret);
        req.user = verifiedToken.payload.user;
        next();
    } catch (error) {
        res.status(401).send({ message: 'Invalid or expired token' });
    }
};

module.exports = isAuthenticated;
