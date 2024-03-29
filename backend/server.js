const express = require('express');
const authenticateToken = require('./authMiddleware');
const checkSubscription = require('./checkSubscription');
const { Pool } = require('pg');
const cors = require('cors');
const { exec } = require('child_process');
const { Parser } = require('json2csv');
const { createServer } = require('http'); // Ensure this is at the top with other requires
const { Server } = require('socket.io');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const Redis = require('ioredis');3
const userSockets = new Map();

// CONFIG //
require('dotenv').config(); 
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const corsOptions = {
  origin: 'https://dev-noisse.vercel.app', // Replace with your frontend domain
  methods: ['GET', 'POST'], // Specify the allowed HTTP methods
  allowedHeaders: ['Content-Type'], // Specify the allowed headers
  credentials: true // Allow sending cookies
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
    origin: "https://dev-noisse.vercel.app", 
    methods: ["GET", "POST"],
  },
  pingTimeout: 60000, // Increase the ping timeout to 60 seconds
  pingInterval: 25000 // Send a ping every 25 seconds
});

io.on('connection', (socket) => {
  console.log('a user connected');

  // Log ping messages
  socket.on('ping', () => {
    console.log('Received ping from client');
  });

  // Log pong messages
  socket.on('pong', (latency) => {
    console.log(`Received pong from client with latency: ${latency}ms`);
  });

  // Log Socket.IO errors
  socket.on('error', (error) => {
    console.error('Socket.IO error:', error);
  });

  socket.on('authenticate', (hunter_id) => {
    console.log('Websocket with authentication')
    // Validate hunter_id here if necessary
    userSockets.set(hunter_id, socket.id);
  });

  socket.on('disconnect', () => {
    for (const [hunter_id, socketId] of userSockets.entries()) {
      if (socketId === socket.id) {
        userSockets.delete(hunter_id);
        console.log(`User with hunter_id ${hunter_id} disconnected`);
        break;
      }
    }
  });
});

// Redis configuration
const redis = new Redis({
  host: process.env.REDIS_HOST, 
  port: process.env.REDIS_PORT, 
  password: process.env.REDIS_PASSWORD,
});

async function findUserSocketAndEmit(user_id, event, message) {
  try {
    // Asynchronously convert user_id to hunter_id
    const hunter_id = await convertUserIdToHunterId(user_id);

    const socketId = userSockets.get(hunter_id);
    if (socketId && io.sockets.sockets.get(socketId)) {
      io.to(socketId).emit(event, message);
    } else {
      console.error(`Socket not found for user with hunter_id ${hunter_id}`);
      // Additional error handling or notification logging can be done here
    }
  } catch (error) {
    console.error(`Error in findUserSocketAndEmit: ${error}`);
    // Implement additional error handling logic here
    // This could involve logging the error, retrying the operation, etc.
  }
}

async function convertUserIdToHunterId(user_id) {
  try {
    console.log('Converting user_id to hunter_id for user_id:', user_id);

    const result = await pool.query('SELECT hunter_id FROM users WHERE user_id = $1', [user_id]);

    console.log('Query result:', result);

    if (result.rows.length > 0) {
      const hunter_id = result.rows[0].hunter_id;
      console.log('Found hunter_id:', hunter_id);
      return hunter_id;
    } else {
      console.log('No hunter_id found for user_id:', user_id);
      throw new Error(`Hunter ID not found for user ID: ${user_id}`);
    }
  } catch (error) {
    console.error('Error converting user ID to hunter ID:', error);
    throw error; // Rethrow the error to be handled by the caller
  }
}

function processNotificationMessage(message) {
  const notificationData = JSON.parse(message);
  const { user_id, title } = notificationData;

  // Format the notification to include only the title
  const formattedNotification = {
    title: title
    // No additional fields; keeping it minimalist
  };

  findUserSocketAndEmit(user_id, 'notification', formattedNotification);
}


// Function to start listening for messages on the Redis queue
function listenForNotifications() {
  redis.blpop('notification_queue', 0, (err, [queue, message]) => {
    if (err) {
      console.error('Error listening for messages:', err);
      // Implement retry or error handling as needed
      return;
    }
    console.log(`Received message from queue ${queue}: ${message}`);
    processNotificationMessage(message);
  });
}

// Call the function to start listening for notifications
listenForNotifications();

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

    if (!stripeCustomerId) {
      return res.status(404).send('Stripe customer not found for user');
    }

    // Retrieve all subscriptions (including trials) for the customer from Stripe
    const subscriptions = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: 'all',
      expand: ['data.default_payment_method']
    });

    // Find the first subscription that is either active or trialing
    const subscription = subscriptions.data.find(sub => sub.status === 'active' || sub.status === 'trialing');

    if (!subscription) {
      return res.status(404).send('No active or trialing subscription found for user');
    }

    // Cancel the subscription on Stripe immediately
    await stripe.subscriptions.update(subscription.id, { cancel_at_period_end: false });

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
  const hunterId = req.user.id;  // This is the hunter_id from the users table

  try {
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

    // Retrieve the session to check its status
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Check if the session has a subscription with a status of 'active' or in 'trial'
    if (session.subscription) {
      const subscription = await stripe.subscriptions.retrieve(session.subscription);

      if (subscription.status === 'active' || subscription.status === 'trialing') {
        // Update subscription status in the database
        await pool.query('UPDATE user_payments SET subscription_status = $1 WHERE user_id = $2', [subscription.status, userId]);
        res.json({ message: 'Subscription updated successfully', status: subscription.status });
      } else {
        res.status(400).send('Subscription not active or trialing');
      }
    } else {
      res.status(400).send('No subscription associated with this session');
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
      // Check for both active and trialing statuses
      const status = result.rows[0].subscription_status;
      const isSubscribed = status === 'active' || status === 'trialing';
      res.json({ isSubscribed, status }); // Send back the status as well for more detailed frontend logic if needed
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


    // add http://slayer.noisse.io/monitor-domain after testing //
    const response = await axios.post('http://slayer.noisse.io:420/monitor-domain', { domain }, {
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
    io.emit('updateCounts', { type: 'discoveredDomains', count: count });
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
    io.emit('updateCounts', { type: 'activeDomains', count: count });
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
    io.emit('updateCounts', { type: 'webDomains', count: count });
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
    io.emit('updateCounts', { type: 'assetsIps', count: count });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).send('Internal server error');
  }
});


//  GATHER DOMAINS
app.get('/subdomains', authenticateToken, checkSubscription, async (req, res) => {
  const hunterId = req.user.id; // Extract hunter_id from JWT token
  const format = req.query.format;
  const search = req.query.search ? `%${req.query.search}%` : '%';

  if (format === 'csv') {
    // Fetch all subdomains for CSV export
    try {
      const selectAllQuery = `
        SELECT s.subdomain 
        FROM subdomains s
        INNER JOIN user_subdomain us ON s.subdomain_id = us.subdomain_id
        INNER JOIN users u ON us.user_id = u.user_id
        WHERE u.hunter_id = $1
          AND s.subdomain ILIKE $2
        ORDER BY s.subdomain`;

      const result = await pool.query(selectAllQuery, [hunterId, search]);
      const parser = new Parser();
      const csvData = parser.parse(result.rows);
      res.header('Content-Type', 'text/csv');
      res.attachment('subdomains.csv');
      return res.send(csvData);
    } catch (err) {
      console.error('Error converting to CSV:', err);
      return res.status(500).send('Internal Server Error');
    }
  } else {
    // Handle paginated API request
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 10;
    const offset = (page - 1) * pageSize;

    const countQuery = `
      SELECT COUNT(*) 
      FROM subdomains s
      INNER JOIN user_subdomain us ON s.subdomain_id = us.subdomain_id
      INNER JOIN users u ON us.user_id = u.user_id
      WHERE u.hunter_id = $1
        AND s.subdomain ILIKE $2`;

    const selectQuery = `
      SELECT s.subdomain 
      FROM subdomains s
      INNER JOIN user_subdomain us ON s.subdomain_id = us.subdomain_id
      INNER JOIN users u ON us.user_id = u.user_id
      WHERE u.hunter_id = $1
        AND s.subdomain ILIKE $2
      ORDER BY s.subdomain
      LIMIT $3 OFFSET $4`;

    try {
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
  }
});

app.get('/active-domains', authenticateToken, checkSubscription, async (req, res) => {
  const hunterId = req.user.id;
  const format = req.query.format;
  const search = req.query.search ? `%${req.query.search}%` : '%';

  if (format === 'csv') {
    // Fetch all active domains for CSV export
    try {
      const selectAllQuery = `
        SELECT DISTINCT dr.subdomain
        FROM dns_results dr
        INNER JOIN user_subdomain us ON dr.subdomain_id = us.subdomain_id
        INNER JOIN users u ON us.user_id = u.user_id
        WHERE u.hunter_id = $1
          AND dr.subdomain ILIKE $2
        ORDER BY dr.subdomain`;

      const result = await pool.query(selectAllQuery, [hunterId, search]);
      const parser = new Parser();
      const csvData = parser.parse(result.rows);
      res.header('Content-Type', 'text/csv');
      res.attachment('active-domains.csv');
      return res.send(csvData);
    } catch (err) {
      console.error('Error converting to CSV:', err);
      return res.status(500).send('Internal Server Error');
    }
  } else {
    // Handle paginated API request
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 10;
    const offset = (page - 1) * pageSize;

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

    try {
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
  }
});


app.get('/web-domains', authenticateToken, checkSubscription, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const search = req.query.search ? `%${req.query.search}%` : '%';
  const offset = (page - 1) * pageSize;
  const hunterId = req.user.id;
  const format = req.query.format;

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

    if (format === 'csv') {
      // Fetch all data for CSV
      const selectResult = await pool.query(selectQuery, [hunterId, search, 1000000, 0]);
      const parser = new Parser({
        fields: ['url', 'title', 'status_code', 'content_length', 'webserver', 'tech']
      });
      const csvData = parser.parse(selectResult.rows);
      res.header('Content-Type', 'text/csv');
      res.attachment('web-domains.csv');
      return res.send(csvData);
    }

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
  const hunterId = req.user.id; // Extract hunter_id from JWT token
  const format = req.query.format;
  const search = req.query.search ? `%${req.query.search}%` : '%';

  if (format === 'csv') {
    // Fetch all IPs for CSV export without pagination
    try {
      const selectAllQuery = `
        SELECT dr.subdomain, dr.ip, dr.status_code
        FROM dns_results dr
        INNER JOIN user_subdomain us ON dr.subdomain_id = us.subdomain_id
        INNER JOIN users u ON us.user_id = u.user_id
        WHERE u.hunter_id = $1 AND (dr.subdomain ILIKE $2 OR dr.ip ILIKE $2)
        ORDER BY dr.subdomain`;

      const result = await pool.query(selectAllQuery, [hunterId, search]);
      const parser = new Parser({
        fields: ['subdomain', 'ip', 'status_code'] // Define the fields you want to include in the CSV
      });
      const csvData = parser.parse(result.rows);
      res.header('Content-Type', 'text/csv');
      res.attachment('assets-ips.csv');
      return res.send(csvData);
    } catch (err) {
      console.error('Error converting to CSV:', err);
      return res.status(500).send('Internal Server Error');
    }
  } else {
    // Handle paginated API request for standard JSON response
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 10;
    const offset = (page - 1) * pageSize;

    const countQuery = `
      SELECT COUNT(DISTINCT dr.dns_id)
      FROM dns_results dr
      INNER JOIN user_subdomain us ON dr.subdomain_id = us.subdomain_id
      INNER JOIN users u ON us.user_id = u.user_id
      WHERE u.hunter_id = $1 AND (dr.subdomain ILIKE $2 OR dr.ip ILIKE $2)`;
    
    const selectQuery = `
      SELECT dr.subdomain, dr.ip, dr.status_code
      FROM dns_results dr
      INNER JOIN user_subdomain us ON dr.subdomain_id = us.subdomain_id
      INNER JOIN users u ON us.user_id = u.user_id
      WHERE u.hunter_id = $1 AND (dr.subdomain ILIKE $2 OR dr.ip ILIKE $2)
      ORDER BY dr.subdomain
      LIMIT $3 OFFSET $4`;

    try {
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
  }
});


app.get('/web-domains', authenticateToken, checkSubscription, async (req, res) => {
  const hunterId = req.user.id;
  const format = req.query.format;
  const search = req.query.search ? `%${req.query.search}%` : '%';

  if (format === 'csv') {
    // Fetch all web domain data for CSV export
    try {
      const selectAllQuery = `
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
        ORDER BY hr.url`;

      const result = await pool.query(selectAllQuery, [hunterId, search]);
      const parser = new Parser({
        fields: ['url', 'title', 'status_code', 'content_length', 'webserver', 'tech']
      });
      const csvData = parser.parse(result.rows);
      res.header('Content-Type', 'text/csv');
      res.attachment('web-domains.csv');
      return res.send(csvData);
    } catch (err) {
      console.error('Error converting to CSV:', err);
      return res.status(500).send('Internal Server Error');
    }
  } else {
    // Handle paginated API request
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 10;
    const offset = (page - 1) * pageSize;

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

    try {
      const countResult = await pool.query(countQuery, [hunterId, search]);
      const result = await pool.query(selectQuery, [hunterId, search, pageSize, offset]);

      res.status(200).json({
        webDomains: result.rows,
        total: parseInt(countResult.rows[0].count),
        page,
        pageSize,
      });
    } catch (err) {
      console.error('Database error:', err);
      res.status(500).send('Internal server error');
    }
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
  const hunterId = req.user.id;
  const format = req.query.format;
  const search = req.query.search ? `%${req.query.search}%` : '%';

  if (format === 'csv') {
    // Fetch all data for CSV
    try {
      const selectAllQuery = `
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
          u.hunter_id = $1 AND (jr.url ILIKE $2)
        GROUP BY
          s.subdomain
        ORDER BY
          s.subdomain`;
  
      const result = await pool.query(selectAllQuery, [hunterId, search]);
      const parser = new Parser();
      const csvData = parser.parse(result.rows.map(row => ({ subdomain: row.subdomain, urls: row.urls.join(', ')})));
      res.header('Content-Type', 'text/csv');
      res.attachment('jsview.csv');
      return res.send(csvData);
    } catch (err) {
      console.error('Error converting to CSV:', err);
      return res.status(500).send('Internal Server Error');
    }
  
  } else {
    // Paginated response for non-CSV requests
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 10;
    const offset = (page - 1) * pageSize;

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
        u.hunter_id = $1 AND (jr.url ILIKE $2)
      GROUP BY
        s.subdomain
      ORDER BY
        s.subdomain
      LIMIT $3 OFFSET $4`;

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
        u.hunter_id = $1 AND (jr.url ILIKE $2)`;

    try {
      const [selectResult, countResult] = await Promise.all([
        pool.query(selectQuery, [hunterId, search, pageSize, offset]),
        pool.query(countQuery, [hunterId, search])
      ]);
      const totalItems = parseInt(countResult.rows[0].total, 10);

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
