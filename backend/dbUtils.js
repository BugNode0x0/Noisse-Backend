// dbUtils.js
const { Pool } = require('pg');
require('dotenv').config(); 

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

async function getHunterIdFromUserId(userId) {
  if (!userId) {
    console.error('getHunterIdFromUserId called with invalid userId:', userId);
    return null;
  }

  try {
    const query = 'SELECT hunter_id FROM users WHERE user_id = $1';
    console.log(`Executing query: ${query} with userId: ${userId}`);
    const result = await pool.query(query, [userId]);

    if (result.rows.length > 0) {
      console.log(`Found hunter_id for user_id ${userId}:`, result.rows[0].hunter_id);
      return result.rows[0].hunter_id; // Return the hunter_id
    } else {
      console.log(`User with ID ${userId} not found`);
      return null; // User not found
    }
  } catch (err) {
    console.error(`Database error while fetching hunter_id for user_id ${userId}:`, err);
    return null; // Return null in case of error
  }
}

module.exports = { getHunterIdFromUserId };
