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

      // Retrieve the corresponding user_id using hunter_id from 'users' table
      const userQuery = 'SELECT user_id FROM users WHERE hunter_id = $1';
      const userResult = await pool.query(userQuery, [user.id]);
      const userId = userResult.rows[0]?.user_id;

      if (!userId) {
          return res.status(404).send('User not found');
      }

      const userCheckQuery = 'SELECT stripe_customer_id FROM user_payments WHERE user_id = $1';
      const userCheckResult = await pool.query(userCheckQuery, [userId]);
      let stripeCustomerId = userCheckResult.rows.length > 0 ? userCheckResult.rows[0].stripe_customer_id : null;

      if (!stripeCustomerId) {
          const stripeCustomer = await stripe.customers.create({
              email: user.email, // or any other identifier you get from WorkOS
          });
          stripeCustomerId = stripeCustomer.id;

          const dbUserQuery = `
              INSERT INTO user_payments (user_id, stripe_customer_id, subscription_status)
              VALUES ($1, $2, 'pending') ON CONFLICT (user_id) 
              DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id;
          `;
          await pool.query(dbUserQuery, [userId, stripeCustomerId]);
      }

      // Create JWT token and set cookie
      const token = await new SignJWT({
          user,
      })
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
