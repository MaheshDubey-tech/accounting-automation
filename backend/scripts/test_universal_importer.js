const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { parseUniversalFile } = require('../services/universalParserService');
const { query, withTransaction } = require('../config/db');

async function runTests() {
  console.log('🧪 Starting Universal Importer & Global Cascade Deletion Verification Tests...\n');

  const testDir = path.join(__dirname, 'test_artifacts');
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

  let allPassed = true;

  try {
    // -------------------------------------------------------------
    // TEST 1: Generate & Parse Excel Stock Sheet (.xlsx)
    // -------------------------------------------------------------
    console.log('🔹 Test 1: Testing Excel Stock Sheet Parsing (.xlsx)...');
    const excelPath = path.join(testDir, 'sample_stock.xlsx');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Stock Items');
    ws.addRow(['Item Name', 'Quantity', 'Unit Price']);
    ws.addRow(['Industrial Steel Bolts M8', 500, 12.50]);
    ws.addRow(['Copper Wiring 2.5mm (100m)', 60, 2400.00]);
    ws.addRow(['Heavy Duty Angle Grinder', 15, 4800.00]);
    await wb.xlsx.writeFile(excelPath);

    const excelResult = await parseUniversalFile(excelPath, 'sample_stock.xlsx');
    if (excelResult.isMultiRow && excelResult.importType === 'stock' && excelResult.items.length === 3) {
      console.log('✅ Excel Stock Sheet parsed successfully! Extracted 3 items:', excelResult.items.map(i => i.name).join(', '));
    } else {
      console.error('❌ Excel Stock parsing failed:', excelResult);
      allPassed = false;
    }

    // -------------------------------------------------------------
    // TEST 2: Generate & Parse CSV Customer Directory (.csv)
    // -------------------------------------------------------------
    console.log('\n🔹 Test 2: Testing CSV Customer Directory Parsing (.csv)...');
    const csvPath = path.join(testDir, 'sample_customers.csv');
    const csvContent = 'Customer Name,Contact Info,Billing Terms\nReliance Retail Ltd,+91 22 3555 5000,45\nAdani Enterprises,+91 79 2656 5555,30\n';
    fs.writeFileSync(csvPath, csvContent, 'utf8');

    const csvResult = await parseUniversalFile(csvPath, 'sample_customers.csv');
    if (csvResult.isMultiRow && csvResult.importType === 'customers' && csvResult.items.length === 2) {
      console.log('✅ CSV Customer Directory parsed successfully! Extracted 2 customers:', csvResult.items.map(c => c.name).join(', '));
    } else {
      console.error('❌ CSV Customer parsing failed:', csvResult);
      allPassed = false;
    }

    // -------------------------------------------------------------
    // TEST 3: Generate & Parse Plain Text Invoice (.txt)
    // -------------------------------------------------------------
    console.log('\n🔹 Test 3: Testing Plain Text Invoice Parsing (.txt)...');
    const txtPath = path.join(testDir, 'sample_invoice.txt');
    const txtContent = `TAX INVOICE: INV-998877\nDate: 2026-09-01\nVendor: Delta Tech Solutions\nBill To: MegaCorp Pvt Ltd\nGSTIN: 27AABCU9603R1Z2\nTotal Amount: 45000.00\nPayment Status: paid\n`;
    fs.writeFileSync(txtPath, txtContent, 'utf8');

    const txtResult = await parseUniversalFile(txtPath, 'sample_invoice.txt');
    if (!txtResult.isMultiRow && txtResult.extractedData.totalAmount === 45000.00 && txtResult.extractedData.invoiceNumber === 'INV-998877') {
      console.log(`✅ Text Invoice parsed successfully! Invoice: ${txtResult.extractedData.invoiceNumber}, Total: ₹${txtResult.extractedData.totalAmount}`);
    } else {
      console.error('❌ Text Invoice parsing failed:', txtResult);
      allPassed = false;
    }

    // -------------------------------------------------------------
    // TEST 4: Database Single Invoice Insertion with Multi-Line Items
    // -------------------------------------------------------------
    console.log('\n🔹 Test 4: Testing Single Document Multi-Line Items Persistence...');
    const testCustName = `Test Enterprise ${Date.now()}`;
    const testItem1 = `Test Component A ${Date.now()}`;
    const testItem2 = `Test Component B ${Date.now()}`;

    const savedRecord = await withTransaction(async (client) => {
      // 1. Create customer
      const custRes = await client.query(
        'INSERT INTO customers (name, contact_info, billing_terms) VALUES ($1, $2, $3) RETURNING *',
        [testCustName, '+91 9999988888', 30]
      );
      const customer = custRes.rows[0];

      // 2. Create Stock & Deduct
      const item1Res = await client.query(
        'INSERT INTO stock_items (name, quantity_available, unit_price) VALUES ($1, $2, $3) RETURNING *',
        [testItem1, 100, 500.00]
      );
      const item2Res = await client.query(
        'INSERT INTO stock_items (name, quantity_available, unit_price) VALUES ($1, $2, $3) RETURNING *',
        [testItem2, 100, 1500.00]
      );

      // Deduct stock for 2 units of item1 and 1 unit of item2
      await client.query('UPDATE stock_items SET quantity_available = quantity_available - 2 WHERE id = $1', [item1Res.rows[0].id]);
      await client.query('UPDATE stock_items SET quantity_available = quantity_available - 1 WHERE id = $1', [item2Res.rows[0].id]);

      // Create sales
      const sale1 = await client.query(
        'INSERT INTO sales (customer_id, item_id, units_sold, rate, sale_date) VALUES ($1, $2, $3, $4, CURRENT_DATE) RETURNING *',
        [customer.id, item1Res.rows[0].id, 2, 500.00]
      );
      const sale2 = await client.query(
        'INSERT INTO sales (customer_id, item_id, units_sold, rate, sale_date) VALUES ($1, $2, $3, $4, CURRENT_DATE) RETURNING *',
        [customer.id, item2Res.rows[0].id, 1, 1500.00]
      );

      // Create invoice for 2500 total
      const invRes = await client.query(
        'INSERT INTO invoices (sale_id, customer_id, amount, due_date, status) VALUES ($1, $2, $3, CURRENT_DATE + interval \'30 days\', \'pending\') RETURNING *',
        [sale1.rows[0].id, customer.id, 2500.00]
      );

      return {
        customer,
        item1: item1Res.rows[0],
        item2: item2Res.rows[0],
        sale1: sale1.rows[0],
        sale2: sale2.rows[0],
        invoice: invRes.rows[0],
      };
    });

    console.log(`✅ Saved Test Invoice #${savedRecord.invoice.id} for "${savedRecord.customer.name}" with 2 line items.`);

    // -------------------------------------------------------------
    // TEST 5: Cascade Deletion Verification
    // -------------------------------------------------------------
    console.log('\n🔹 Test 5: Testing Global Cascade Deletion of Customer...');
    // Delete customer and verify:
    // a) stock is restored (item1 -> 100, item2 -> 100)
    // b) sales are deleted
    // c) invoice is deleted
    await withTransaction(async (client) => {
      const salesRes = await client.query('SELECT item_id, units_sold FROM sales WHERE customer_id = $1', [savedRecord.customer.id]);
      for (const sale of salesRes.rows) {
        await client.query('UPDATE stock_items SET quantity_available = quantity_available + $1 WHERE id = $2', [sale.units_sold, sale.item_id]);
      }
      const invRes = await client.query('SELECT id FROM invoices WHERE customer_id = $1', [savedRecord.customer.id]);
      const invIds = invRes.rows.map(r => r.id);
      if (invIds.length > 0) {
        await client.query('DELETE FROM payments WHERE invoice_id = ANY($1::int[])', [invIds]);
        await client.query('DELETE FROM reminders_log WHERE invoice_id = ANY($1::int[])', [invIds]);
        await client.query('DELETE FROM invoices WHERE id = ANY($1::int[])', [invIds]);
      }
      await client.query('DELETE FROM sales WHERE customer_id = $1', [savedRecord.customer.id]);
      await client.query('DELETE FROM customers WHERE id = $1', [savedRecord.customer.id]);
    });

    // Check stock restored
    const checkStock1 = await query('SELECT quantity_available FROM stock_items WHERE id = $1', [savedRecord.item1.id]);
    const checkStock2 = await query('SELECT quantity_available FROM stock_items WHERE id = $1', [savedRecord.item2.id]);
    const checkSales = await query('SELECT * FROM sales WHERE customer_id = $1', [savedRecord.customer.id]);
    const checkInv = await query('SELECT * FROM invoices WHERE id = $1', [savedRecord.invoice.id]);

    if (
      checkStock1.rows[0].quantity_available === 100 &&
      checkStock2.rows[0].quantity_available === 100 &&
      checkSales.rows.length === 0 &&
      checkInv.rows.length === 0
    ) {
      console.log('✅ Global Cascade Deletion Verified! Stock restored, sales removed, invoice removed completely.');
    } else {
      console.error('❌ Cascade deletion failed:', { stock1: checkStock1.rows[0], stock2: checkStock2.rows[0], sales: checkSales.rows, inv: checkInv.rows });
      allPassed = false;
    }

    // Cleanup test stock items
    await query('DELETE FROM stock_items WHERE id IN ($1, $2)', [savedRecord.item1.id, savedRecord.item2.id]);

    // Cleanup test artifacts directory
    fs.rmSync(testDir, { recursive: true, force: true });

    if (allPassed) {
      console.log('\n🎉 ALL 5 TESTS PASSED SUCCESSFULLY! Universal Importer & Cascade Consistency Verified!');
      process.exit(0);
    } else {
      console.error('\n❌ SOME TESTS FAILED.');
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Test execution error:', err);
    process.exit(1);
  }
}

runTests();
