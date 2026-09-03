const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { parseUniversalFile } = require('../services/universalParserService');
const { parseBillText } = require('../services/ocrService');
const { query, withTransaction, syncSequences } = require('../config/db');
const { regenerateExcelReports } = require('../services/excelService');

const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, '../../uploads'));
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer storage config supporting all document and spreadsheet formats
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || '.dat';
    cb(null, `import-${uniqueSuffix}${ext}`);
  },
});

// Allow all documents, spreadsheets, images, CSVs, PDFs, JSONs, and text files
const allowedExtensions = [
  '.pdf',
  '.xlsx',
  '.xls',
  '.csv',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.bmp',
  '.tiff',
  '.txt',
  '.json',
];

const upload = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB max
  fileFilter: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase();
    if (
      allowedExtensions.includes(ext) ||
      file.mimetype.startsWith('image/') ||
      file.mimetype.includes('pdf') ||
      file.mimetype.includes('spreadsheet') ||
      file.mimetype.includes('excel') ||
      file.mimetype.includes('csv') ||
      file.mimetype.includes('text') ||
      file.mimetype.includes('json')
    ) {
      cb(null, true);
    } else {
      // Accept by default to support all user files
      cb(null, true);
    }
  },
});

/**
 * Universal Document and File Parser Endpoint
 * Handles: PDF, Excel, CSV, Images (OCR), Text, JSON, and Base64 Camera Captures
 */
const scanBillImage = async (req, res, next) => {
  let filePath = null;

  try {
    let originalName = 'uploaded-document';
    let mimeType = 'application/octet-stream';

    // 1. Check if single multipart file uploaded
    if (req.file) {
      filePath = req.file.path;
      originalName = req.file.originalname;
      mimeType = req.file.mimetype;
    } else if (req.files && req.files.length > 0) {
      filePath = req.files[0].path;
      originalName = req.files[0].originalname;
      mimeType = req.files[0].mimetype;
    } else if (req.body.imageBase64) {
      // 2. Handle direct base64 from webcam capture or clipboard
      const base64Data = req.body.imageBase64.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      filePath = path.join(UPLOADS_DIR, `scan-${Date.now()}.png`);
      fs.writeFileSync(filePath, buffer);
      originalName = 'webcam-scan.png';
      mimeType = 'image/png';
    } else {
      return res.status(400).json({ success: false, message: 'No file or image provided for reading.' });
    }

    // Compute next sequential invoice number for clean fallback
    const nextInvRes = await query('SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM invoices');
    const fallbackInvNo = `INV-${nextInvRes.rows[0].next_id || 1}`;

    // Universal parser execution
    const parseResult = await parseUniversalFile(filePath, originalName, mimeType, fallbackInvNo);

    // Clean up temporary file
    if (fs.existsSync(filePath)) {
      fs.unlink(filePath, (err) => {
        if (err) console.warn('Could not delete temp uploaded file:', err.message);
      });
    }

    if (parseResult.isMultiRow) {
      return res.json({
        success: true,
        isMultiRow: true,
        fileType: parseResult.fileType,
        fileName: parseResult.fileName,
        importType: parseResult.importType,
        summary: parseResult.summary,
        items: parseResult.items,
        message: `${parseResult.summary || 'Spreadsheet rows parsed successfully.'} Review the table and confirm import.`,
      });
    }

    return res.json({
      success: true,
      isMultiRow: false,
      fileType: parseResult.fileType,
      fileName: parseResult.fileName,
      message: 'Document parsed successfully. Please review and confirm the extracted details.',
      requiresConfirmation: true,
      extractedData: {
        docType: parseResult.extractedData.docType,
        invoiceNumber: parseResult.extractedData.invoiceNumber,
        vendor: parseResult.extractedData.vendorName || parseResult.extractedData.vendor,
        customer: parseResult.extractedData.customerName || parseResult.extractedData.customer,
        contactInfo: parseResult.extractedData.contactInfo,
        taxId: parseResult.extractedData.taxId,
        billDate: parseResult.extractedData.invoiceDate || parseResult.extractedData.billDate,
        dueDate: parseResult.extractedData.dueDate,
        items: parseResult.extractedData.items || [],
        subtotal: parseResult.extractedData.subtotal,
        taxRate: parseResult.extractedData.taxRate,
        taxAmount: parseResult.extractedData.taxAmount,
        discount: parseResult.extractedData.discount,
        totalAmount: parseResult.extractedData.totalAmount,
        paymentStatus: parseResult.extractedData.paymentStatus,
        paymentMode: parseResult.extractedData.paymentMode,
        category: parseResult.extractedData.category,
        confidence: parseResult.extractedData.confidence,
        rawText: parseResult.extractedData.rawText,
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
 * Supports multi-line items with inventory deduction/creation
 */
const confirmExtractedBill = async (req, res, next) => {
  try {
    const {
      customer_name,
      contact_info,
      billing_terms = 30,
      item_name = 'Scanned Inventory Item',
      items = [],
      units = 1,
      rate,
      total_amount,
      bill_date,
      due_date,
      payment_status = 'pending',
      payment_mode = 'Bank Transfer',
      notes = 'Created from Universal File Importer',
    } = req.body;

    if (!customer_name || !customer_name.trim()) {
      return res.status(400).json({ success: false, message: 'Customer or Vendor name is required.' });
    }

    const grandTotal = parseFloat(total_amount);
    if (isNaN(grandTotal) || grandTotal <= 0) {
      return res.status(400).json({ success: false, message: 'Valid total amount (> 0) is required.' });
    }

    const saleDateStr = bill_date || new Date().toISOString().split('T')[0];
    const terms = parseInt(billing_terms, 10) || 30;

    // Normalize line items
    let lineItemsToProcess = [];
    if (Array.isArray(items) && items.length > 0) {
      lineItemsToProcess = items.map((it) => ({
        description: (it.description || it.name || 'Item').trim(),
        quantity: parseInt(it.quantity || it.qty, 10) || 1,
        unit_price: parseFloat(it.unit_price || it.rate) || 0,
      }));
    } else {
      const saleUnits = parseInt(units, 10) || 1;
      const unitRate = rate ? parseFloat(rate) : parseFloat((grandTotal / saleUnits).toFixed(2));
      lineItemsToProcess = [
        {
          description: item_name.trim(),
          quantity: saleUnits,
          unit_price: unitRate,
        },
      ];
    }

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

      // 2. Process each line item into stock and create primary/linked sales
      const createdSales = [];
      let primarySale = null;

      for (const item of lineItemsToProcess) {
        let stockItem;
        const itemCheck = await client.query('SELECT * FROM stock_items WHERE LOWER(name) = LOWER($1)', [item.description]);
        if (itemCheck.rows.length > 0) {
          stockItem = itemCheck.rows[0];
          // Ensure sufficient inventory
          if (stockItem.quantity_available < item.quantity) {
            await client.query('UPDATE stock_items SET quantity_available = quantity_available + $1 WHERE id = $2', [
              item.quantity + 50,
              stockItem.id,
            ]);
          }
        } else {
          const newItem = await client.query(
            'INSERT INTO stock_items (name, unit_price, quantity_available) VALUES ($1, $2, $3) RETURNING *;',
            [item.description, item.unit_price, Math.max(100, item.quantity + 50)]
          );
          stockItem = newItem.rows[0];
        }

        // Deduct inventory
        await client.query('UPDATE stock_items SET quantity_available = quantity_available - $1 WHERE id = $2', [
          item.quantity,
          stockItem.id,
        ]);

        // Insert Sale record
        const saleRes = await client.query(
          `INSERT INTO sales (customer_id, item_id, units_sold, rate, sale_date)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *;`,
          [customer.id, stockItem.id, item.quantity, item.unit_price, saleDateStr]
        );
        const sale = saleRes.rows[0];
        createdSales.push(sale);
        if (!primarySale) primarySale = sale;
      }

      // 3. Calculate invoice due date
      let invDueDate = due_date;
      if (!invDueDate) {
        const d = new Date(saleDateStr);
        d.setDate(d.getDate() + (customer.billing_terms || terms));
        invDueDate = d.toISOString().split('T')[0];
      }

      const isPaid = payment_status === 'paid';
      const initialStatus = isPaid ? 'paid' : (invDueDate < new Date().toISOString().split('T')[0] ? 'overdue' : 'pending');

      // 4. Create Invoice record linked to primary sale
      const invRes = await client.query(
        `INSERT INTO invoices (sale_id, customer_id, amount, due_date, status)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *;`,
        [primarySale.id, customer.id, grandTotal, invDueDate, initialStatus]
      );
      const invoice = invRes.rows[0];

      // 5. If marked as paid, create Payment record
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

      // 6. Synchronize sequence IDs with current MAX(id)
      await syncSequences(client);

      return {
        customer,
        sales: createdSales,
        invoice,
        payment,
      };
    });

    // Synchronize live Excel workbooks
    regenerateExcelReports().catch((e) => console.error('Excel sync error:', e));

    res.status(201).json({
      success: true,
      message: 'Document confirmed and recorded into accounting ledger & live Excel reports!',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Confirm batch multi-row import (e.g. from Excel stock sheet, customer directory, or sales ledger)
 */
const confirmBatchImport = async (req, res, next) => {
  try {
    const { importType, items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'No items provided for batch import.' });
    }

    const result = await withTransaction(async (client) => {
      const created = [];

      if (importType === 'stock') {
        for (const item of items) {
          const name = String(item.name || '').trim();
          const qty = parseInt(item.quantity_available || item.qty, 10) || 0;
          const price = parseFloat(item.unit_price || item.price) || 0;

          if (name) {
            const existing = await client.query('SELECT * FROM stock_items WHERE LOWER(name) = LOWER($1)', [name]);
            if (existing.rows.length > 0) {
              const updated = await client.query(
                'UPDATE stock_items SET quantity_available = quantity_available + $1, unit_price = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
                [qty, price > 0 ? price : existing.rows[0].unit_price, existing.rows[0].id]
              );
              created.push(updated.rows[0]);
            } else {
              const inserted = await client.query(
                'INSERT INTO stock_items (name, quantity_available, unit_price) VALUES ($1, $2, $3) RETURNING *',
                [name, qty, price]
              );
              created.push(inserted.rows[0]);
            }
          }
        }
      } else if (importType === 'customers') {
        for (const cust of items) {
          const name = String(cust.name || '').trim();
          const contact = cust.contact_info ? String(cust.contact_info).trim() : null;
          const terms = parseInt(cust.billing_terms, 10) || 30;

          if (name) {
            const existing = await client.query('SELECT * FROM customers WHERE LOWER(name) = LOWER($1)', [name]);
            if (existing.rows.length > 0) {
              const updated = await client.query(
                'UPDATE customers SET contact_info = COALESCE($1, contact_info), billing_terms = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *',
                [contact, terms, existing.rows[0].id]
              );
              created.push(updated.rows[0]);
            } else {
              const inserted = await client.query(
                'INSERT INTO customers (name, contact_info, billing_terms) VALUES ($1, $2, $3) RETURNING *',
                [name, contact, terms]
              );
              created.push(inserted.rows[0]);
            }
          }
        }
      }

      await syncSequences(client);
      return created;
    });

    // Sync Excel reports
    regenerateExcelReports().catch((e) => console.error('Excel sync error:', e));

    res.status(201).json({
      success: true,
      message: `Successfully imported and synced ${result.length} ${importType || 'records'} into Accounting.`,
      count: result.length,
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
  confirmBatchImport,
};
