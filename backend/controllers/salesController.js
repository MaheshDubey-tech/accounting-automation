const { query, withTransaction } = require('../config/db');
const { regenerateExcelReports } = require('../services/excelService');

/**
 * Get all sales with customer, item, and invoice details
 */
const getAllSales = async (req, res, next) => {
  try {
    const result = await query(`
      SELECT 
        s.*,
        c.name AS customer_name,
        c.billing_terms,
        c.contact_info AS customer_contact,
        i.name AS item_name,
        (s.units_sold * s.rate) AS total_amount,
        inv.id AS invoice_id,
        inv.due_date,
        inv.status AS invoice_status,
        COALESCE(SUM(p.amount_paid), 0) AS total_paid
      FROM sales s
      JOIN customers c ON s.customer_id = c.id
      JOIN stock_items i ON s.item_id = i.id
      LEFT JOIN invoices inv ON inv.sale_id = s.id
      LEFT JOIN payments p ON p.invoice_id = inv.id
      GROUP BY s.id, c.name, c.billing_terms, c.contact_info, i.name, inv.id, inv.due_date, inv.status
      ORDER BY s.sale_date DESC, s.id DESC;
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
 * Get single sale by ID
 */
const getSaleById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await query(`
      SELECT 
        s.*,
        c.name AS customer_name,
        c.billing_terms,
        i.name AS item_name,
        (s.units_sold * s.rate) AS total_amount,
        inv.id AS invoice_id,
        inv.due_date,
        inv.status AS invoice_status
      FROM sales s
      JOIN customers c ON s.customer_id = c.id
      JOIN stock_items i ON s.item_id = i.id
      LEFT JOIN invoices inv ON inv.sale_id = s.id
      WHERE s.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Sale record not found.' });
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
 * Create new sale (Transaction: Decrement stock + Create Sale + Auto-generate Invoice)
 */
const createSale = async (req, res, next) => {
  try {
    const { customer_id, item_id, units_sold, rate, sale_date } = req.body;

    const customerId = parseInt(customer_id, 10);
    const itemId = parseInt(item_id, 10);
    const units = parseInt(units_sold, 10);
    const unitRate = parseFloat(rate);
    const saleDateStr = sale_date || new Date().toISOString().split('T')[0];

    if (isNaN(customerId) || isNaN(itemId) || isNaN(units) || isNaN(unitRate)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid input: customer_id, item_id, units_sold, and rate must be valid numbers.',
      });
    }

    if (units <= 0 || unitRate < 0) {
      return res.status(400).json({
        success: false,
        message: 'units_sold must be > 0 and rate must be >= 0.',
      });
    }

    const saleTotal = units * unitRate;

    const result = await withTransaction(async (client) => {
      // 1. Verify customer exists and get billing_terms
      const custRes = await client.query('SELECT * FROM customers WHERE id = $1 FOR UPDATE', [customerId]);
      if (custRes.rows.length === 0) {
        throw new Error('Selected customer does not exist.');
      }
      const customer = custRes.rows[0];
      const billingTerms = customer.billing_terms > 0 ? customer.billing_terms : 30;

      // 2. Verify stock availability and lock row
      const stockRes = await client.query('SELECT * FROM stock_items WHERE id = $1 FOR UPDATE', [itemId]);
      if (stockRes.rows.length === 0) {
        throw new Error('Selected stock item does not exist.');
      }
      const stockItem = stockRes.rows[0];
      if (stockItem.quantity_available < units) {
        throw new Error(`Insufficient stock for "${stockItem.name}". Available: ${stockItem.quantity_available}, Requested: ${units}`);
      }

      // 3. Decrement stock
      await client.query(
        'UPDATE stock_items SET quantity_available = quantity_available - $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [units, itemId]
      );

      // 4. Insert Sale record
      const saleInsertRes = await client.query(
        `INSERT INTO sales (customer_id, item_id, units_sold, rate, sale_date)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *;`,
        [customerId, itemId, units, unitRate, saleDateStr]
      );
      const newSale = saleInsertRes.rows[0];

      // 5. Calculate due_date = sale_date + billing_terms days
      // and Auto-Generate Linked Invoice
      const invoiceInsertRes = await client.query(
        `INSERT INTO invoices (sale_id, customer_id, amount, due_date, status)
         VALUES ($1, $2, $3, ($4::date + ($5 || ' days')::interval)::date, 'pending')
         RETURNING *;`,
        [newSale.id, customerId, saleTotal, saleDateStr, billingTerms]
      );
      const newInvoice = invoiceInsertRes.rows[0];

      return {
        sale: newSale,
        invoice: newInvoice,
        customerName: customer.name,
        itemName: stockItem.name,
      };
    });

    regenerateExcelReports().catch((e) => console.error('Excel sync error:', e));

    res.status(201).json({
      success: true,
      message: 'Sale recorded and linked invoice generated successfully.',
      data: result,
    });
  } catch (error) {
    if (error.message.includes('Selected') || error.message.includes('Insufficient')) {
      return res.status(400).json({ success: false, message: error.message });
    }
    next(error);
  }
};

/**
 * Update existing sale (Transaction: adjusts stock difference + updates sale + updates linked invoice)
 */
const updateSale = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { customer_id, item_id, units_sold, rate, sale_date } = req.body;

    const customerId = parseInt(customer_id, 10);
    const itemId = parseInt(item_id, 10);
    const units = parseInt(units_sold, 10);
    const unitRate = parseFloat(rate);
    const saleDateStr = sale_date;

    if (isNaN(customerId) || isNaN(itemId) || isNaN(units) || isNaN(unitRate)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid input fields.',
      });
    }

    const saleTotal = units * unitRate;

    const result = await withTransaction(async (client) => {
      // Find existing sale
      const oldSaleRes = await client.query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [id]);
      if (oldSaleRes.rows.length === 0) {
        throw new Error('Sale record not found.');
      }
      const oldSale = oldSaleRes.rows[0];

      // Customer terms
      const custRes = await client.query('SELECT * FROM customers WHERE id = $1', [customerId]);
      if (custRes.rows.length === 0) {
        throw new Error('Customer not found.');
      }
      const customer = custRes.rows[0];
      const billingTerms = customer.billing_terms > 0 ? customer.billing_terms : 30;

      // Adjust stock: restore old units to old item, deduct new units from new item
      if (oldSale.item_id === itemId) {
        const diff = units - oldSale.units_sold; // positive if requesting more
        const stockRes = await client.query('SELECT * FROM stock_items WHERE id = $1 FOR UPDATE', [itemId]);
        const stock = stockRes.rows[0];
        if (stock.quantity_available - diff < 0) {
          throw new Error(`Insufficient stock for "${stock.name}". Available: ${stock.quantity_available}, Additional required: ${diff}`);
        }
        await client.query('UPDATE stock_items SET quantity_available = quantity_available - $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [diff, itemId]);
      } else {
        // Restore old item stock
        await client.query('UPDATE stock_items SET quantity_available = quantity_available + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [oldSale.units_sold, oldSale.item_id]);
        // Deduct new item stock
        const newStockRes = await client.query('SELECT * FROM stock_items WHERE id = $1 FOR UPDATE', [itemId]);
        if (newStockRes.rows.length === 0) {
          throw new Error('New stock item not found.');
        }
        const newStock = newStockRes.rows[0];
        if (newStock.quantity_available < units) {
          throw new Error(`Insufficient stock for "${newStock.name}". Available: ${newStock.quantity_available}, Requested: ${units}`);
        }
        await client.query('UPDATE stock_items SET quantity_available = quantity_available - $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [units, itemId]);
      }

      // Update sale
      const updatedSaleRes = await client.query(
        `UPDATE sales
         SET customer_id = $1, item_id = $2, units_sold = $3, rate = $4, sale_date = $5
         WHERE id = $6
         RETURNING *;`,
        [customerId, itemId, units, unitRate, saleDateStr, id]
      );

      // Update linked invoice
      const updatedInvoiceRes = await client.query(
        `UPDATE invoices
         SET customer_id = $1, amount = $2, due_date = ($3::date + ($4 || ' days')::interval)::date, updated_at = CURRENT_TIMESTAMP
         WHERE sale_id = $5
         RETURNING *;`,
        [customerId, saleTotal, saleDateStr, billingTerms, id]
      );

      return {
        sale: updatedSaleRes.rows[0],
        invoice: updatedInvoiceRes.rows[0],
      };
    });

    regenerateExcelReports().catch((e) => console.error('Excel sync error:', e));

    res.json({
      success: true,
      message: 'Sale updated successfully.',
      data: result,
    });
  } catch (error) {
    if (error.message.includes('not found') || error.message.includes('Insufficient')) {
      return res.status(400).json({ success: false, message: error.message });
    }
    next(error);
  }
};

/**
 * Delete sale (Transaction: Restores stock + Deletes linked invoice & payments + Deletes sale)
 */
const deleteSale = async (req, res, next) => {
  try {
    const { id } = req.params;

    const result = await withTransaction(async (client) => {
      const saleRes = await client.query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [id]);
      if (saleRes.rows.length === 0) {
        throw new Error('Sale not found.');
      }
      const sale = saleRes.rows[0];

      // Restore stock
      await client.query(
        'UPDATE stock_items SET quantity_available = quantity_available + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [sale.units_sold, sale.item_id]
      );

      // Find linked invoice to clean payments & reminders
      const invRes = await client.query('SELECT id FROM invoices WHERE sale_id = $1', [id]);
      if (invRes.rows.length > 0) {
        const invId = invRes.rows[0].id;
        await client.query('DELETE FROM payments WHERE invoice_id = $1', [invId]);
        await client.query('DELETE FROM reminders_log WHERE invoice_id = $1', [invId]);
        await client.query('DELETE FROM invoices WHERE id = $1', [invId]);
      }

      // Delete sale
      await client.query('DELETE FROM sales WHERE id = $1', [id]);

      return sale;
    });

    regenerateExcelReports().catch((e) => console.error('Excel sync error:', e));

    res.json({
      success: true,
      message: 'Sale deleted and stock restored successfully.',
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
  getAllSales,
  getSaleById,
  createSale,
  updateSale,
  deleteSale,
};
