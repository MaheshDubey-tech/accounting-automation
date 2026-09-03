const { query, withTransaction, syncSequences } = require('../config/db');
const { regenerateExcelReports } = require('../services/excelService');

/**
 * Get all customers
 */
const getAllCustomers = async (req, res, next) => {
  try {
    const result = await query(`
      SELECT 
        c.*,
        COUNT(DISTINCT s.id) AS total_sales_count,
        COALESCE(SUM(inv.amount), 0) AS total_invoiced_amount,
        COALESCE(SUM(p.amount_paid), 0) AS total_paid_amount
      FROM customers c
      LEFT JOIN sales s ON s.customer_id = c.id
      LEFT JOIN invoices inv ON inv.customer_id = c.id
      LEFT JOIN payments p ON p.invoice_id = inv.id
      GROUP BY c.id
      ORDER BY c.name ASC;
    `);

    res.json({
      success: true,
      count: result.rowCount,
      data: result.rows,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get single customer by ID
 */
const getCustomerById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await query('SELECT * FROM customers WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Customer not found.' });
    }

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Create new customer
 */
const createCustomer = async (req, res, next) => {
  try {
    const { name, contact_info, billing_terms } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ success: false, message: 'Customer name is required.' });
    }

    const terms = parseInt(billing_terms, 10);
    const validTerms = !isNaN(terms) && terms >= 0 ? terms : 30;

    const result = await query(
      `INSERT INTO customers (name, contact_info, billing_terms)
       VALUES ($1, $2, $3)
       RETURNING *;`,
      [name.trim(), contact_info ? contact_info.trim() : null, validTerms]
    );

    // Regenerate Excel sheets in background
    regenerateExcelReports().catch((e) => console.error('Excel sync error:', e));

    res.status(201).json({
      success: true,
      message: 'Customer created successfully.',
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update existing customer
 */
const updateCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, contact_info, billing_terms } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ success: false, message: 'Customer name is required.' });
    }

    const terms = parseInt(billing_terms, 10);
    const validTerms = !isNaN(terms) && terms >= 0 ? terms : 30;

    const result = await query(
      `UPDATE customers
       SET name = $1, contact_info = $2, billing_terms = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
       RETURNING *;`,
      [name.trim(), contact_info ? contact_info.trim() : null, validTerms, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Customer not found.' });
    }

    regenerateExcelReports().catch((e) => console.error('Excel sync error:', e));

    res.json({
      success: true,
      message: 'Customer updated successfully.',
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete customer (Cascade: In transaction, restore stock for all sales, delete payments, reminders, invoices, sales, and customer, then regenerate Excel)
 */
const deleteCustomer = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { withTransaction } = require('../config/db');


    const result = await withTransaction(async (client) => {
      // 1. Verify customer exists
      const custRes = await client.query('SELECT * FROM customers WHERE id = $1 FOR UPDATE', [id]);
      if (custRes.rows.length === 0) {
        throw new Error('Customer not found.');
      }
      const customer = custRes.rows[0];

      // 2. Fetch all sales for this customer to restore stock quantities
      const salesRes = await client.query('SELECT id, item_id, units_sold FROM sales WHERE customer_id = $1', [id]);
      for (const sale of salesRes.rows) {
        if (sale.item_id && sale.units_sold > 0) {
          await client.query(
            'UPDATE stock_items SET quantity_available = quantity_available + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [sale.units_sold, sale.item_id]
          );
        }
      }

      // 3. Find all invoices for this customer
      const invRes = await client.query('SELECT id FROM invoices WHERE customer_id = $1', [id]);
      const invoiceIds = invRes.rows.map((r) => r.id);

      if (invoiceIds.length > 0) {
        // Delete payments for these invoices
        await client.query('DELETE FROM payments WHERE invoice_id = ANY($1::int[])', [invoiceIds]);
        // Delete reminders for these invoices
        await client.query('DELETE FROM reminders_log WHERE invoice_id = ANY($1::int[])', [invoiceIds]);
        // Delete invoices
        await client.query('DELETE FROM invoices WHERE customer_id = $1', [id]);
      }

      // 4. Delete sales for this customer
      await client.query('DELETE FROM sales WHERE customer_id = $1', [id]);

      // 5. Delete customer record
      await client.query('DELETE FROM customers WHERE id = $1', [id]);

      // 6. Sync sequences so next records get proper sequential IDs
      await syncSequences(client);

      return customer;
    });

    // Regenerate Excel reports
    regenerateExcelReports().catch((e) => console.error('Excel sync error:', e));

    res.json({
      success: true,
      message: 'Customer and all associated sales, invoices, and payments deleted successfully from everywhere.',
      data: result,
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, message: error.message });
    }
    next(error);
  }
};

module.exports = {
  getAllCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  deleteCustomer,
};
