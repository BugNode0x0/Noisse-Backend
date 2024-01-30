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
  origin: 'https://noisse-frontend.vercel.app',
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

app.get('/test-auth', authenticateToken, async (req, res) => {
  const token = req.cookies.token; // Ensure you're using cookie-parser to access cookies

  if (!token) {
      return res.status(400).send('No token found in cookies');
  }

  try {
      // Replace 'https://httpbin.org/get' with the actual URL you want to request
      const response = await axios.get('https://httpbin.org/get', {
          headers: {
              'Authorization': `Bearer ${token}`
          }
      });

      // Send back the response from the external service
      res.status(200).send(response.data);
  } catch (error) {
      console.error(`Error in making the GET request: ${error}`);
      res.status(500).send('Error in making the GET request');
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

    const response = await axios.post('http://cloudnineasm.noisse.io/asm', { domain }, {
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

/// 

// DOMAIN COUNTER (REMAKE FOR ACCURACY)
app.get('/domains/count', authenticateToken, async (req, res) => {
  const interval = req.query.interval || 'week';

  let timeRangeCondition;
  switch (interval) {
    case 'week':
      timeRangeCondition = "timestamp::timestamptz >= NOW() - INTERVAL '7 days'";
      break;
    case 'biweekly':
      timeRangeCondition = "timestamp::timestamptz >= NOW() - INTERVAL '14 days'";
      break;
    case 'month':
      timeRangeCondition = "timestamp::timestamptz >= NOW() - INTERVAL '30 days'";
      break;
    default:
      // Return a default week interval if the interval query parameter doesn't match any cases
      timeRangeCondition = "timestamp::timestamptz >= NOW() - INTERVAL '7 days'";
      break;
  }

  try {
    const result = await pool.query(`SELECT COUNT(*) FROM all_domains WHERE ${timeRangeCondition}`);
    const count = result.rows && result.rows.length ? parseInt(result.rows[0].count, 10) : 0;
    res.status(200).json({ count });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).send('Internal server error');
  }
});

app.get('/domains/chart-data', authenticateToken, async (req, res) => {
  const interval = req.query.interval || 'week';
  let timeGroup = 'day'; // Default to daily stats, adjust based on interval
  
  // ... Logic to adjust timeGroup based on the interval ...

  const query = `
    SELECT DATE_TRUNC(${timeGroup}, timestamp) AS period, COUNT(*) AS count
    FROM all_domains
    GROUP BY period
    ORDER BY period
  `;

  try {
    const results = await pool.query(query);
    res.status(200).json(results.rows.map(row => ({
      name: row.period,  // Format this to your frontend needs, e.g. row.period.toISOString()
      earning: row.count
    })));
  } catch (err) {
    // ... Error handling ...
  }
});

// Get all subdomains for a domain
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
  
  let timeRangeCondition;
  switch (interval) {
    case 'week':
      timeRangeCondition = `timestamp::timestamptz >= NOW() - INTERVAL '7 days'`;
      break;
    case 'biweekly':
      timeRangeCondition = `timestamp::timestamptz >= NOW() - INTERVAL '14 days'`;
      break;
    case 'month':
      timeRangeCondition = `timestamp::timestamptz >= NOW() - INTERVAL '30 days'`;
      break;
    default:
      timeRangeCondition = `timestamp::timestamptz >= NOW() - INTERVAL '7 days'`;
      break;
  }

  try {
    const result = await pool.query(`SELECT COUNT(*) FROM dns WHERE ${timeRangeCondition}`);
    const count = result.rows[0].count ? parseInt(result.rows[0].count, 10) : 0;
    res.status(200).json({ count });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).send('Internal server error');
  }
});

app.get('/web-domains/count', authenticateToken, async (req, res) => {
  const interval = req.query.interval || 'week';

  let timeRangeCondition;
  switch (interval) {
    case 'week':
      timeRangeCondition = `timestamp::timestamptz >= NOW() - INTERVAL '7 days'`;
      break;
    case 'biweekly':
      timeRangeCondition = `timestamp::timestamptz >= NOW() - INTERVAL '14 days'`;
      break;
    case 'month':
      timeRangeCondition = `timestamp::timestamptz >= NOW() - INTERVAL '30 days'`;
      break;
    default:
      timeRangeCondition = `timestamp::timestamptz >= NOW() - INTERVAL '7 days'`; // Fallback to 'week' if the interval is not recognized
      break;
  }

  const query = `SELECT COUNT(*) FROM recon WHERE ${timeRangeCondition}`;

  try {
    const result = await pool.query(query);
    const count = result.rows[0].count ? parseInt(result.rows[0].count, 10) : 0;
    res.status(200).json({ count });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).send('Internal server error');
  }
});

app.get('/web-domains/chart-data', authenticateToken, async (req, res) => {
  const interval = req.query.interval || 'week';
  let timeGroup = 'day'; // Default group by day, adjust based on interval
  
  // Change the grouping based on the interval
  switch (interval) {
    case 'month':
      timeGroup = 'week';
      break;
    case 'year':
      timeGroup = 'month';
      break;
  }

  const query = `
    SELECT DATE_TRUNC('${timeGroup}', timestamp::timestamptz) as period, COUNT(*) as count
    FROM recon
    GROUP BY period
    ORDER BY period
  `;

  try {
    const { rows } = await pool.query(query);
    const chartData = rows.map(row => ({
      name: row.period.toISOString(), // Example conversion to ISO string
      earning: row.count
    }));
    res.status(200).json(chartData);
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).send('Internal server error');
  }
});

app.get('/active-domains/chart-data', authenticateToken, async (req, res) => {
  const interval = req.query.interval || 'week';
  let timeGroup = 'day'; // Default group by day, adjust based on interval
  
  // Change the grouping based on the interval
  switch (interval) {
    case 'month':
      timeGroup = 'week';
      break;
    case 'year':
      timeGroup = 'month';
      break;
  }

  const query = `
    SELECT DATE_TRUNC('${timeGroup}', timestamp::timestamptz) as period, COUNT(*) as count
    FROM dns
    GROUP BY period
    ORDER BY period
  `;

  try {
    const { rows } = await pool.query(query);
    const chartData = rows.map(row => ({
      name: row.period.toISOString(), // Example conversion to ISO string
      earning: row.count
    }));
    res.status(200).json(chartData);
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).send('Internal server error');
  }
});

app.get('/assets-ips/count', authenticateToken, async (req, res) => {
  const interval = req.query.interval || 'week';

  let timeRangeCondition;
  switch (interval) {
    case 'week':
      timeRangeCondition = `timestamp::timestamptz >= NOW() - INTERVAL '7 days'`;
      break;
    case 'biweekly':
      timeRangeCondition = `timestamp::timestamptz >= NOW() - INTERVAL '14 days'`;
      break;
    case 'month':
      timeRangeCondition = `timestamp::timestamptz >= NOW() - INTERVAL '30 days'`;
      break;
    default:
      timeRangeCondition = `timestamp::timestamptz >= NOW() - INTERVAL '7 days'`; // Fallback to 'week' if the interval is not recognized
      break;
  }

  const query = `SELECT COUNT(*) FROM dns WHERE ${timeRangeCondition}`;

  try {
    const result = await pool.query(query);
    const count = result.rows[0].count ? parseInt(result.rows[0].count, 10) : 0;
    res.status(200).json({ count });
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).send('Internal server error');
  }
});

app.get('/assets-ips/chart-data', authenticateToken, async (req, res) => {
  const interval = req.query.interval || 'week';
  let timeGroup = 'day'; // Default to grouping by days

  // Adjust the timeGroup based on the interval
  switch (interval) {
    case 'biweekly':
      timeGroup = 'week';
      break;
    case 'month':
      timeGroup = 'month';
      break;
    // Add more cases if necessary
  }

  // Query to get the chart data
  const chartQuery = `
    SELECT
      DATE_TRUNC('${timeGroup}', timestamp::timestamptz) as period,
      COUNT(*) as count
    FROM dns
    GROUP BY period
    ORDER BY period
  `;

  try {
    const chartResult = await pool.query(chartQuery);
    const chartData = chartResult.rows.map(row => ({
      date: row.period.toISOString(),
      count: row.count
    }));
    res.status(200).json(chartData);
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).send('Internal server error');
  }
});
///

//  GATHER DOMAINS
app.get('/subdomains', authenticateToken, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const search = req.query.search;
  const offset = (page - 1) * pageSize;

  try {
    // Base queries without WHERE clause
    let countQuery = `SELECT COUNT(*) FROM all_domains`;
    let selectQuery = `SELECT subdomain FROM all_domains ORDER BY subdomain LIMIT $1 OFFSET $2`;
    let queryParams = [pageSize, offset];

    // If search parameter is provided, append WHERE clause
    if (search) {
      countQuery += ` WHERE subdomain ILIKE $1`;
      selectQuery = `SELECT subdomain FROM all_domains WHERE subdomain ILIKE $1 ORDER BY subdomain LIMIT $2 OFFSET $3`;
      queryParams = [`%${search}%`, pageSize, offset];
    }

    const countResult = await pool.query(countQuery, search ? [`%${search}%`] : []);
    const result = await pool.query(selectQuery, queryParams);

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

// Get all unique root domains
app.get('/root-domains', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT DISTINCT root_domain FROM all_domains ORDER BY root_domain');
    res.status(200).json(result.rows.map(row => row.root_domain));
  } catch (err) {
    console.error('Database error:', err);
    res.status(500).send('Internal server error');
  }
});

// Get all active domains
app.get('/active-domains', authenticateToken, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const search = req.query.search || ''; // Get the search query parameter
  const offset = (page - 1) * pageSize;

  // Adjust your SQL query to filter based on the search term using ILIKE for case-insensitive partial matching
  const baseQuery = `FROM dns WHERE host ILIKE $1`;
  const countQuery = `SELECT COUNT(*) ${baseQuery}`;
  const selectQuery = `SELECT host ${baseQuery} ORDER BY host LIMIT $2 OFFSET $3`;
  
  try {
    // Using parameterized queries to prevent SQL injection
    const countResult = await pool.query(countQuery, [`%${search}%`]);
    const result = await pool.query(selectQuery, [`%${search}%`, pageSize, offset]);

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

// Get all web URLs
app.get('/web-domains', authenticateToken, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const search = req.query.search || '';
  const offset = (page - 1) * pageSize;

  // Determine if a search term was provided to decide which queries to use.
  let countQuery, selectQuery, queryParams;
  if (search) {
    // If there's a search term, use it as a condition in the WHERE clause.
    countQuery = `SELECT COUNT(*) FROM recon WHERE url ILIKE $1 OR title ILIKE $1`;
    selectQuery = `SELECT url, title, status_code FROM recon WHERE url ILIKE $1 OR title ILIKE $1 ORDER BY url LIMIT $2 OFFSET $3`;
    queryParams = [`%${search}%`, pageSize, offset];
  } else {
    // If there's no search term, execute the query without a WHERE clause.
    countQuery = `SELECT COUNT(*) FROM recon`;
    selectQuery = `SELECT url, title, status_code FROM recon ORDER BY url LIMIT $1 OFFSET $2`;
    queryParams = [pageSize, offset];
  }
  
  try {
    // Execute the queries using the constructed SQL and params.
    const countResult = await pool.query(countQuery, search ? [`%${search}%`] : []);
    const selectResult = await pool.query(selectQuery, queryParams);

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
  const search = req.query.search || '';
  const offset = (page - 1) * pageSize;

  // Determine if a search term was provided to decide which queries to use.
  let countQuery, selectQuery, queryParams;
  if (search) {
    // If there's a search term, use it as a condition in the WHERE clause.
    countQuery = `SELECT COUNT(*) FROM dns WHERE a ILIKE $1 OR host ILIKE $1`;
    selectQuery = `SELECT a, host, status_code FROM dns WHERE a ILIKE $1 OR host ILIKE $1 ORDER BY a LIMIT $2 OFFSET $3`;
    queryParams = [`%${search}%`, pageSize, offset];
  } else {
    // If there's no search term, execute the query without a WHERE clause.
    countQuery = `SELECT COUNT(*) FROM recon`;
    selectQuery = `SELECT a, host, status_code FROM dns ORDER BY a LIMIT $1 OFFSET $2`;
    queryParams = [pageSize, offset];
  }
  
  try {
    // Execute the queries using the constructed SQL and params.
    const countResult = await pool.query(countQuery, search ? [`%${search}%`] : []);
    const selectResult = await pool.query(selectQuery, queryParams);

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

app.get('/flaws', authenticateToken, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 10;
  const search = req.query.search || '';
  const offset = (page - 1) * pageSize;

  // Determine if a search term was provided to decide which queries to use.
  let countQuery, selectQuery, queryParams;
  if (search) {
    // If there's a search term, use it as a condition in the WHERE clause.
    countQuery = `SELECT COUNT(*) FROM threats WHERE matched_at ILIKE $1 OR severity ILIKE $1`;
    selectQuery = `SELECT matched_at, name, severity, template_id FROM threats WHERE matched_at ILIKE $1 OR name ILIKE $1 ORDER BY matched_at LIMIT $2 OFFSET $3;    `;
    queryParams = [`%${search}%`, pageSize, offset];
  } else {
    // If there's no search term, execute the query without a WHERE clause.
    countQuery = `SELECT COUNT(*) FROM threats`;
    selectQuery = `SELECT matched_at, name, severity, template_id FROM threats ORDER BY matched_at LIMIT $1 OFFSET $2`;
    queryParams = [pageSize, offset];
  }
  
  try {
    // Execute the queries using the constructed SQL and params.
    const countResult = await pool.query(countQuery, search ? [`%${search}%`] : []);
    const selectResult = await pool.query(selectQuery, queryParams);

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



const PORT = process.env.PORT || 3001;
  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
