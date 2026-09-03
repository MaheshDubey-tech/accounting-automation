const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const ExcelJS = require('exceljs');
const { processBillImage, parseBillText } = require('./ocrService');

/**
 * Universal Document and File Parser
 * Supports:
 * - PDF documents (Digital text & scanned PDF fallbacks)
 * - Excel Spreadsheets (.xlsx, .xls)
 * - CSV Comma-Separated Values (.csv)
 * - Images (PNG, JPG, JPEG, WEBP, BMP, TIFF) via Tesseract OCR
 * - Text / JSON (.txt, .json)
 */

/**
 * Parse any uploaded file based on its extension/mimetype
 * @param {string} filePath - Local absolute file path
 * @param {string} originalName - Original filename with extension
 * @param {string} mimeType - Upload MIME type
 * @param {string} fallbackInvoiceNo - Clean sequential default invoice number
 * @returns {Promise<Object>} Extracted and normalized accounting data
 */
const parseUniversalFile = async (filePath, originalName = '', mimeType = '', fallbackInvoiceNo = null) => {
  const ext = (path.extname(originalName || filePath) || '').toLowerCase();

  // 1. PDF Documents (.pdf)
  if (ext === '.pdf' || mimeType === 'application/pdf') {
    return await parsePDFDocument(filePath, originalName, fallbackInvoiceNo);
  }

  // 2. Excel Spreadsheets (.xlsx, .xls)
  if (ext === '.xlsx' || ext === '.xls' || mimeType.includes('spreadsheet') || mimeType.includes('excel')) {
    return await parseExcelDocument(filePath, originalName, fallbackInvoiceNo);
  }

  // 3. CSV Tables (.csv)
  if (ext === '.csv' || mimeType === 'text/csv' || mimeType === 'application/csv') {
    return await parseCSVDocument(filePath, originalName, fallbackInvoiceNo);
  }

  // 4. JSON Files (.json)
  if (ext === '.json' || mimeType === 'application/json') {
    return await parseJSONDocument(filePath, originalName, fallbackInvoiceNo);
  }

  // 5. Plain Text Files (.txt)
  if (ext === '.txt' || mimeType.startsWith('text/')) {
    return await parsePlainTextDocument(filePath, originalName, fallbackInvoiceNo);
  }

  // 6. Image Files (PNG, JPG, JPEG, WEBP, BMP, TIFF)
  return await parseImageDocument(filePath, originalName, fallbackInvoiceNo);
};

/**
 * Parse PDF Document using pdf-parse
 */
const parsePDFDocument = async (filePath, originalName, fallbackInvoiceNo = null) => {
  try {
    const dataBuffer = fs.readFileSync(filePath);
    const pdfData = await pdfParse(dataBuffer);

    const rawText = pdfData.text || '';
    const parsed = parseBillText(rawText, fallbackInvoiceNo);

    return {
      fileType: 'pdf',
      fileName: originalName,
      isMultiRow: false,
      extractedData: {
        ...parsed,
        pageCount: pdfData.numpages || 1,
        docType: parsed.docType || 'invoice',
      },
    };
  } catch (error) {
    console.error('[PDF Parser Error]', error);
    throw new Error(`Failed to parse PDF document: ${error.message}`);
  }
};

/**
 * Parse Excel Spreadsheet (.xlsx, .xls)
 */
const parseExcelDocument = async (filePath, originalName, fallbackInvoiceNo = null) => {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      throw new Error('Spreadsheet has no worksheets.');
    }

    const rows = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows.push(values);
    });

    if (rows.length === 0) {
      throw new Error('Spreadsheet is empty.');
    }

    const detected = detectSpreadsheetStructure(rows, originalName, fallbackInvoiceNo);
    return {
      fileType: 'excel',
      fileName: originalName,
      ...detected,
    };
  } catch (error) {
    console.error('[Excel Parser Error]', error);
    throw new Error(`Failed to parse Excel spreadsheet: ${error.message}`);
  }
};

/**
 * Parse CSV Document (.csv)
 */
const parseCSVDocument = async (filePath, originalName, fallbackInvoiceNo = null) => {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.csv.readFile(filePath);

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      throw new Error('CSV file is empty.');
    }

    const rows = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows.push(values);
    });

    if (rows.length === 0) {
      throw new Error('CSV file contains no data.');
    }

    const detected = detectSpreadsheetStructure(rows, originalName, fallbackInvoiceNo);
    return {
      fileType: 'csv',
      fileName: originalName,
      ...detected,
    };
  } catch (error) {
    console.error('[CSV Parser Error]', error);
    throw new Error(`Failed to parse CSV file: ${error.message}`);
  }
};

/**
 * Detect spreadsheet columns and categorize into Invoices, Stock Items, Sales, or Customers
 */
const detectSpreadsheetStructure = (rows, originalName, fallbackInvoiceNo = null) => {
  const defaultInvNo = fallbackInvoiceNo || 'INV-1';

  if (rows.length === 1) {
    const line = rows[0].join(' ');
    const parsed = parseBillText(line, defaultInvNo);
    return {
      isMultiRow: false,
      extractedData: parsed,
    };
  }

  const headerRow = rows[0].map((h) => String(h || '').trim().toLowerCase());
  const dataRows = rows.slice(1);

  const findCol = (keywords) => {
    return headerRow.findIndex((h) => keywords.some((kw) => h.includes(kw)));
  };

  const itemIdx = findCol(['item', 'product', 'description', 'particular', 'name', 'sku']);
  const qtyIdx = findCol(['qty', 'quantity', 'units', 'count']);
  const rateIdx = findCol(['rate', 'price', 'unit price', 'cost']);
  const totalIdx = findCol(['total', 'amount', 'net', 'line total']);
  const custIdx = findCol(['customer', 'client', 'vendor', 'party', 'buyer', 'name']);
  const dateIdx = findCol(['date', 'bill date', 'invoice date', 'time']);
  const contactIdx = findCol(['contact', 'phone', 'email', 'mobile']);
  const termsIdx = findCol(['terms', 'billing terms', 'days']);

  const isStockSheet = (itemIdx !== -1 && (qtyIdx !== -1 || rateIdx !== -1) && custIdx === -1) || originalName.toLowerCase().includes('stock') || originalName.toLowerCase().includes('inventory');
  const isCustomerSheet = (custIdx !== -1 && (contactIdx !== -1 || termsIdx !== -1) && qtyIdx === -1) || originalName.toLowerCase().includes('customer');

  if (isStockSheet) {
    const items = dataRows.map((r, i) => {
      const name = String(r[itemIdx !== -1 ? itemIdx : 0] || `Stock Item ${i + 1}`).trim();
      const qty = parseInt(r[qtyIdx !== -1 ? qtyIdx : 1], 10) || 100;
      const price = parseFloat(r[rateIdx !== -1 ? rateIdx : 2]) || 0;
      return {
        name,
        quantity_available: Math.max(0, qty),
        unit_price: price >= 0 ? price : 0,
      };
    }).filter((it) => it.name.length > 0);

    return {
      isMultiRow: true,
      importType: 'stock',
      summary: `Extracted ${items.length} Stock / Inventory items from spreadsheet.`,
      items,
    };
  }

  if (isCustomerSheet) {
    const customers = dataRows.map((r, i) => {
      const name = String(r[custIdx !== -1 ? custIdx : 0] || `Customer ${i + 1}`).trim();
      const contact = contactIdx !== -1 && r[contactIdx] ? String(r[contactIdx]).trim() : '';
      const terms = termsIdx !== -1 ? parseInt(r[termsIdx], 10) || 30 : 30;
      return {
        name,
        contact_info: contact,
        billing_terms: terms,
      };
    }).filter((c) => c.name.length > 0);

    return {
      isMultiRow: true,
      importType: 'customers',
      summary: `Extracted ${customers.length} Customers from directory spreadsheet.`,
      items: customers,
    };
  }

  // Multi-row Sales / Invoices table
  const parsedItems = [];
  let totalSum = 0;
  let detectedCustomer = 'Imported Customer';
  let detectedDate = new Date().toISOString().split('T')[0];

  dataRows.forEach((r, i) => {
    const desc = String(r[itemIdx !== -1 ? itemIdx : 0] || `Item ${i + 1}`).trim();
    const qty = parseInt(r[qtyIdx !== -1 ? qtyIdx : 1], 10) || 1;
    const rate = parseFloat(r[rateIdx !== -1 ? rateIdx : 2]) || 0;
    const lineTotal = totalIdx !== -1 && r[totalIdx] ? parseFloat(r[totalIdx]) : qty * rate;

    if (custIdx !== -1 && r[custIdx]) {
      detectedCustomer = String(r[custIdx]).trim();
    }
    if (dateIdx !== -1 && r[dateIdx]) {
      const d = new Date(r[dateIdx]);
      if (!isNaN(d.getTime())) detectedDate = d.toISOString().split('T')[0];
    }

    if (desc) {
      parsedItems.push({
        description: desc,
        quantity: qty,
        unit_price: rate,
        total: lineTotal || qty * rate,
      });
      totalSum += (lineTotal || qty * rate);
    }
  });

  return {
    isMultiRow: false,
    extractedData: {
      docType: 'invoice',
      invoiceNumber: defaultInvNo,
      vendorName: detectedCustomer,
      customerName: detectedCustomer,
      contactInfo: '',
      taxId: '',
      invoiceDate: detectedDate,
      dueDate: new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
      items: parsedItems.length > 0 ? parsedItems : [{ description: 'Imported Item', quantity: 1, unit_price: totalSum, total: totalSum }],
      subtotal: parseFloat(totalSum.toFixed(2)),
      taxRate: 0,
      taxAmount: 0,
      discount: 0,
      totalAmount: parseFloat(totalSum.toFixed(2)),
      paymentStatus: 'pending',
      paymentMode: 'Bank Transfer',
      category: 'General Supplies',
      confidence: { overall: 'high', file: originalName },
      rawText: rows.map((r) => r.join(' | ')).join('\n'),
    },
  };
};

/**
 * Parse JSON Document
 */
const parseJSONDocument = async (filePath, originalName, fallbackInvoiceNo = null) => {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const json = JSON.parse(content);
    const defaultInvNo = fallbackInvoiceNo || 'INV-1';

    if (json.invoiceNumber || json.totalAmount || json.items || json.customer) {
      const parsed = {
        docType: json.docType || 'invoice',
        invoiceNumber: json.invoiceNumber || defaultInvNo,
        vendorName: json.vendor || json.vendorName || 'Vendor',
        customerName: json.customer || json.customerName || 'Customer',
        contactInfo: json.contactInfo || '',
        taxId: json.taxId || '',
        invoiceDate: json.billDate || json.invoiceDate || new Date().toISOString().split('T')[0],
        dueDate: json.dueDate || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
        items: Array.isArray(json.items) ? json.items : [{ description: 'Item', quantity: 1, unit_price: json.totalAmount || 0, total: json.totalAmount || 0 }],
        subtotal: parseFloat(json.subtotal || json.totalAmount || 0),
        taxRate: parseFloat(json.taxRate || 0),
        taxAmount: parseFloat(json.taxAmount || 0),
        discount: parseFloat(json.discount || 0),
        totalAmount: parseFloat(json.totalAmount || 0),
        paymentStatus: json.paymentStatus || 'pending',
        paymentMode: json.paymentMode || 'Bank Transfer',
        category: json.category || 'General Supplies',
        confidence: { overall: 'high' },
        rawText: content,
      };

      return {
        fileType: 'json',
        fileName: originalName,
        isMultiRow: false,
        extractedData: parsed,
      };
    }

    if (Array.isArray(json)) {
      return {
        fileType: 'json',
        fileName: originalName,
        isMultiRow: true,
        importType: 'batch',
        items: json,
        summary: `Extracted ${json.length} items from JSON array.`,
      };
    }

    const parsed = parseBillText(content, defaultInvNo);
    return {
      fileType: 'json',
      fileName: originalName,
      isMultiRow: false,
      extractedData: parsed,
    };
  } catch (error) {
    console.error('[JSON Parser Error]', error);
    throw new Error(`Failed to parse JSON file: ${error.message}`);
  }
};

/**
 * Parse Plain Text Document
 */
const parsePlainTextDocument = async (filePath, originalName, fallbackInvoiceNo = null) => {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const parsed = parseBillText(text, fallbackInvoiceNo);
    return {
      fileType: 'text',
      fileName: originalName,
      isMultiRow: false,
      extractedData: parsed,
    };
  } catch (error) {
    console.error('[Plain Text Parser Error]', error);
    throw new Error(`Failed to parse text document: ${error.message}`);
  }
};

/**
 * Parse Image Document (PNG, JPG, WEBP, etc.) via OCR
 */
const parseImageDocument = async (filePath, originalName, fallbackInvoiceNo = null) => {
  const parsed = await processBillImage(filePath, fallbackInvoiceNo);
  return {
    fileType: 'image',
    fileName: originalName,
    isMultiRow: false,
    extractedData: parsed,
  };
};

module.exports = {
  parseUniversalFile,
  parsePDFDocument,
  parseExcelDocument,
  parseCSVDocument,
  parseJSONDocument,
  parsePlainTextDocument,
  parseImageDocument,
};
