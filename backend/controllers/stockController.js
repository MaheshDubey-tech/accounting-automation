const { query } = require('../config/db');
const { regenerateExcelReports } = require('../services/excelService');

/**
 * Get all stock items
 */
const getAllStock = async (req, res, next) => {
  try {
    const result = await query(`
      SELECT 
        s.*,
        COALESCE(SUM(sa.units_sold), 0) AS total_units_sold
      FROM stock_items s
      LEFT JOIN sales sa ON sa.item_id = s.id
      GROUP BY s.id
      ORDER BY s.name ASC;
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
 * Get single stock item by ID
 */
const getStockById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await query('SELECT * FROM stock_items WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Stock item not found.' });
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
 * Create new stock item
 */
const createStock = async (req, res, next) => {
  try {
    const { name, unit_price, quantity_available } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ success: false, message: 'Item name is required.' });
    }

    const price = parseFloat(unit_price);
    if (isNaN(price) || price < 0) {
      return res.status(400).json({ success: false, message: 'Valid unit price is required (>= 0).' });
    }

    const quantity = parseInt(quantity_available, 10);
    if (isNaN(quantity) || quantity < 0) {
      return res.status(400).json({ success: false, message: 'Valid quantity available is required (>= 0).' });
    }

    const result = await query(
      `INSERT INTO stock_items (name, unit_price, quantity_available)
       VALUES ($1, $2, $3)
       RETURNING *;`,
      [name.trim(), price, quantity]
    );

    regenerateExcelReports().catch((e) => console.error('Excel sync error:', e));

    res.status(201).json({
      success: true,
      message: 'Stock item created successfully.',
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Update stock item
 */
const updateStock = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, unit_price, quantity_available } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ success: false, message: 'Item name is required.' });
    }

    const price = parseFloat(unit_price);
    if (isNaN(price) || price < 0) {
      return res.status(400).json({ success: false, message: 'Valid unit price is required (>= 0).' });
    }

    const quantity = parseInt(quantity_available, 10);
    if (isNaN(quantity) || quantity < 0) {
      return res.status(400).json({ success: false, message: 'Valid quantity available is required (>= 0).' });
    }

    const result = await query(
      `UPDATE stock_items
       SET name = $1, unit_price = $2, quantity_available = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
       RETURNING *;`,
      [name.trim(), price, quantity, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Stock item not found.' });
    }

    regenerateExcelReports().catch((e) => console.error('Excel sync error:', e));

    res.json({
      success: true,
      message: 'Stock item updated successfully.',
      data: result.rows[0],
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete stock item (Cascade: in transaction, delete linked payments, reminders, invoices, sales, then delete stock item and sync Excel)
 */
const deleteStock = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { withTransaction } = require('../config/db');

    const result = await withTransaction(async (client) => {
      const itemRes = await client.query('SELECT * FROM stock_items WHERE id = $1 FOR UPDATE', [id]);
      if (itemRes.rows.length === 0) {
        throw new Error('Stock item not found.');
      }
      const item = itemRes.rows[0];

      // Find all sales linked to this stock item
      const salesRes = await client.query('SELECT id FROM sales WHERE item_id = $1', [id]);
      const saleIds = salesRes.rows.map((s) => s.id);

      if (saleIds.length > 0) {
        // Find linked invoices
        const invRes = await client.query('SELECT id FROM invoices WHERE sale_id = ANY($1::int[])', [saleIds]);
        const invoiceIds = invRes.rows.map((i) => i.id);

        if (invoiceIds.length > 0) {
          // Delete payments
          await client.query('DELETE FROM payments WHERE invoice_id = ANY($1::int[])', [invoiceIds]);
          // Delete reminders
          await client.query('DELETE FROM reminders_log WHERE invoice_id = ANY($1::int[])', [invoiceIds]);
          // Delete invoices
          await client.query('DELETE FROM invoices WHERE id = ANY($1::int[])', [invoiceIds]);
        }

        // Delete sales
        await client.query('DELETE FROM sales WHERE id = ANY($1::int[])', [saleIds]);
      }

      // Delete stock item
      await client.query('DELETE FROM stock_items WHERE id = $1', [id]);

      return item;
    });

    regenerateExcelReports().catch((e) => console.error('Excel sync error:', e));

    res.json({
      success: true,
      message: 'Stock item and all linked sales, invoices, and payments deleted successfully from everywhere.',
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
  getAllStock,
  getStockById,
  createStock,
  updateStock,
  deleteStock,
};
