const { Pool } = require('pg');
require('dotenv').config();

const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'ssa_accounting',
      user: process.env.DB_USER || process.env.USER,
      password: process.env.DB_PASSWORD || undefined,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
});

// Auto-check and initialize tables if not created yet (for seamless cloud deployment)
const ensureSchema = async () => {
  try {
    const tableCheck = await pool.query(`
      SELECT 1 FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'customers';
    `);
    if (tableCheck.rowCount === 0) {
      console.log('⚡ Initializing database schema for fresh deployment...');
      const fs = require('fs');
      const path = require('path');
      const schemaSql = fs.readFileSync(path.join(__dirname, '../migrations/init_schema.sql'), 'utf-8');
      await pool.query(schemaSql);
      console.log('✅ Database schema auto-initialized successfully!');
    }

    // Auto-seed default admin user if users table is empty
    const userCheck = await pool.query('SELECT COUNT(*) as count FROM users');
    if (parseInt(userCheck.rows[0].count, 10) === 0) {
      const bcrypt = require('bcryptjs');
      const salt = await bcrypt.genSalt(10);
      const defaultHash = await bcrypt.hash('admin123', salt);
      await pool.query(
        'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)',
        ['admin', defaultHash, 'admin']
      );
      console.log('✅ Default admin account auto-created: admin / admin123');
    }
  } catch (e) {
    console.warn('Schema check:', e.message);
  }
};

ensureSchema().catch((e) => console.warn('Auto-schema error:', e.message));

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
 * Dynamically resolves sequence names via pg_get_serial_sequence
 */
const syncSequences = async (clientOrQuery = null) => {
  const tableNames = [
    'users',
    'customers',
    'stock_items',
    'sales',
    'invoices',
    'payments',
    'reminders_log',
  ];

  const exec = async (text, params) => {
    if (clientOrQuery && typeof clientOrQuery.query === 'function') {
      return await clientOrQuery.query(text, params);
    }
    return await query(text, params);
  };

  for (const tableName of tableNames) {
    try {
      // Find the sequence for the primary key 'id'
      const seqRes = await exec(
        "SELECT pg_get_serial_sequence($1, 'id') AS seq_name",
        [tableName]
      );
      const seqName = seqRes.rows[0]?.seq_name || `${tableName}_id_seq`;

      if (seqName) {
        const maxRes = await exec(`SELECT COALESCE(MAX(id), 0) AS max_id FROM ${tableName}`);
        const maxId = parseInt(maxRes.rows[0]?.max_id || 0, 10);
        if (maxId === 0) {
          await exec(`SELECT setval($1, 1, false)`, [seqName]);
        } else {
          await exec(`SELECT setval($1, $2, true)`, [seqName, maxId]);
        }
      }
    } catch (e) {
      // Sequence might not exist yet if table is being created
    }
  }
};

// Initial background sync check on startup
syncSequences().catch((e) => console.warn('Initial sequence sync:', e.message));

/**
 * Convert a Date object or ISO date string to YYYY-MM-DD format for API responses.
 * Uses UTC components to avoid timezone offset issues.
 */
const formatDateForAPI = (dateInput) => {
  if (!dateInput) return null;
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

module.exports = {
  pool,
  query,
  withTransaction,
  syncSequences,
  formatDateForAPI,
};

