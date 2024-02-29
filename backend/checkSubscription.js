const { Pool } = require('pg');

const pool = new Pool({
  // Your database configuration
});

const checkSubscription = async (req, res, next) => {
  const hunterId = req.user.id; // The hunter_id from the users table

  try {
    // Select the subscription status for the user based on the hunter_id
    const query = `
      SELECT up.subscription_status
      FROM user_payments up
      INNER JOIN users u ON up.user_id = u.user_id
      WHERE u.hunter_id = $1;
    `;
    const result = await pool.query(query, [hunterId]);
    
    // Check if the user has an active or trialing subscription
    const status = result.rows[0]?.subscription_status;
    const hasValidSubscription = status === 'active' || status === 'trialing';

    if (!hasValidSubscription) {
      return res.status(403).send('Access denied. No active or trialing subscription.');
    }

    next(); // Proceed to the next middleware/route handler
  } catch (error) {
    console.error('Subscription check error:', error);
    res.status(500).send('Internal server error');
  }
};

module.exports = checkSubscription;
