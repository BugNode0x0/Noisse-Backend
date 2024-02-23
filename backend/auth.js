const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const { Pool } = require('pg');


const { WorkOS } = require('@workos-inc/node');
const cookieParser = require('cookie-parser');

const { SignJWT } = require('jose');
const { jwtVerify } = require('jose');


const secret = new Uint8Array(
    Buffer.from(process.env.JWT_SECRET_KEY, 'base64'),
  );

router.use(cookieParser());


const workos = new WorkOS(process.env.WORKOS_API_KEY);
const clientId = process.env.WORKOS_CLIENT_ID;
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});


router.get('/logout', (req, res) => {
  res.clearCookie('token', {
    path: '/',
    secure: true, 
    httpOnly: true, 
    sameSite: 'None',
  });
  res.status(200).json({ message: 'Successfully logged out' });
});


router.get('/auth', (_req, res) => {
  const authorizationUrl = workos.userManagement.getAuthorizationUrl({
    provider: 'authkit',

    redirectUri: 'https://noisse-backend-development.up.railway.app/portal/callback',
    clientId,
  });

  // Redirect the user to the AuthKit sign-in page
  res.redirect(authorizationUrl);
});


router.get('/callback', async (req, res) => {
    const code = req.query.code;
    
    try {
        const { user } = await workos.userManagement.authenticateWithCode({
            code,
            clientId,
        });
  
        // Check if the user exists in the 'users' table
        let userResult = await pool.query('SELECT user_id FROM users WHERE hunter_id = $1', [user.id]);
        let userId = userResult.rows[0]?.user_id;
  
        // If the user doesn't exist, create a new user in the 'users' table
        if (!userId) {
            await pool.query('INSERT INTO users (hunter_id) VALUES ($1)', [user.id]);
            // Re-query to get the user_id for the newly created user
            userResult = await pool.query('SELECT user_id FROM users WHERE hunter_id = $1', [user.id]);
            userId = userResult.rows[0].user_id;
        }
  
        // Check if the user has a Stripe customer ID in the 'user_payments' table
        let paymentResult = await pool.query('SELECT stripe_customer_id FROM user_payments WHERE user_id = $1', [userId]);
        let stripeCustomerId = paymentResult.rows[0]?.stripe_customer_id;
  
        // If not, create a new Stripe customer and update 'user_payments' table
        if (!stripeCustomerId) {
            const stripeCustomer = await stripe.customers.create({
                email: user.email,
            });
            stripeCustomerId = stripeCustomer.id;
  
            await pool.query(`
                INSERT INTO user_payments (user_id, stripe_customer_id, subscription_status)
                VALUES ($1, $2, 'pending')
                ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id;
            `, [userId, stripeCustomerId]);
        }
  
        // Create JWT token and set cookie
        const token = await new SignJWT({ user })
            .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
            .setIssuedAt()
            .setExpirationTime('1h')
            .sign(secret);
  
        res.cookie('token', token, {
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'None',
        });
  
        res.redirect('https://dev-noisse.vercel.app');
    } catch (error) {
        console.error('Error in /callback:', error);
        res.status(500).send('Internal server error');
    }
  });  
  

router.get('/user', async (req, res) => {
  const token = req.cookies.token;

  if (!token) {
      return res.status(401).send({ isAuthenticated: false });
  }

  try {
      const verifiedToken = await jwtVerify(token, secret);

      // Check if verifiedToken and payload are defined
      if (verifiedToken && verifiedToken.payload) {
          res.status(200).send({
              isAuthenticated: true,
              user: verifiedToken.payload.user,
          });
      } else {
          // Handle case where verifiedToken or payload is undefined
          res.status(401).send({ isAuthenticated: false, user: null });
      }
  } catch {
      res.status(401).send({ isAuthenticated: false });
  }
});

module.exports = router;
