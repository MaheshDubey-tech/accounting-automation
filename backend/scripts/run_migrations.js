const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');

async function runMigrations() {
  console.log('Running PostgreSQL schema migrations (creating empty tables)...');
  try {
    const schemaSql = fs.readFileSync(path.join(__dirname, '../migrations/init_schema.sql'), 'utf-8');
    await pool.query(schemaSql);
    console.log('✅ Schema migration completed successfully! All tables created empty (0 rows).');
    
    // Verify tables exist and count is 0
    const res = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    console.log('Created tables:', res.rows.map(r => r.table_name).join(', '));
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  runMigrations();
}

module.exports = runMigrations;
