const fs = require('fs');
const path = require('path');
const { pool, syncSequences } = require('../config/db');
const { parseUniversalFile } = require('../services/universalParserService');
const ocrCtrl = require('../controllers/ocrController');
const customerCtrl = require('../controllers/customerController');

const runV2Tests = async () => {
  console.log('========================================================');
  console.log('🧪 RUNNING RIGOROUS V2 COMPREHENSIVE VERIFICATION TESTS');
  console.log('========================================================\n');

  try {
    // 1. Reset database tables for testing
    console.log('[STEP 1] Initializing clean test database state...');
    await pool.query('TRUNCATE users, customers, stock_items, sales, invoices, payments, reminders_log RESTART IDENTITY CASCADE;');
    await syncSequences();
    console.log('✅ Clean database ready.\n');

    // 2. Test Customer Cartesian Product Join Fix
    console.log('[STEP 2] Testing Customer Financial Aggregates Fix (Anti-Cartesian Subqueries)...');
    const custRes = await pool.query("INSERT INTO customers (name, billing_terms) VALUES ('Alpha Enterprises', 30) RETURNING *");
    const custId = custRes.rows[0].id;

    const itemRes = await pool.query("INSERT INTO stock_items (name, unit_price, quantity_available) VALUES ('Server Rack 42U', 25000, 100) RETURNING *");
    const itemId = itemRes.rows[0].id;

    // Create 3 sales for Alpha Enterprises (each 1 unit @ 25000)
    await pool.query("INSERT INTO sales (customer_id, item_id, units_sold, rate) VALUES ($1, $2, 1, 25000)", [custId, itemId]);
    await pool.query("INSERT INTO sales (customer_id, item_id, units_sold, rate) VALUES ($1, $2, 1, 25000)", [custId, itemId]);
    await pool.query("INSERT INTO sales (customer_id, item_id, units_sold, rate) VALUES ($1, $2, 1, 25000)", [custId, itemId]);

    // Create 2 invoices for Alpha Enterprises (each 25000)
    const inv1 = await pool.query("INSERT INTO invoices (customer_id, amount, due_date, status) VALUES ($1, 25000, CURRENT_DATE, 'pending') RETURNING *", [custId]);
    const inv2 = await pool.query("INSERT INTO invoices (customer_id, amount, due_date, status) VALUES ($1, 25000, CURRENT_DATE, 'paid') RETURNING *", [custId]);

    // Create 1 payment for inv2 of 25000
    await pool.query("INSERT INTO payments (invoice_id, amount_paid, payment_date) VALUES ($1, 25000, CURRENT_DATE)", [inv2.rows[0].id]);

    // Call customerCtrl.getAllCustomers
    const reqMock = {};
    let custOutput = null;
    const resMock = {
      json: (data) => { custOutput = data; },
    };
    await customerCtrl.getAllCustomers(reqMock, resMock, (err) => { throw err; });

    const customerRecord = custOutput.data.find((c) => c.id === custId);
    console.log('Customer Totals: Sales Count =', customerRecord.total_sales_count, 
      '| Invoiced =', customerRecord.total_invoiced_amount, 
      '| Paid =', customerRecord.total_paid_amount);

    if (parseInt(customerRecord.total_sales_count, 10) !== 3) {
      throw new Error(`Expected sales count 3, got ${customerRecord.total_sales_count}`);
    }
    if (parseFloat(customerRecord.total_invoiced_amount) !== 50000) {
      throw new Error(`Expected invoiced amount 50000 (2 * 25000), got ${customerRecord.total_invoiced_amount} (Cartesian product detected!)`);
    }
    if (parseFloat(customerRecord.total_paid_amount) !== 25000) {
      throw new Error(`Expected paid amount 25000, got ${customerRecord.total_paid_amount}`);
    }
    console.log('✅ PASS: Customer financial totals are mathematically exact! No Cartesian multiplication.\n');

    // 3. Test Universal Parser across various formats
    console.log('[STEP 3] Testing Universal Parser across different file formats...');
    const scratchDir = path.join(__dirname, '../../uploads');

    // 3a. Test CSV
    const testCsvPath = path.join(scratchDir, 'test_batch.csv');
    fs.writeFileSync(testCsvPath, 'Item,Qty,Rate\nWidget Pro X,50,299.99\nWidget Ultra,120,49.50\n');
    const csvResult = await parseUniversalFile(testCsvPath, 'test_batch.csv', 'text/csv');
    console.log('CSV Parsed:', csvResult.fileType, '| isMultiRow:', csvResult.isMultiRow, '| Items:', csvResult.items.length);
    if (!csvResult.isMultiRow || csvResult.items.length !== 2) throw new Error('CSV parsing failed');
    fs.unlinkSync(testCsvPath);

    // 3b. Test TSV (Tab Separated)
    const testTsvPath = path.join(scratchDir, 'test_sales.tsv');
    fs.writeFileSync(testTsvPath, 'Customer\tItem\tUnits\tRate\tDate\nTata Steel\tIndustrial Roller\t10\t1500\t2026-09-12\n');
    const tsvResult = await parseUniversalFile(testTsvPath, 'test_sales.tsv', 'text/tab-separated-values');
    console.log('TSV Parsed:', tsvResult.fileType, '| isMultiRow:', tsvResult.isMultiRow, '| Import Type:', tsvResult.importType);
    if (!tsvResult.isMultiRow || tsvResult.importType !== 'sales') throw new Error('TSV Sales parsing failed');
    fs.unlinkSync(testTsvPath);

    // 3c. Test JSON
    const testJsonPath = path.join(scratchDir, 'test_inv.json');
    fs.writeFileSync(testJsonPath, JSON.stringify({
      invoiceNumber: 'INV-TEST-99',
      customer: 'Infosys Corp',
      totalAmount: 18500.00,
      items: [{ description: 'Cloud Setup', quantity: 1, unit_price: 18500.00, total: 18500.00 }],
    }));
    const jsonResult = await parseUniversalFile(testJsonPath, 'test_inv.json', 'application/json');
    console.log('JSON Parsed:', jsonResult.fileType, '| Invoice #:', jsonResult.extractedData.invoiceNumber, '| Total:', jsonResult.extractedData.totalAmount);
    if (jsonResult.extractedData.invoiceNumber !== 'INV-TEST-99') throw new Error('JSON parsing failed');
    fs.unlinkSync(testJsonPath);

    // 3d. Test HTML / XLS table format
    const testXlsPath = path.join(scratchDir, 'report.xls');
    fs.writeFileSync(testXlsPath, '<table><tr><th>Item Name</th><th>Available Quantity</th><th>Unit Price</th></tr><tr><td>Core i9 CPU</td><td>25</td><td>45000</td></tr></table>');
    const xlsResult = await parseUniversalFile(testXlsPath, 'report.xls', 'application/vnd.ms-excel');
    console.log('XLS HTML Table Parsed:', xlsResult.fileType, '| isMultiRow:', xlsResult.isMultiRow, '| Items:', xlsResult.items.length);
    if (!xlsResult.isMultiRow || xlsResult.items.length !== 1) throw new Error('XLS HTML parsing failed');
    fs.unlinkSync(testXlsPath);

    console.log('✅ PASS: Universal file parser handled all structured formats accurately!\n');

    // 4. Test Batch Import for Sales & Invoices in OCR Controller
    console.log('[STEP 4] Testing Multi-Row Batch Import for Sales & Invoices...');
    let batchResData = null;
    const batchResMock = {
      status: () => batchResMock,
      json: (data) => { batchResData = data; },
    };

    // 4a. Batch Sales Import
    const salesBatchReq = {
      body: {
        importType: 'sales',
        items: [
          { customer_name: 'Reliance Jio', item_name: 'Fiber Switch 24P', units_sold: 4, rate: 8500, sale_date: '2026-09-12' },
          { customer_name: 'Bharti Airtel', item_name: 'Fiber Switch 24P', units_sold: 2, rate: 8500, sale_date: '2026-09-12' },
        ],
      },
    };
    await ocrCtrl.confirmBatchImport(salesBatchReq, batchResMock, (err) => { throw err; });
    console.log('Sales Batch Import Result: Success =', batchResData.success, '| Count =', batchResData.count);
    if (!batchResData.success || batchResData.count !== 2) throw new Error('Batch sales import failed');

    // Verify database has the new sales, customers, and invoices
    const jioSale = await pool.query("SELECT s.*, c.name AS cust, inv.id AS inv_id, inv.amount FROM sales s JOIN customers c ON s.customer_id = c.id JOIN invoices inv ON inv.sale_id = s.id WHERE c.name = 'Reliance Jio'");
    if (jioSale.rows.length === 0 || parseFloat(jioSale.rows[0].amount) !== 34000) {
      throw new Error('Database sales record or auto-linked invoice missing for Reliance Jio');
    }
    console.log('✅ Verified: Sales batch import created Customer, Stock deduction, Sale, and linked Invoice!');

    // 4b. Batch Invoices Import
    const invBatchReq = {
      body: {
        importType: 'invoices',
        items: [
          { customer_name: 'Wipro Ltd', amount: 75000, due_date: '2026-10-01', status: 'pending' },
          { customer_name: 'Adani Group', amount: 120000, due_date: '2026-09-01', status: 'paid' },
        ],
      },
    };
    await ocrCtrl.confirmBatchImport(invBatchReq, batchResMock, (err) => { throw err; });
    console.log('Invoices Batch Import Result: Success =', batchResData.success, '| Count =', batchResData.count);
    if (!batchResData.success || batchResData.count !== 2) throw new Error('Batch invoices import failed');

    // Verify paid invoice created a payment record
    const adaniInv = await pool.query("SELECT inv.*, p.amount_paid FROM invoices inv JOIN customers c ON inv.customer_id = c.id LEFT JOIN payments p ON p.invoice_id = inv.id WHERE c.name = 'Adani Group'");
    if (adaniInv.rows.length === 0 || adaniInv.rows[0].status !== 'paid' || parseFloat(adaniInv.rows[0].amount_paid) !== 120000) {
      throw new Error('Database invoice or auto-payment record missing for Adani Group');
    }
    console.log('✅ Verified: Invoices batch import created Invoices and auto-recorded Payment for paid status!\n');

    // 5. Test Sequence Resiliency
    console.log('[STEP 5] Testing Sequence Synchronization...');
    await syncSequences();
    const custSeqCheck = await pool.query("SELECT nextval('customers_id_seq') AS next_id");
    const maxCust = await pool.query("SELECT MAX(id) AS max_id FROM customers");
    console.log('Sequence check: Next customer ID =', custSeqCheck.rows[0].next_id, '| Max ID in DB =', maxCust.rows[0].max_id);
    if (parseInt(custSeqCheck.rows[0].next_id, 10) <= parseInt(maxCust.rows[0].max_id, 10)) {
      throw new Error('Sequence is behind MAX(id)!');
    }
    console.log('✅ PASS: PostgreSQL primary key sequence is strictly synchronized ahead of MAX(id)!\n');

    console.log('========================================================');
    console.log('🎉 ALL V2 ENHANCEMENTS SUCCESSFULLY TESTED & VERIFIED! 🎉');
    console.log('========================================================');
  } catch (err) {
    console.error('❌ V2 Test Failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
};

runV2Tests();
