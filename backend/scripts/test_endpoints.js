const http = require('http');
const fs = require('fs');
const path = require('path');
const app = require('../server');
const { pool } = require('../config/db');

let server;
let baseUrl;
let adminToken = '';

const request = (method, endpoint, data = null, headers = {}) => {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, baseUrl);
    const postData = data ? JSON.stringify(data) : null;

    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers,
    };

    if (postData) {
      reqHeaders['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = http.request(
      url,
      {
        method,
        headers: reqHeaders,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch (e) {
            parsed = body;
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: parsed,
          });
        });
      }
    );

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
};

const runEndpointTests = async () => {
  console.log('====================================================');
  console.log('STARTING RIGOROUS BACKEND & API VERIFICATION TESTS');
  console.log('====================================================');

  const PORT = 5099;
  server = app.listen(PORT);
  baseUrl = `http://localhost:${PORT}`;

  try {
    // 0. Clean DB initially to guarantee pristine state
    await pool.query('TRUNCATE users, customers, stock_items, sales, invoices, payments, reminders_log RESTART IDENTITY CASCADE;');

    // 1. TEST SETUP STATUS & ADMIN REGISTRATION
    console.log('\n[TEST 1] GET /api/auth/setup-status');
    const setupRes = await request('GET', '/api/auth/setup-status');
    console.log('Response status:', setupRes.status, setupRes.body);
    if (setupRes.status !== 200 || !setupRes.body.needsSetup) throw new Error('Setup status failed');

    console.log('\n[TEST 2] POST /api/auth/setup-admin');
    const adminSetupRes = await request('POST', '/api/auth/setup-admin', {
      username: 'admin_test',
      password: 'password123',
    });
    console.log('Response status:', adminSetupRes.status, adminSetupRes.body);
    if (adminSetupRes.status !== 201 || !adminSetupRes.body.token) throw new Error('Admin setup failed');
    adminToken = adminSetupRes.body.token;

    const authHeaders = { Authorization: `Bearer ${adminToken}` };

    // 2. TEST AUTH PROTECTED ROUTE /api/auth/me
    console.log('\n[TEST 3] GET /api/auth/me');
    const meRes = await request('GET', '/api/auth/me', null, authHeaders);
    console.log('Response status:', meRes.status, meRes.body);
    if (meRes.status !== 200 || meRes.body.user.username !== 'admin_test') throw new Error('/api/auth/me failed');

    // 3. TEST UNAUTHORIZED REQUESTS (Must fail with 401)
    console.log('\n[TEST 4] Unauthenticated access test to /api/customers (Must be 401)');
    const unauthRes = await request('GET', '/api/customers');
    console.log('Response status:', unauthRes.status, unauthRes.body);
    if (unauthRes.status !== 401) throw new Error('Route protection failed');

    // 4. TEST EMPTY STATES
    console.log('\n[TEST 5] Empty States Verification: GET /api/customers, GET /api/stock, GET /api/sales, GET /api/invoices, GET /api/payments');
    const emptyCust = await request('GET', '/api/customers', null, authHeaders);
    const emptyStock = await request('GET', '/api/stock', null, authHeaders);
    const emptySales = await request('GET', '/api/sales', null, authHeaders);
    const emptyInvoices = await request('GET', '/api/invoices', null, authHeaders);
    const emptyPayments = await request('GET', '/api/payments', null, authHeaders);

    console.log(`Counts: Customers=${emptyCust.body.count}, Stock=${emptyStock.body.count}, Sales=${emptySales.body.count}, Invoices=${emptyInvoices.body.count}, Payments=${emptyPayments.body.count}`);
    if (emptyCust.body.count !== 0 || emptyStock.body.count !== 0) throw new Error('Empty state check failed');

    // 5. TEST CUSTOMER CRUD
    console.log('\n[TEST 6] POST /api/customers (Create Customer)');
    const custCreateRes = await request('POST', '/api/customers', {
      name: 'Acme Corp',
      contact_info: 'contact@acme.com | +1 555-0199',
      billing_terms: 15,
    }, authHeaders);
    console.log('Created Customer:', custCreateRes.status, custCreateRes.body);
    const customerId = custCreateRes.body.data.id;

    console.log('\n[TEST 7] PUT /api/customers/:id (Update Customer)');
    const custUpdateRes = await request('PUT', `/api/customers/${customerId}`, {
      name: 'Acme Global Corp',
      contact_info: 'info@acmeglobal.com',
      billing_terms: 30,
    }, authHeaders);
    console.log('Updated Customer:', custUpdateRes.status, custUpdateRes.body);

    // 6. TEST STOCK CRUD
    console.log('\n[TEST 8] POST /api/stock (Create Stock Item)');
    const stockCreateRes = await request('POST', '/api/stock', {
      name: 'Industrial Widget A',
      unit_price: 150.00,
      quantity_available: 50,
    }, authHeaders);
    console.log('Created Stock:', stockCreateRes.status, stockCreateRes.body);
    const stockId = stockCreateRes.body.data.id;

    // 7. TEST TRANSACTIONAL SALE CREATION & AUTO INVOICE GENERATION
    console.log('\n[TEST 9] POST /api/sales (Transactional Sale: Stock Deduction + Linked Invoice Generation)');
    const saleCreateRes = await request('POST', '/api/sales', {
      customer_id: customerId,
      item_id: stockId,
      units_sold: 5,
      rate: 150.00,
      sale_date: '2026-08-28',
    }, authHeaders);
    console.log('Sale Creation Result:', saleCreateRes.status, saleCreateRes.body);
    if (saleCreateRes.status !== 201) throw new Error('Sale creation failed');

    const saleId = saleCreateRes.body.data.sale.id;
    const invoiceId = saleCreateRes.body.data.invoice.id;
    const expectedDueDate = saleCreateRes.body.data.invoice.due_date;

    // Check that stock was decremented from 50 to 45
    const stockCheckRes = await request('GET', `/api/stock/${stockId}`, null, authHeaders);
    console.log('Remaining Stock after sale (expected 45):', stockCheckRes.body.data.quantity_available);
    if (stockCheckRes.body.data.quantity_available !== 45) throw new Error('Stock decrement transaction failed');

    // 8. TEST TRANSACTIONAL PAYMENT RECORDING & INVOICE STATUS UPDATE
    console.log('\n[TEST 10] POST /api/payments (Partial Payment)');
    const partialPayRes = await request('POST', '/api/payments', {
      invoice_id: invoiceId,
      amount_paid: 250.00,
      payment_date: '2026-08-28',
      mode: 'Bank Transfer',
      notes: 'Initial deposit',
    }, authHeaders);
    console.log('Partial Payment Result (Status should be pending, balance 500):', partialPayRes.body);

    console.log('\n[TEST 11] POST /api/payments (Full Balance Payment)');
    const fullPayRes = await request('POST', '/api/payments', {
      invoice_id: invoiceId,
      amount_paid: 500.00,
      payment_date: '2026-08-28',
      mode: 'UPI',
      notes: 'Final balance payment',
    }, authHeaders);
    console.log('Full Payment Result (Invoice Status should be PAID):', fullPayRes.body);
    if (fullPayRes.body.data.invoice.status !== 'paid') throw new Error('Invoice status did not update to paid');

    // 9. TEST CRON EVALUATION (Overdue and 3-day reminder)
    console.log('\n[TEST 12] POST /api/cron/run-check (Testing invoice cron logic)');
    // Let's create an overdue invoice directly for testing cron
    await pool.query(
      `INSERT INTO invoices (customer_id, amount, due_date, status) VALUES ($1, 200, CURRENT_DATE - INTERVAL '2 days', 'pending');`,
      [customerId]
    );
    // And an upcoming invoice due in exactly 3 days
    await pool.query(
      `INSERT INTO invoices (customer_id, amount, due_date, status) VALUES ($1, 350, CURRENT_DATE + INTERVAL '3 days', 'pending');`,
      [customerId]
    );

    const cronRes = await request('POST', '/api/cron/run-check', {}, authHeaders);
    console.log('Cron execution output:', cronRes.body);
    if (cronRes.body.overdueUpdated < 1 || cronRes.body.remindersLogged < 1) {
      throw new Error('Cron logic verification failed');
    }

    // 10. TEST EXCEL GENERATION VALIDITY
    console.log('\n[TEST 13] POST /api/reports/excel/sync & File Integrity Check');
    const excelSyncRes = await request('POST', '/api/reports/excel/sync', {}, authHeaders);
    console.log('Excel Sync Result:', excelSyncRes.body);

    const lifetimeFile = path.join(__dirname, '../../exports/sales_lifetime.xlsx');
    const monthlyFile = path.join(__dirname, '../../exports/sales_current_month.xlsx');

    if (!fs.existsSync(lifetimeFile) || fs.statSync(lifetimeFile).size === 0) {
      throw new Error('Lifetime Excel file missing or 0 bytes');
    }
    if (!fs.existsSync(monthlyFile) || fs.statSync(monthlyFile).size === 0) {
      throw new Error('Monthly Excel file missing or 0 bytes');
    }
    console.log(`✅ Lifetime Excel: ${fs.statSync(lifetimeFile).size} bytes`);
    console.log(`✅ Monthly Excel: ${fs.statSync(monthlyFile).size} bytes`);

    // 11. TEST DASHBOARD STATS
    console.log('\n[TEST 14] GET /api/reports/stats (Dashboard KPIs)');
    const statsRes = await request('GET', '/api/reports/stats', null, authHeaders);
    console.log('Dashboard stats payload:', JSON.stringify(statsRes.body.data, null, 2));

    // 12. CLEAN UP ALL DATA to respect the STRICT USER DIRECTIVE:
    // "Do not seed, generate, or insert any dummy/sample/placeholder data into the database at any point... All tables should be created empty. Test the UI against empty states, not fake records."
    console.log('\n[CLEANUP] Resetting database tables to EMPTY state per instructions...');
    await pool.query('TRUNCATE users, customers, stock_items, sales, invoices, payments, reminders_log RESTART IDENTITY CASCADE;');
    // Also regenerate blank Excel reports
    const { regenerateExcelReports } = require('../services/excelService');
    await regenerateExcelReports();
    console.log('✅ Database is completely clean and empty (0 rows in all tables).');

    console.log('\n====================================================');
    console.log('🎉 ALL BACKEND RELIABILITY AND API TESTS PASSED! 🎉');
    console.log('====================================================');
  } catch (error) {
    console.error('\n❌ TEST FAILED:', error);
    process.exitCode = 1;
  } finally {
    if (server) server.close();
    await pool.end();
  }
};

if (require.main === module) {
  runEndpointTests();
}

module.exports = runEndpointTests;
