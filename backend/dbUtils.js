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
  try {
      const query = 'SELECT hunter_id FROM users WHERE user_id = $1';
      const result = await pool.query(query, [userId]);
      if (result.rows.length > 0) {
          return result.rows[0].hunter_id; // Return the hunter_id
      } else {
          console.log(`User with ID ${userId} not found`);
          return null; // User not found
      }
  } catch (err) {
      console.error(`Database error while fetching hunter_id for user_id ${userId}:`, err);
      throw err; // Rethrow the error for caller to handle
  }
}

module.exports = { getHunterIdFromUserId };
