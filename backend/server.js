const express = require('express');
const authenticateToken = require('./authMiddleware');
const checkSubscription = require('./checkSubscription');
const { Pool } = require('pg');
const cors = require('cors');
const { exec } = require('child_process');
const { createServer } = require('http'); // Ensure this is at the top with other requires
const { Server } = require('socket.io');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');



// CONFIG //
require('dotenv').config(); 
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const corsOptions = {
  origin: 'https://dev-noisse.vercel.app',
  credentials: true, // to allow sending of cookies
  methods: ['GET', 'POST', /* other HTTP methods you use */]
};
app.use(cors(corsOptions));


const authRoutes = require('./auth');
app.use(express.json());
app.use(cookieParser());
app.use('/portal', authRoutes);


const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: "*", // Be sure to set correct origins in production, don't use '*' as it's insecure
    methods: ["GET", "POST"],
  },
});

io.on('connection', (socket) => {
  console.log('a user connected');
  socket.on('disconnect', () => {
    console.log('user disconnected');
  });
});

// Stripe Payments


app.post('/cancel-subscription', authenticateToken, async (req, res) => {
  const hunterId = req.user.id; // This is the hunter_id from the users table

  try {
    // Retrieve user's Stripe customer ID from your database
    const customerQueryResult = await pool.query(
      'SELECT stripe_customer_id FROM user_payments WHERE user_id = (SELECT user_id FROM users WHERE hunter_id = $1)',
      [hunterId]
    );
    const stripeCustomerId = customerQueryResult.rows[0]?.stripe_customer_id;

    console.log('Stripe Customer ID:', stripeCustomerId); // Added log

    if (!stripeCustomerId) {
      return res.status(404).send('Stripe customer not found for user');
    }

    // Retrieve all active subscriptions for the customer from Stripe
    const subscriptions = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: 'all', // Changed from 'active' to 'all' to debug
      limit: 1, // Add a limit to the query to only fetch one for simplicity
    });

    console.log('Subscriptions:', subscriptions.data); // Added log

    const activeSubscription = subscriptions.data.find(sub => sub.status === 'active');

    if (!activeSubscription) {
      return res.status(404).send('Active Stripe subscription not found for user');
    }

    // Cancel the subscription on Stripe
    await stripe.subscriptions.del(activeSubscription.id); // Changed to .del as per Stripe API

    // Update your database to reflect the cancellation
    await pool.query(
      'UPDATE user_payments SET subscription_status = $1 WHERE stripe_customer_id = $2',
      ['canceled', stripeCustomerId]
    );

    // Respond to the client that the cancellation was successful
    res.status(200).json({ message: 'Subscription cancelled successfully' });
  } catch (err) {
    console.error('Stripe cancellation error:', err);
    res.status(500).send('Internal server error');
  }
});


app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (request, response) => {
  const sigHeader = request.headers['stripe-signature'];
  let event;

  try {
      event = stripe.webhooks.constructEvent(request.body, sigHeader, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
      console.error(`Webhook Error: ${err.message}`);
      return response.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
      switch (event.type) {
          case 'customer.subscription.created':
          case 'customer.subscription.updated':
          case 'customer.subscription.deleted':
              const subscription = event.data.object;
              // Update the subscription status in your database
              await pool.query('UPDATE user_payments SET subscription_status = $1 WHERE stripe_customer_id = $2', [subscription.status, subscription.customer]);
              break;
          case 'invoice.payment_succeeded':
              const invoice = event.data.object;
              // Update last_payment_date only when payment succeeds
              await pool.query('UPDATE user_payments SET last_payment_date = NOW() WHERE stripe_customer_id = $1', [invoice.customer]);
              break;
          case 'invoice.payment_failed':
              // You can handle payment failure logic here
              break;
          // Add more cases as needed for other events
          default:
              console.log(`Unhandled event type ${event.type}`);
      }
  } catch (err) {
      console.error(`Error handling event ${event.type}: ${err.message}`, err);
      return response.status(500).send('Internal Server Error');
  }

  response.json({ received: true });
});

app.post('/create-checkout-session', authenticateToken, async (req, res) => {
  try {
    const hunterId = req.user.id; // Get WorkOS ID from authenticated user
    const { couponCode } = req.body;

    // Query the users table to get user_id
    const userResult = await pool.query('SELECT user_id FROM users WHERE hunter_id = $1', [hunterId]);
    const userId = userResult.rows[0]?.user_id;

    if (!userId) {
      return res.status(404).send('User not found');
    }

    // Query the user_payments table to get stripe_customer_id
    const paymentResult = await pool.query('SELECT stripe_customer_id FROM user_payments WHERE user_id = $1', [userId]);
    const stripeCustomerId = paymentResult.rows[0]?.stripe_customer_id;

    if (!stripeCustomerId) {
      return res.status(404).send('Stripe customer not found for user');
    }

    // Prepare session parameters
    const sessionParams = {
      payment_method_types: ['card'],
      customer: stripeCustomerId,
      line_items: [{
        price: 'price_1OmqzqEexrrszXdmQu9X9ACY', // Your price ID
        quantity: 1,
      }],
      subscription_data: {
        trial_period_days: 7, // Set the trial period to 7 days
      },
      allow_promotion_codes: true,
      mode: 'subscription',
      success_url: `https://dev-noisse.vercel.app/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://dev-noisse.vercel.app/payment-cancelled`,
    };

    // Add coupon code if provided
    if (couponCode) {
      sessionParams.subscription_data.discounts = [{coupon: couponCode}];
    }

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create(sessionParams);

    res.json({ sessionId: session.url });
  } catch (err) {
    console.error('Error creating checkout session:', err);
    res.status(500).send('Internal Server Error');
  }
});

app.post('/finalize-subscription', authenticateToken, async (req, res) => {
  const hunterId = req.user.id;
  
  // Retrieve user_id using hunter_id
  const userResult = await pool.query('SELECT user_id FROM users WHERE hunter_id = $1', [hunterId]);
  const userId = userResult.rows[0]?.user_id;

  if (!userId) {
    return res.status(404).send('User not found');
  }

  // Assuming the checkout session ID is passed in the request body
  const sessionId = req.body.sessionId;
  if (!sessionId) {
    return res.status(400).send('Session ID is missing');
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status === 'paid') {
      // Update subscription status in the database
      await pool.query('UPDATE user_payments SET subscription_status = $1 WHERE user_id = $2', ['active', userId]);
      res.json({ message: 'Subscription activated successfully' });
    } else {
      res.status(400).send('Payment not successful');
    }
  } catch (err) {
    console.error('Error in /finalize-subscription:', err);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/subscription-status', authenticateToken, async (req, res) => {
  try {
    const hunterId = req.user.id; // The hunter_id from the users table

    // Query the database for the user's subscription status by joining the users table
    const query = `
      SELECT up.subscription_status 
      FROM user_payments up
      INNER JOIN users u ON up.user_id = u.user_id
      WHERE u.hunter_id = $1;
    `;

    const result = await pool.query(query, [hunterId]);
    
    if (result.rows.length > 0) {
      const isSubscribed = result.rows[0].subscription_status === 'active';
      res.json({ isSubscribed });
    } else {
      res.status(404).send('Subscription information not found.');
    }
  } catch (error) {
    console.error('Error fetching subscription status:', error);
    res.status(500).send('Internal server error');
  }
});



////

app.get('/get-user-id', authenticateToken, (req, res) => {
  // Assuming authenticateToken middleware adds a 'user' object to 'req'
  if (req.user && req.user.id) {
    // Send back the user ID as a response
    res.status(200).json({ userId: req.user.id });
  } else {
    // If user ID is not present, send an error response
    res.status(401).json({ error: 'User ID could not be extracted' });
  }
});

///
app.post('/domains/enumerate', authenticateToken, checkSubscription, async (req, res) => {
  const { domain } = req.body;
  const token = req.cookies.token; // Assuming you're using cookie-parser

  if (!token) {
    return res.status(401).send('No authentication token found');
  }

  try {
    // Split the JWT into its parts
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Token is invalid');
    }

    // Decode the payload from Base64Url
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    const decodedPayload = JSON.parse(payload);

    // Extract the user ID from the decoded payload
    const userId = decodedPayload.user.id;

    const response = await axios.post('http://slayer.noisse.io/monitor-domain', { domain }, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'X-User-ID': userId 
        }
    });
    res.status(200).send(response.data);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    res.status(500).send('Error processing the request');
  }
});


app.get('/domains/count', authenticateToken, checkSubscription, async (req, res) => {
  const interval = req.query.interval || 'week';
  const hunterId = req.user.id; // Extract hunter_id from JWT token

  let timeRangeCondition;
  switch (interval) {
    case 'week':
      timeRangeCondition = "us.discovered_at::timestamptz >= NOW() - INTERVAL '7 days'";
      break;
    case 'biweekly':
      timeRangeCondition = "us.discovered_at::timestamptz >= NOW() - INTERVAL '14 days'";
      break;
    case 'month':
      timeRangeCondition = "us.discovered_at::timestamptz >= NOW() - INTERVAL '30 days'";
      break;
    default:
      timeRangeCondition = "us.discovered_at::timestamptz >= NOW() - INTERVAL '7 days'";
      break;
  }

  try {
    const query = `
      SELECT COUNT(*) 
      FROM user_subdomain us
      INNER JOIN users u ON us.user_id = u.user_id
      WHERE ${timeRangeCondition} AND u.hunter_id = $1
    `;
    const result = await pool.query(query, [hunterId]);
    const count = result.rows && result.rows.length ? parseInt(result.rows[0].count, 10) : 0;
    res.status(200).json({ count });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).send('Internal server error');
  }
});

// Get all subdomains for a domain (CHECK BEFORE USE)
app.get('/domains/:domain', authenticateToken, checkSubscription, async (req, res) => {

  const { domain } = req.params;
  const page = parseInt(req.query.page) || 1; // Default to page 1 if not specified
  const pageSize = parseInt(req.query.pageSize) || 10; // Default to 10 if not specified
  const offset = (page - 1) * pageSize;

  try {
    const result = await pool.query(
      'SELECT subdomain FROM all_domains WHERE root_domain = $1 LIMIT $2 OFFSET $3',
      [domain, pageSize, offset]
    );
    
    // Additionally, you will need to get the total count for the domain
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM all_domains WHERE root_domain = $1',
      [domain]
    );

    res.status(200).json({
      subdomains: result.rows,
      total: parseInt(countResult.rows[0].count), // Parse count to integer
      page,
      pageSize
    });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).send('Internal server error');
  }
});

app.get('/active-domains/count', authenticateToken, checkSubscription, async (req, res) => {
  const interval = req.query.interval || 'week';
  const hunterId = req.user.id; // Extract hunter_id from JWT token

  let timeRangeCondition;
  switch (interval) {
    case 'week':
      timeRangeCondition = `dr.timestamp::timestamptz >= NOW() - INTERVAL '7 days'`;
      break;
    case 'biweekly':
      timeRangeCondition = `dr.timestamp::timestamptz >= NOW() - INTERVAL '14 days'`;
      break;
    case 'month':
      timeRangeCondition = `dr.timestamp::timestamptz >= NOW() - INTERVAL '30 days'`;
      break;
    default:
      timeRangeCondition = `dr.timestamp::timestamptz >= NOW() - INTERVAL '7 days'`;
      break;
  }

  try {
    const query = `
      SELECT COUNT(DISTINCT dr.dns_id) 
      FROM dns_results dr
      INNER JOIN user_subdomain us ON dr.subdomain_id = us.subdomain_id
      INNER JOIN users u ON us.user_id = u.user_id
      WHERE ${timeRangeCondition} AND u.hunter_id = $1
    `;
    const result = await pool.query(query, [hunterId]);
    const count = result.rows[0].count ? parseInt(result.rows[0].count, 10) : 0;
    res.status(200).json({ count });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).send('Internal server error');
  }
});

app.get('/web-domains/count', authenticateToken, checkSubscription, async (req, res) => {
  const interval = req.query.interval || 'week';
  const hunterId = req.user.id; // Extract hunter_id from JWT token

  let timeRangeCondition;
  switch (interval) {
    case 'week':
      timeRangeCondition = `hr.timestamp::timestamptz >= NOW() - INTERVAL '7 days'`;
      break;
    case 'biweekly':
      timeRangeCondition = `hr.timestamp::timestamptz >= NOW() - INTERVAL '14 days'`;
      break;
    case 'month':
      timeRangeCondition = `hr.timestamp::timestamptz >= NOW() - INTERVAL '30 days'`;
      break;
    default:
      timeRangeCondition = `hr.timestamp::timestamptz >= NOW() - INTERVAL '7 days'`;
      break;
  }

  try {
    const query = `
      SELECT COUNT(DISTINCT hr.http_id) 
      FROM http_results hr
      INNER JOIN user_subdomain us ON hr.subdomain_id = us.subdomain_id
      INNER JOIN users u ON us.user_id = u.user_id
      WHERE ${timeRangeCondition} AND u.hunter_id = $1
    `;
    const result = await pool.query(query, [hunterId]);
    const count = result.rows[0].count ? parseInt(result.rows[0].count, 10) : 0;
    res.status(200).json({ count });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).send('Internal server error');
  }
});

app.get('/assets-ips/count', authenticateToken, checkSubscription, async (req, res) => {
  const interval = req.query.interval || 'week';
  const hunterId = req.user.id; // Extract hunter_id from JWT token

  let timeRangeCondition;
  switch (interval) {
    case 'week':
      timeRangeCondition = `dr.timestamp::timestamptz >= NOW() - INTERVAL '7 days'`;
      break;
    case 'biweekly':
      timeRangeCondition = `dr.timestamp::timestamptz >= NOW() - INTERVAL '14 days'`;
      break;
    case 'month':
      timeRangeCondition = `dr.timestamp::timestamptz >= NOW() - INTERVAL '30 days'`;
      break;
    default:
      timeRangeCondition = `dr.timestamp::timestamptz >= NOW() - INTERVAL '7 days'`;
      break;
  }

  try {
    const query = `
      SELECT COUNT(DISTINCT dr.ip)
      FROM dns_results dr
      INNER JOIN user_subdomain us ON dr.subdomain_id = us.subdomain_id
      INNER JOIN users u ON us.user_id = u.user_id
      WHERE ${timeRangeCondition} AND u.hunter_id = $1
    `;
    const result = await pool.query(query, [hunterId]);
    const count = result.rows[0].count ? parseInt(result.rows[0].count, 10) : 0;
    res.status(200).json({ count });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).send('Internal server error');
  }
});


//  GATHER DOMAINS
app.get('/subdomains', authenticateToken, checkSubscription, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const search = req.query.search ? `%${req.query.search}%` : '%';
  const offset = (page - 1) * pageSize;
  const hunterId = req.user.id; // Extract hunter_id from JWT token

  try {
    let countQuery = `
      SELECT COUNT(*) 
      FROM subdomains s
      INNER JOIN user_subdomain us ON s.subdomain_id = us.subdomain_id
      INNER JOIN users u ON us.user_id = u.user_id
      WHERE u.hunter_id = $1
        AND s.subdomain ILIKE $2`;
    let selectQuery = `
      SELECT s.subdomain 
      FROM subdomains s
      INNER JOIN user_subdomain us ON s.subdomain_id = us.subdomain_id
      INNER JOIN users u ON us.user_id = u.user_id
      WHERE u.hunter_id = $1
        AND s.subdomain ILIKE $2
      ORDER BY s.subdomain
      LIMIT $3 OFFSET $4`;

    const countResult = await pool.query(countQuery, [hunterId, search]);
    const result = await pool.query(selectQuery, [hunterId, search, pageSize, offset]);

    res.status(200).json({
      subdomains: result.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      pageSize,
    });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).send('Internal server error');
  }
});

app.get('/active-domains', authenticateToken, checkSubscription, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const search = req.query.search ? `%${req.query.search}%` : '%';
  const offset = (page - 1) * pageSize;
  const hunterId = req.user.id; // Extract hunter_id from JWT token

  try {
    const countQuery = `
      SELECT COUNT(DISTINCT dr.subdomain)
      FROM dns_results dr
      INNER JOIN user_subdomain us ON dr.subdomain_id = us.subdomain_id
      INNER JOIN users u ON us.user_id = u.user_id
      WHERE u.hunter_id = $1
        AND dr.subdomain ILIKE $2`;
    const selectQuery = `
      SELECT DISTINCT dr.subdomain
      FROM dns_results dr
      INNER JOIN user_subdomain us ON dr.subdomain_id = us.subdomain_id
      INNER JOIN users u ON us.user_id = u.user_id
      WHERE u.hunter_id = $1
        AND dr.subdomain ILIKE $2
      ORDER BY dr.subdomain
      LIMIT $3 OFFSET $4`;

    const countResult = await pool.query(countQuery, [hunterId, search]);
    const result = await pool.query(selectQuery, [hunterId, search, pageSize, offset]);

    res.status(200).json({
      activeDomains: result.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      pageSize,
    });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).send('Internal server error');
  }
});

app.get('/web-domains', authenticateToken, checkSubscription, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const search = req.query.search ? `%${req.query.search}%` : '%';
  const offset = (page - 1) * pageSize;
  const hunterId = req.user.id; // Extract hunter_id from JWT token

  try {
    const selectQuery = `
      SELECT DISTINCT hr.url, hr.title, hr.status_code, hr.content_length, hr.webserver, hr.tech
      FROM http_results hr
      INNER JOIN user_subdomain us ON hr.subdomain_id = us.subdomain_id
      INNER JOIN users u ON us.user_id = u.user_id
      WHERE u.hunter_id = $1
      AND (
        hr.url ILIKE $2 OR 
        hr.title ILIKE $2 OR 
        hr.status_code::text ILIKE $2 OR 
        hr.content_length::text ILIKE $2 OR
        hr.webserver ILIKE $2 OR
        hr.tech ILIKE $2
      )
      ORDER BY hr.url
      LIMIT $3 OFFSET $4`;

    const countQuery = `
      SELECT COUNT(DISTINCT hr.url)
      FROM http_results hr
      INNER JOIN user_subdomain us ON hr.subdomain_id = us.subdomain_id
      INNER JOIN users u ON us.user_id = u.user_id
      WHERE u.hunter_id = $1
      AND (
        hr.url ILIKE $2 OR 
        hr.title ILIKE $2 OR 
        hr.status_code::text ILIKE $2 OR 
        hr.content_length::text ILIKE $2 OR
        hr.webserver ILIKE $2 OR
        hr.tech ILIKE $2
      )`;

    const countResult = await pool.query(countQuery, [hunterId, search]);
    const selectResult = await pool.query(selectQuery, [hunterId, search, pageSize, offset]);

    res.status(200).json({
      webDomains: selectResult.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      pageSize
    });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).send('Internal server error');
  }
});

app.get('/assets-ips', authenticateToken, checkSubscription, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const search = req.query.search ? `%${req.query.search}%` : '%';
  const offset = (page - 1) * pageSize;
  const hunterId = req.user.id; // Extract hunter_id from JWT token

  try {
    const countQuery = `
      SELECT COUNT(DISTINCT dr.dns_id)
      FROM dns_results dr
      INNER JOIN user_subdomain us ON dr.subdomain_id = us.subdomain_id
      INNER JOIN users u ON us.user_id = u.user_id
      WHERE u.hunter_id = $1
        AND (dr.subdomain ILIKE $2 OR dr.ip ILIKE $2)`;
    const selectQuery = `
      SELECT dr.subdomain, dr.ip, dr.status_code
      FROM dns_results dr
      INNER JOIN user_subdomain us ON dr.subdomain_id = us.subdomain_id
      INNER JOIN users u ON us.user_id = u.user_id
      WHERE u.hunter_id = $1
        AND (dr.subdomain ILIKE $2 OR dr.ip ILIKE $2)
      ORDER BY dr.subdomain
      LIMIT $3 OFFSET $4`;

    const countResult = await pool.query(countQuery, [hunterId, search]);
    const selectResult = await pool.query(selectQuery, [hunterId, search, pageSize, offset]);

    res.status(200).json({
      assetsIps: selectResult.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      pageSize
    });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).send('Internal server error');
  }
});

app.get('/webview', authenticateToken, checkSubscription, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const search = req.query.search ? `%${req.query.search}%` : '%';
  const offset = (page - 1) * pageSize;
  const hunterId = req.user.id;

  try {
    // Query to get the screenshots for the current page
    const selectQuery = `
      SELECT DISTINCT ON (sr.screenshot_id) sr.screenshot_id, 
      sr.url as website_url, 
      sr.screenshot_url, 
      sr.timestamp,
      hr.url as http_url, 
      hr.title, 
      hr.status_code, 
      hr.content_length, 
      hr.webserver, 
      hr.tech
    FROM screenshot_results sr
    INNER JOIN http_results hr ON sr.subdomain_id = hr.subdomain_id
    WHERE (
      sr.url ILIKE $2 OR 
      hr.url ILIKE $2 OR 
      hr.title ILIKE $2 OR 
      hr.content_length::text ILIKE $2 OR
      hr.status_code::text ILIKE $2
    )
    AND sr.screenshot_url IS NOT NULL
    AND EXISTS (
        SELECT 1 FROM user_subdomain us
        INNER JOIN users u ON us.user_id = u.user_id
        WHERE u.hunter_id = $1 AND us.subdomain_id = sr.subdomain_id
    )
    ORDER BY sr.screenshot_id, sr.timestamp DESC
    LIMIT $3 OFFSET $4
    `;

    // Query to count the total number of distinct screenshots
    const totalQuery = `
      SELECT COUNT(DISTINCT sr.screenshot_id) as total 
      FROM screenshot_results sr
      INNER JOIN http_results hr ON sr.subdomain_id = hr.subdomain_id
      WHERE (sr.url ILIKE $2 OR hr.url ILIKE $2 OR hr.title ILIKE $2)
      AND sr.screenshot_url IS NOT NULL
      AND EXISTS (
          SELECT 1 FROM user_subdomain us
          INNER JOIN users u ON us.user_id = u.user_id
          WHERE u.hunter_id = $1 AND us.subdomain_id = sr.subdomain_id
    )
    `;

    // Execute both queries
    const [selectResult, totalResult] = await Promise.all([
      pool.query(selectQuery, [hunterId, search, pageSize, offset]),
      pool.query(totalQuery, [hunterId, search])
    ]);

    // Send back the results and the total count
    res.status(200).json({
      webview: selectResult.rows,
      total: parseInt(totalResult.rows[0].total, 10), // Parse the total count to an integer
      page,
      pageSize
    });

  } catch (err) {
    console.error('Database error:', err);
    res.status(500).send('Internal server error');
  }
});


app.get('/jsview', authenticateToken, checkSubscription, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const search = req.query.search ? `%${req.query.search}%` : '%';
  const offset = (page - 1) * pageSize;
  const hunterId = req.user.id;

  try {
    // Select query to fetch the data
    const selectQuery = `
      SELECT
      s.subdomain,
      ARRAY_AGG(jr.url ORDER BY jr.timestamp DESC) as urls
    FROM
      js_results jr
    INNER JOIN
      user_subdomain us ON jr.subdomain_id = us.subdomain_id
    INNER JOIN
      users u ON us.user_id = u.user_id
    INNER JOIN
      subdomains s ON jr.subdomain_id = s.subdomain_id
    WHERE
      u.hunter_id = $1
      AND (jr.url ILIKE $2)
    GROUP BY
      s.subdomain
    ORDER BY
      s.subdomain
    LIMIT $3 OFFSET $4`;

    // Count query to get the total number of matching entries
    const countQuery = `
      SELECT
      COUNT(DISTINCT s.subdomain) as total
    FROM
      js_results jr
    INNER JOIN
      user_subdomain us ON jr.subdomain_id = us.subdomain_id
    INNER JOIN
      users u ON us.user_id = u.user_id
    INNER JOIN
      subdomains s ON jr.subdomain_id = s.subdomain_id
    WHERE
      u.hunter_id = $1
      AND (jr.url ILIKE $2)`;

    // Execute both the select and count queries
    const [selectResult, countResult] = await Promise.all([
      pool.query(selectQuery, [hunterId, search, pageSize, offset]),
      pool.query(countQuery, [hunterId, search])
    ]);

    // Extract the total count from the count query result
    const totalItems = parseInt(countResult.rows[0].total, 10);

    // Send back the results and the total count
    res.status(200).json({
      jsview: selectResult.rows,
      total: totalItems,
      page,
      pageSize
    });
    
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).send('Internal server error');
  }
});


// Slack integration
app.get('/user/webhook', authenticateToken, async (req, res) => {
  const hunterId = req.user.id; // Extract hunter_id from JWT token

  try {
    const query = `
      SELECT uw.webhook_url
      FROM user_webhooks uw
      INNER JOIN users u ON uw.user_id = u.user_id
      WHERE u.hunter_id = $1
    `;
    const result = await pool.query(query, [hunterId]);
    const webhookUrl = result.rows.length > 0 ? result.rows[0].webhook_url : null;
    res.status(200).json({ webhookUrl });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).send('Internal server error');
  }
});

app.post('/user/webhook', authenticateToken, async (req, res) => {
  const hunterId = req.user.id; // Extract hunter_id from JWT token
  const { webhookUrl } = req.body;

  try {
    const query = `
      INSERT INTO user_webhooks (user_id, webhook_url)
      SELECT user_id, $2
      FROM users
      WHERE hunter_id = $1
      ON CONFLICT (user_id)
      DO UPDATE SET webhook_url = EXCLUDED.webhook_url;
    `;
    await pool.query(query, [hunterId, webhookUrl]);
    res.status(200).send('Webhook updated successfully');
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).send('Internal server error');
  }
});


const PORT = process.env.PORT || 3001;
  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
