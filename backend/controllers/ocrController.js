const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { processBillImage, parseBillText } = require('../services/ocrService');
const { query, withTransaction } = require('../config/db');
const { regenerateExcelReports } = require('../services/excelService');

const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, '../../uploads'));
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `bill-${uniqueSuffix}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files (JPEG, PNG, WebP) are allowed!'));
    }
  },
});

/**
 * Handle bill photo upload/scan and return extracted data for user confirmation
 */
const scanBillImage = async (req, res, next) => {
  let filePath = null;

  try {
    // Check if uploaded via multipart file
    if (req.file) {
      filePath = req.file.path;
    } else if (req.body.imageBase64) {
      // Handle direct base64 from webcam capture or clipboard
      const base64Data = req.body.imageBase64.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      filePath = path.join(UPLOADS_DIR, `scan-${Date.now()}.png`);
      fs.writeFileSync(filePath, buffer);
    } else {
      return res.status(400).json({ success: false, message: 'No image provided for scanning.' });
    }

    const ocrResult = await processBillImage(filePath);

    // Clean up temporary image file
    if (fs.existsSync(filePath)) {
      fs.unlink(filePath, (err) => {
        if (err) console.warn('Could not delete temp OCR file:', err.message);
      });
    }

    return res.json({
      success: true,
      message: 'Bill parsed successfully. Please review and confirm the extracted details.',
      requiresConfirmation: true,
      extractedData: {
        docType: ocrResult.docType,
        invoiceNumber: ocrResult.invoiceNumber,
        vendor: ocrResult.vendorName,
        customer: ocrResult.customerName,
        contactInfo: ocrResult.contactInfo,
        taxId: ocrResult.taxId,
        billDate: ocrResult.invoiceDate,
        dueDate: ocrResult.dueDate,
        items: ocrResult.items,
        subtotal: ocrResult.subtotal,
        taxRate: ocrResult.taxRate,
        taxAmount: ocrResult.taxAmount,
        discount: ocrResult.discount,
        totalAmount: ocrResult.totalAmount,
        paymentStatus: ocrResult.paymentStatus,
        paymentMode: ocrResult.paymentMode,
        category: ocrResult.category,
        confidence: ocrResult.confidence,
        rawText: ocrResult.rawText,
      },
    });
  } catch (error) {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    next(error);
  }
};

/**
 * Confirm and save reviewed extracted bill into the live database
 */
const confirmExtractedBill = async (req, res, next) => {
  try {
    const {
      customer_name,
      contact_info,
      billing_terms = 30,
      item_name = 'Scanned Inventory Item',
      units = 1,
      rate,
      total_amount,
      bill_date,
      due_date,
      payment_status = 'pending',
      payment_mode = 'Bank Transfer',
      notes = 'Created from AI Bill Scanner',
    } = req.body;

    if (!customer_name || !customer_name.trim()) {
      return res.status(400).json({ success: false, message: 'Customer or Vendor name is required.' });
    }

    const grandTotal = parseFloat(total_amount);
    if (isNaN(grandTotal) || grandTotal <= 0) {
      return res.status(400).json({ success: false, message: 'Valid total amount (> 0) is required.' });
    }

    const saleUnits = parseInt(units, 10) || 1;
    const unitRate = rate ? parseFloat(rate) : parseFloat((grandTotal / saleUnits).toFixed(2));
    const saleDateStr = bill_date || new Date().toISOString().split('T')[0];
    const terms = parseInt(billing_terms, 10) || 30;

    const result = await withTransaction(async (client) => {
      // 1. Find or create Customer
      let customer;
      const custCheck = await client.query('SELECT * FROM customers WHERE LOWER(name) = LOWER($1)', [customer_name.trim()]);
      if (custCheck.rows.length > 0) {
        customer = custCheck.rows[0];
        if (contact_info && !customer.contact_info) {
          await client.query('UPDATE customers SET contact_info = $1 WHERE id = $2', [contact_info, customer.id]);
        }
      } else {
        const newCust = await client.query(
          'INSERT INTO customers (name, contact_info, billing_terms) VALUES ($1, $2, $3) RETURNING *;',
          [customer_name.trim(), contact_info || null, terms]
        );
        customer = newCust.rows[0];
      }

      // 2. Find or create Stock item
      let stockItem;
      const itemCheck = await client.query('SELECT * FROM stock_items WHERE LOWER(name) = LOWER($1)', [item_name.trim()]);
      if (itemCheck.rows.length > 0) {
        stockItem = itemCheck.rows[0];
        // Ensure sufficient stock
        if (stockItem.quantity_available < saleUnits) {
          await client.query('UPDATE stock_items SET quantity_available = quantity_available + $1 WHERE id = $2', [
            saleUnits + 50,
            stockItem.id,
          ]);
        }
      } else {
        const newItem = await client.query(
          'INSERT INTO stock_items (name, unit_price, quantity_available) VALUES ($1, $2, $3) RETURNING *;',
          [item_name.trim(), unitRate, Math.max(100, saleUnits + 50)]
        );
        stockItem = newItem.rows[0];
      }

      // Deduct stock for sale
      await client.query('UPDATE stock_items SET quantity_available = quantity_available - $1 WHERE id = $2', [
        saleUnits,
        stockItem.id,
      ]);

      // 3. Create Sale record
      const saleRes = await client.query(
        `INSERT INTO sales (customer_id, item_id, units_sold, rate, sale_date)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *;`,
        [customer.id, stockItem.id, saleUnits, unitRate, saleDateStr]
      );
      const sale = saleRes.rows[0];

      // 4. Calculate invoice due date
      let invDueDate = due_date;
      if (!invDueDate) {
        const d = new Date(saleDateStr);
        d.setDate(d.getDate() + (customer.billing_terms || terms));
        invDueDate = d.toISOString().split('T')[0];
      }

      const isPaid = payment_status === 'paid';
      const initialStatus = isPaid ? 'paid' : (invDueDate < new Date().toISOString().split('T')[0] ? 'overdue' : 'pending');

      // 5. Create Invoice record
      const invRes = await client.query(
        `INSERT INTO invoices (sale_id, customer_id, amount, due_date, status)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *;`,
        [sale.id, customer.id, grandTotal, invDueDate, initialStatus]
      );
      const invoice = invRes.rows[0];

      // 6. If marked as paid, create Payment record
      let payment = null;
      if (isPaid) {
        const payRes = await client.query(
          `INSERT INTO payments (invoice_id, amount_paid, payment_date, mode, notes)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *;`,
          [invoice.id, grandTotal, saleDateStr, payment_mode || 'Bank Transfer', notes]
        );
        payment = payRes.rows[0];
      }

      return {
        customer,
        stockItem,
        sale,
        invoice,
        payment,
      };
    });

    // Synchronize live Excel workbooks
    regenerateExcelReports().catch((e) => console.error('Excel sync error:', e));

    res.status(201).json({
      success: true,
      message: 'Scanned bill confirmed and recorded into accounting ledger!',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  upload,
  scanBillImage,
  confirmExtractedBill,
};
