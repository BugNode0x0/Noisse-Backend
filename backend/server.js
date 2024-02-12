const express = require('express');
const authenticateToken = require('./authMiddleware');
const { Pool } = require('pg');
const cors = require('cors');
const { exec } = require('child_process');
const { createServer } = require('http'); // Ensure this is at the top with other requires
const { Server } = require('socket.io');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');


// CONFIG //
require('dotenv').config(); 

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


app.get('/db-check', authenticateToken, async (req, res) => {
  try {
    // Try to get a connection from the pool
    const client = await pool.connect();

    // If successful, release the client back to the pool and send a success response
    client.release();
    res.status(200).send('Database connection is successful');
  } catch (err) {
    // If an error occurs, send an error response
    console.error('Database connection error:', err);
    res.status(500).send('Failed to connect to the database');
  }
});


///
app.post('/domains/enumerate', async (req, res) => {
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


app.get('/domains/count', authenticateToken, async (req, res) => {
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
app.get('/domains/:domain', authenticateToken, async (req, res) => {

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

app.get('/active-domains/count', authenticateToken, async (req, res) => {
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

app.get('/web-domains/count', authenticateToken, async (req, res) => {
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

app.get('/assets-ips/count', authenticateToken, async (req, res) => {
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
app.get('/subdomains', authenticateToken, async (req, res) => {
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

app.get('/active-domains', authenticateToken, async (req, res) => {
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

app.get('/web-domains', authenticateToken, async (req, res) => {
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
        AND (hr.url ILIKE $2 OR hr.title ILIKE $2)
      ORDER BY hr.url
      LIMIT $3 OFFSET $4`;

    const countQuery = `
      SELECT COUNT(DISTINCT hr.url)
      FROM http_results hr
      INNER JOIN user_subdomain us ON hr.subdomain_id = us.subdomain_id
      INNER JOIN users u ON us.user_id = u.user_id
      WHERE u.hunter_id = $1
        AND (hr.url ILIKE $2 OR hr.title ILIKE $2)`;

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

// 
app.get('/assets-ips', authenticateToken, async (req, res) => {
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

// Screenshot implementation
app.get('/webview', authenticateToken, async (req, res) => {
  // Extract the hunter_id from the authenticated user
  const hunterId = req.user.hunter_id; // Assuming the JWT decoding middleware adds this to req.user

  const query = `
    SELECT 
      sr.screenshot_id, 
      sr.url as screenshot_url, 
      sr.screenshot, 
      sr.dom, 
      sr.timestamp,
      hr.url, 
      hr.title, 
      hr.status_code, 
      hr.content_length, 
      hr.webserver, 
      hr.tech
    FROM 
      screenshot_results sr
    JOIN 
      http_results hr ON sr.subdomain_id = hr.subdomain_id
    JOIN 
      subdomains s ON sr.subdomain_id = s.subdomain_id
    JOIN 
      user_subdomain us ON s.subdomain_id = us.subdomain_id
    JOIN 
      users u ON us.user_id = u.user_id
    WHERE 
      u.hunter_id = $1
  `;

  try {
    const result = await pool.query(query, [hunterId]);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).send('Internal server error');
  }
});



const PORT = process.env.PORT || 3001;
  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
