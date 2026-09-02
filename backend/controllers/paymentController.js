const { query, withTransaction } = require('../config/db');
const { regenerateExcelReports } = require('../services/excelService');

/**
 * Get all payments with invoice and customer details
 */
const getAllPayments = async (req, res, next) => {
  try {
    const result = await query(`
      SELECT 
        p.*,
        inv.amount AS invoice_total_amount,
        inv.due_date AS invoice_due_date,
        inv.status AS invoice_status,
        c.id AS customer_id,
        c.name AS customer_name,
        c.billing_terms
      FROM payments p
      JOIN invoices inv ON p.invoice_id = inv.id
      JOIN customers c ON inv.customer_id = c.id
      ORDER BY p.payment_date DESC, p.id DESC;
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
 * Get single payment by ID
 */
const getPaymentById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await query(`
      SELECT 
        p.*,
        inv.amount AS invoice_total_amount,
        inv.due_date AS invoice_due_date,
        inv.status AS invoice_status,
        c.id AS customer_id,
        c.name AS customer_name,
        c.billing_terms
      FROM payments p
      JOIN invoices inv ON p.invoice_id = inv.id
      JOIN customers c ON inv.customer_id = c.id
      WHERE p.id = $1;
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Payment record not found.' });
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
 * Create new payment (Transaction: Insert payment + evaluate & update invoice status + recurring cycle calculation)
 */
const createPayment = async (req, res, next) => {
  try {
    const { invoice_id, amount_paid, payment_date, mode, notes } = req.body;

    const invoiceId = parseInt(invoice_id, 10);
    const amount = parseFloat(amount_paid);
    const payDate = payment_date || new Date().toISOString().split('T')[0];
    const payMode = mode || 'Bank Transfer';

    if (isNaN(invoiceId) || isNaN(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid invoice_id and amount_paid (> 0) are required.',
      });
    }

    const result = await withTransaction(async (client) => {
      // 1. Fetch invoice and customer
      const invRes = await client.query(
        `SELECT inv.*, c.billing_terms, c.name AS customer_name 
         FROM invoices inv 
         JOIN customers c ON inv.customer_id = c.id 
         WHERE inv.id = $1 FOR UPDATE;`,
        [invoiceId]
      );

      if (invRes.rows.length === 0) {
        throw new Error('Invoice not found.');
      }

      const invoice = invRes.rows[0];

      // 2. Insert Payment record
      const payRes = await client.query(
        `INSERT INTO payments (invoice_id, amount_paid, payment_date, mode, notes)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *;`,
        [invoiceId, amount, payDate, payMode, notes ? notes.trim() : null]
      );
      const newPayment = payRes.rows[0];

      // 3. Calculate total paid for this invoice
      const sumRes = await client.query(
        `SELECT COALESCE(SUM(amount_paid), 0) AS total_paid FROM payments WHERE invoice_id = $1;`,
        [invoiceId]
      );
      const totalPaid = parseFloat(sumRes.rows[0].total_paid);
      const invoiceAmount = parseFloat(invoice.amount);

      let newStatus = invoice.status;
      let nextRecurringDueDate = null;

      if (totalPaid >= invoiceAmount) {
        newStatus = 'paid';
        // Calculate next recurring due date if customer has billing cycle terms
        if (invoice.billing_terms && invoice.billing_terms > 0) {
          const nextDateObj = new Date(invoice.due_date);
          nextDateObj.setDate(nextDateObj.getDate() + invoice.billing_terms);
          nextRecurringDueDate = nextDateObj.toISOString().split('T')[0];
        }
      } else {
        // If not fully paid, keep status based on due date
        const today = new Date().toISOString().split('T')[0];
        newStatus = invoice.due_date < today ? 'overdue' : 'pending';
      }

      const updatedInvRes = await client.query(
        `UPDATE invoices 
         SET status = $1, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $2 
         RETURNING *;`,
        [newStatus, invoiceId]
      );

      return {
        payment: newPayment,
        invoice: updatedInvRes.rows[0],
        totalPaid,
        balanceRemaining: Math.max(0, invoiceAmount - totalPaid),
        isFullyPaid: totalPaid >= invoiceAmount,
        nextRecurringDueDate,
        customerName: invoice.customer_name,
      };
    });

    regenerateExcelReports().catch((e) => console.error('Excel sync error:', e));

    res.status(201).json({
      success: true,
      message: 'Payment recorded successfully and invoice status updated.',
      data: result,
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, message: error.message });
    }
    next(error);
  }
};

/**
 * Update payment record
 */
const updatePayment = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { amount_paid, payment_date, mode, notes } = req.body;

    const amount = parseFloat(amount_paid);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Valid amount_paid (> 0) is required.' });
    }

    const result = await withTransaction(async (client) => {
      const oldPayRes = await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [id]);
      if (oldPayRes.rows.length === 0) {
        throw new Error('Payment not found.');
      }
      const oldPayment = oldPayRes.rows[0];

      // Update payment
      const updatedPayRes = await client.query(
        `UPDATE payments
         SET amount_paid = $1, payment_date = $2, mode = $3, notes = $4
         WHERE id = $5
         RETURNING *;`,
        [amount, payment_date || oldPayment.payment_date, mode || oldPayment.mode, notes !== undefined ? notes : oldPayment.notes, id]
      );

      // Re-evaluate invoice status
      const sumRes = await client.query(
        `SELECT COALESCE(SUM(amount_paid), 0) AS total_paid FROM payments WHERE invoice_id = $1;`,
        [oldPayment.invoice_id]
      );
      const totalPaid = parseFloat(sumRes.rows[0].total_paid);

      const invRes = await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [oldPayment.invoice_id]);
      const invoice = invRes.rows[0];
      const invoiceAmount = parseFloat(invoice.amount);

      const today = new Date().toISOString().split('T')[0];
      let newStatus = 'pending';
      if (totalPaid >= invoiceAmount) {
        newStatus = 'paid';
      } else if (invoice.due_date < today) {
        newStatus = 'overdue';
      }

      await client.query('UPDATE invoices SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [newStatus, invoice.id]);

      return updatedPayRes.rows[0];
    });

    regenerateExcelReports().catch((e) => console.error('Excel sync error:', e));

    res.json({
      success: true,
      message: 'Payment updated successfully.',
      data: result,
    });
  } catch (error) {
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, message: error.message });
    }
    next(error);
  }
};

/**
 * Delete payment record
 */
const deletePayment = async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await withTransaction(async (client) => {
      const payRes = await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [id]);
      if (payRes.rows.length === 0) {
        throw new Error('Payment not found.');
      }
      const payment = payRes.rows[0];

      await client.query('DELETE FROM payments WHERE id = $1', [id]);

      // Re-evaluate invoice status
      const sumRes = await client.query(
        `SELECT COALESCE(SUM(amount_paid), 0) AS total_paid FROM payments WHERE invoice_id = $1;`,
        [payment.invoice_id]
      );
      const totalPaid = parseFloat(sumRes.rows[0].total_paid);

      const invRes = await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [payment.invoice_id]);
      if (invRes.rows.length > 0) {
        const invoice = invRes.rows[0];
        const invoiceAmount = parseFloat(invoice.amount);
        const today = new Date().toISOString().split('T')[0];
        let newStatus = 'pending';
        if (totalPaid >= invoiceAmount && invoiceAmount > 0) {
          newStatus = 'paid';
        } else if (invoice.due_date < today) {
          newStatus = 'overdue';
        }
        await client.query('UPDATE invoices SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [newStatus, invoice.id]);
      }

      return payment;
    });

    regenerateExcelReports().catch((e) => console.error('Excel sync error:', e));

    res.json({
      success: true,
      message: 'Payment deleted and invoice status re-evaluated.',
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
  getAllPayments,
  getPaymentById,
  createPayment,
  updatePayment,
  deletePayment,
};
