const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
  
  const checkSubscription = async (req, res, next) => {
    const hunterId = req.user.id; // Assuming user ID is set in previous middleware
  
    try {
      const query = `
        SELECT up.subscription_status 
        FROM user_payments up
        INNER JOIN users u ON up.user_id = u.user_id
        WHERE u.hunter_id = $1;
      `;
      const result = await pool.query(query, [hunterId]);
      const hasActiveSubscription = result.rows[0]?.subscription_status === 'active';
  
      if (!hasActiveSubscription) {
        return res.status(403).send('Access denied. No active subscription.');
      }
  
      next(); // Proceed to the next middleware/route handler
    } catch (error) {
      console.error('Subscription check error:', error);
      res.status(500).send('Internal server error');
    }
  };
  
  module.exports = checkSubscription;