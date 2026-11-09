const { neon } = require('@neondatabase/serverless');

console.log('DATABASE_URL available in database.js:', Boolean(process.env.DATABASE_URL));

const sql = neon(process.env.DATABASE_URL);

module.exports = sql;