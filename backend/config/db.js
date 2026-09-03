const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'ssa_accounting',
  user: process.env.DB_USER || process.env.USER,
  password: process.env.DB_PASSWORD || undefined,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
});

/**
 * Execute a single query
 */
const query = async (text, params) => {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  // console.log('Executed query', { text: text.substring(0, 80), duration, rows: res.rowCount });
  return res;
};

/**
 * Execute database operations inside a safe transaction block
 * @param {Function} callback - (client) => Promise<any>
 */
const withTransaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

/**
 * Synchronize PostgreSQL sequences with current MAX(id) in tables
 * If a table is empty, sets sequence to 1 (false) so nextval returns 1
 */
const syncSequences = async (clientOrQuery = null) => {
  const tables = [
    { table: 'invoices', seq: 'invoices_id_seq' },
    { table: 'sales', seq: 'sales_id_seq' },
    { table: 'customers', seq: 'customers_id_seq' },
    { table: 'stock_items', seq: 'stock_items_id_seq' },
    { table: 'payments', seq: 'payments_id_seq' },
    { table: 'reminders_log', seq: 'reminders_log_id_seq' },
  ];

  const exec = async (text, params) => {
    if (clientOrQuery && typeof clientOrQuery.query === 'function') {
      return await clientOrQuery.query(text, params);
    }
    return await query(text, params);
  };

  for (const item of tables) {
    try {
      const res = await exec(`SELECT COALESCE(MAX(id), 0) AS max_id FROM ${item.table}`);
      const maxId = parseInt(res.rows[0].max_id, 10);
      if (maxId === 0) {
        await exec(`SELECT setval('${item.seq}', 1, false)`);
      } else {
        await exec(`SELECT setval('${item.seq}', ${maxId}, true)`);
      }
    } catch (e) {
      // ignore table or sequence lookup if not matching
    }
  }
};

module.exports = {
  pool,
  query,
  withTransaction,
  syncSequences,
};

