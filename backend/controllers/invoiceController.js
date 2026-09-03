const { query, withTransaction, syncSequences } = require('../config/db');
const { regenerateExcelReports } = require('../services/excelService');

/**
 * Get all invoices with full details
 */
const getAllInvoices = async (req, res, next) => {
  try {
    const { status, customer_id } = req.query;

    let sql = `
      SELECT 
        inv.*,
        c.name AS customer_name,
        c.contact_info AS customer_contact,
        c.billing_terms,
        s.units_sold,
        s.rate AS sale_rate,
        s.sale_date,
        item.name AS item_name,
        COALESCE(SUM(p.amount_paid), 0) AS total_paid,
        (inv.amount - COALESCE(SUM(p.amount_paid), 0)) AS balance_due,
        (
          SELECT json_agg(
            json_build_object(
              'id', pay.id,
              'amount_paid', pay.amount_paid,
              'payment_date', pay.payment_date,
              'mode', pay.mode,
              'notes', pay.notes
            ) ORDER BY pay.payment_date DESC
          )
          FROM payments pay
          WHERE pay.invoice_id = inv.id
        ) AS payment_records
      FROM invoices inv
      JOIN customers c ON inv.customer_id = c.id
      LEFT JOIN sales s ON inv.sale_id = s.id
      LEFT JOIN stock_items item ON s.item_id = item.id
      LEFT JOIN payments p ON p.invoice_id = inv.id
      WHERE 1=1
    `;

    const params = [];
    if (status) {
      params.push(status.toLowerCase());
      sql += ` AND inv.status = $${params.length}`;
    }

    if (customer_id) {
      params.push(customer_id);
      sql += ` AND inv.customer_id = $${params.length}`;
    }

    sql += `
      GROUP BY inv.id, c.name, c.contact_info, c.billing_terms, s.units_sold, s.rate, s.sale_date, item.name
      ORDER BY inv.due_date ASC, inv.id DESC;
    `;

    const result = await query(sql, params);

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
 * Get single invoice by ID
 */
const getInvoiceById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await query(`
      SELECT 
        inv.*,
        c.name AS customer_name,
        c.contact_info AS customer_contact,
        c.billing_terms,
        s.units_sold,
        s.rate AS sale_rate,
        s.sale_date,
        item.name AS item_name,
        COALESCE(SUM(p.amount_paid), 0) AS total_paid,
        (inv.amount - COALESCE(SUM(p.amount_paid), 0)) AS balance_due,
        (
          SELECT json_agg(
            json_build_object(
              'id', pay.id,
              'amount_paid', pay.amount_paid,
              'payment_date', pay.payment_date,
              'mode', pay.mode,
              'notes', pay.notes
            ) ORDER BY pay.payment_date DESC
          )
          FROM payments pay
          WHERE pay.invoice_id = inv.id
        ) AS payment_records
      FROM invoices inv
      JOIN customers c ON inv.customer_id = c.id
      LEFT JOIN sales s ON inv.sale_id = s.id
      LEFT JOIN stock_items item ON s.item_id = item.id
      LEFT JOIN payments p ON p.invoice_id = inv.id
      WHERE inv.id = $1
      GROUP BY inv.id, c.name, c.contact_info, c.billing_terms, s.units_sold, s.rate, s.sale_date, item.name
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Invoice not found.' });
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
 * Update invoice
 */
const updateInvoice = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { amount, due_date, status } = req.body;

    const updates = [];
    const params = [];

    if (amount !== undefined) {
      const amt = parseFloat(amount);
      if (isNaN(amt) || amt < 0) {
        return res.status(400).json({ success: false, message: 'Valid amount is required (>= 0).' });
      }
      params.push(amt);
      updates.push(`amount = $${params.length}`);
    }

    if (due_date) {
      params.push(due_date);
      updates.push(`due_date = $${params.length}`);
    }

    if (status) {
      if (!['pending', 'paid', 'overdue'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Status must be pending, paid, or overdue.' });
      }
      params.push(status);
      updates.push(`status = $${params.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields provided to update.' });
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    params.push(id);

    const result = await query(
      `UPDATE invoices
       SET ${updates.join(', ')}
       WHERE id = $${params.length}
       RETURNING *;`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Invoice not found.' });
    }

    regenerateExcelReports().catch((e) => console.error('Excel sync error:', e));

    res.json({
      success: true,
      message: 'Invoice updated successfully.',
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete invoice (Cascade: in transaction, restore stock for linked sale, delete payments, reminders, sale, and invoice, then sync Excel)
 */
const deleteInvoice = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { withTransaction } = require('../config/db');

    const result = await withTransaction(async (client) => {
      const invRes = await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [id]);
      if (invRes.rows.length === 0) {
        throw new Error('Invoice not found.');
      }
      const invoice = invRes.rows[0];

      // Delete payments
      await client.query('DELETE FROM payments WHERE invoice_id = $1', [id]);

      // Delete reminders
      await client.query('DELETE FROM reminders_log WHERE invoice_id = $1', [id]);

      // If tied to a sale, restore stock and delete the sale
      if (invoice.sale_id) {
        const saleRes = await client.query('SELECT * FROM sales WHERE id = $1', [invoice.sale_id]);
        if (saleRes.rows.length > 0) {
          const sale = saleRes.rows[0];
          await client.query(
            'UPDATE stock_items SET quantity_available = quantity_available + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [sale.units_sold, sale.item_id]
          );
          await client.query('DELETE FROM sales WHERE id = $1', [invoice.sale_id]);
        }
      }

      // Delete invoice
      await client.query('DELETE FROM invoices WHERE id = $1', [id]);

      // Sync sequences so next invoice gets a clean sequential ID
      await syncSequences(client);

      return invoice;
    });

    regenerateExcelReports().catch((e) => console.error('Excel sync error:', e));

    res.json({
      success: true,
      message: 'Invoice, linked sale, and payments deleted successfully from everywhere.',
      data: result,
    });
  } catch (error) {
    if (error.message && error.message.includes('not found')) {
      return res.status(404).json({ success: false, message: error.message });
    }
    next(error);
  }
};

/**
 * Get reminders log
 */
const getRemindersLog = async (req, res, next) => {
  try {
    const result = await query(`
      SELECT 
        r.*,
        inv.amount,
        inv.due_date,
        c.name AS customer_name
      FROM reminders_log r
      JOIN invoices inv ON r.invoice_id = inv.id
      JOIN customers c ON inv.customer_id = c.id
      ORDER BY r.created_at DESC
      LIMIT 100;
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

module.exports = {
  getAllInvoices,
  getInvoiceById,
  updateInvoice,
  deleteInvoice,
  getRemindersLog,
};
