const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const pdfParse = require('pdf-parse');
const ExcelJS = require('exceljs');
const { processBillImage, parseBillText } = require('./ocrService');

/**
 * Universal Document and Accounting File Parser Engine
 * Supports:
 * - PDF documents (Digital text & table extraction)
 * - Excel Spreadsheets (.xlsx, .xlsm, .xltx, and .xls binary/html/tsv formats)
 * - Delimited Tables (.csv, .tsv, .tab, semicolon-delimited, pipe-delimited)
 * - Word & Office Documents (.docx, .odt via embedded document XML)
 * - OpenDocument Spreadsheets (.ods)
 * - Web & Markup Invoices (.html, .htm, .xml)
 * - Structured Data (.json)
 * - Plain & Rich Text (.txt, .rtf, .log, .md)
 * - Images (.png, .jpg, .jpeg, .webp, .bmp, .tiff, .gif, .svg) via OCR & fallback
 */

/**
 * Extract primitive cell value from ExcelJS cell representation
 */
const extractCellValue = (cellVal) => {
  if (cellVal === null || cellVal === undefined) return '';
  if (typeof cellVal === 'object') {
    if (cellVal instanceof Date) {
      return cellVal.toISOString().split('T')[0];
    }
    if (cellVal.result !== undefined) return extractCellValue(cellVal.result);
    if (cellVal.text !== undefined) return cellVal.text;
    if (Array.isArray(cellVal.richText)) {
      return cellVal.richText.map((r) => r.text || '').join('');
    }
    if (cellVal.sharedString !== undefined) return cellVal.sharedString;
    return String(cellVal);
  }
  return String(cellVal).trim();
};

/**
 * Extract text from a ZIP container (e.g. DOCX, ODT, ODS)
 */
const extractZipText = (filePath) => {
  try {
    const buffer = fs.readFileSync(filePath);
    let offset = 0;
    let fullText = '';
    while (offset < buffer.length - 30) {
      if (buffer.readUInt32LE(offset) === 0x04034b50) {
        const method = buffer.readUInt16LE(offset + 8);
        const compSize = buffer.readUInt32LE(offset + 18);
        const fnLen = buffer.readUInt16LE(offset + 26);
        const extraLen = buffer.readUInt16LE(offset + 28);
        const filename = buffer.toString('utf8', offset + 30, offset + 30 + fnLen);
        const dataOffset = offset + 30 + fnLen + extraLen;

        if (
          filename.endsWith('document.xml') ||
          filename.endsWith('content.xml') ||
          filename.endsWith('.txt') ||
          filename.endsWith('.xml')
        ) {
          try {
            const compData = buffer.slice(dataOffset, dataOffset + compSize);
            const decomp = method === 8 ? zlib.inflateRawSync(compData).toString('utf8') : compData.toString('utf8');
            const text = decomp.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
            fullText += ' ' + text;
          } catch (e) {
            // ignore individual XML entry parse errors
          }
        }
        offset = dataOffset + compSize;
      } else {
        offset++;
      }
    }
    return fullText.trim();
  } catch (err) {
    return '';
  }
};

/**
 * Parse any uploaded file based on its extension/mimetype/content
 * @param {string} filePath - Local absolute file path
 * @param {string} originalName - Original filename with extension
 * @param {string} mimeType - Upload MIME type
 * @param {string} fallbackInvoiceNo - Clean sequential default invoice number
 * @returns {Promise<Object>} Extracted and normalized accounting data
 */
const parseUniversalFile = async (filePath, originalName = '', mimeType = '', fallbackInvoiceNo = null) => {
  const ext = (path.extname(originalName || filePath) || '').toLowerCase();
  const lowerName = (originalName || '').toLowerCase();
  const defaultInvNo = fallbackInvoiceNo || 'INV-1';

  // 1. PDF Documents (.pdf)
  if (ext === '.pdf' || mimeType === 'application/pdf') {
    return await parsePDFDocument(filePath, originalName, defaultInvNo);
  }

  // 2. Excel Spreadsheets (.xlsx, .xlsm, .xltx)
  if (ext === '.xlsx' || ext === '.xlsm' || ext === '.xltx') {
    return await parseExcelDocument(filePath, originalName, defaultInvNo);
  }

  // 3. Legacy Excel (.xls) or OpenDocument Spreadsheet (.ods)
  if (ext === '.xls' || ext === '.ods') {
    return await parseLegacyExcelDocument(filePath, originalName, defaultInvNo);
  }

  // 4. Delimited Tables (.csv, .tsv, .tab, .psv)
  if (
    ext === '.csv' ||
    ext === '.tsv' ||
    ext === '.tab' ||
    ext === '.psv' ||
    mimeType === 'text/csv' ||
    mimeType === 'text/tab-separated-values' ||
    mimeType.includes('csv')
  ) {
    return await parseDelimitedDocument(filePath, originalName, defaultInvNo);
  }

  // 5. Word Documents (.docx, .doc, .odt)
  if (ext === '.docx' || ext === '.doc' || ext === '.odt' || mimeType.includes('word') || mimeType.includes('officedocument')) {
    return await parseWordDocument(filePath, originalName, defaultInvNo);
  }

  // 6. JSON Data (.json)
  if (ext === '.json' || mimeType === 'application/json') {
    return await parseJSONDocument(filePath, originalName, defaultInvNo);
  }

  // 7. Markup files (.html, .htm, .xml)
  if (ext === '.html' || ext === '.htm' || ext === '.xml' || mimeType.includes('html') || mimeType.includes('xml')) {
    return await parseMarkupDocument(filePath, originalName, defaultInvNo);
  }

  // 8. Plain Text (.txt, .rtf, .log, .md)
  if (ext === '.txt' || ext === '.rtf' || ext === '.log' || ext === '.md' || mimeType.startsWith('text/')) {
    return await parsePlainTextDocument(filePath, originalName, defaultInvNo);
  }

  // 9. Image Files (.png, .jpg, .jpeg, .webp, .bmp, .tiff, .gif, .svg)
  const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.tif', '.gif', '.svg'];
  if (imageExts.includes(ext) || mimeType.startsWith('image/')) {
    return await parseImageDocument(filePath, originalName, defaultInvNo);
  }

  // 10. Fallback: Try reading as text, then as binary XML, and lastly OCR
  try {
    const rawContent = fs.readFileSync(filePath, 'utf8');
    if (rawContent && rawContent.length > 10 && !rawContent.includes('\0')) {
      const parsed = parseBillText(rawContent, defaultInvNo);
      return {
        fileType: 'text',
        fileName: originalName,
        isMultiRow: false,
        extractedData: parsed,
      };
    }
  } catch (e) {
    // binary file
  }

  // Try zip text extraction (if container like docx or epub)
  const zipText = extractZipText(filePath);
  if (zipText && zipText.length > 20) {
    const parsed = parseBillText(zipText, defaultInvNo);
    return {
      fileType: 'document',
      fileName: originalName,
      isMultiRow: false,
      extractedData: parsed,
    };
  }

  // Final fallback: OCR
  return await parseImageDocument(filePath, originalName, defaultInvNo);
};

/**
 * Parse PDF Document using pdf-parse with text extraction
 */
const parsePDFDocument = async (filePath, originalName, fallbackInvoiceNo = null) => {
  try {
    const dataBuffer = fs.readFileSync(filePath);
    const pdfData = await pdfParse(dataBuffer);

    const rawText = pdfData.text || '';
    if (rawText.trim().length > 0) {
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
    }

    // Scanned PDF with no digital text: return fallback invoice with clean defaults
    const fallbackParsed = parseBillText(`Invoice from ${originalName.replace(/\.pdf$/i, '')}`, fallbackInvoiceNo);
    return {
      fileType: 'pdf',
      fileName: originalName,
      isMultiRow: false,
      extractedData: {
        ...fallbackParsed,
        pageCount: pdfData.numpages || 1,
      },
    };
  } catch (error) {
    console.error('[PDF Parser Error]', error);
    throw new Error(`Failed to parse PDF document: ${error.message}`);
  }
};

/**
 * Parse Excel Spreadsheet (.xlsx, .xlsm) with multiple worksheets support
 */
const parseExcelDocument = async (filePath, originalName, fallbackInvoiceNo = null) => {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    // Find the first worksheet with rows
    let targetSheet = null;
    for (const sheet of workbook.worksheets) {
      if (sheet.rowCount > 0) {
        targetSheet = sheet;
        break;
      }
    }

    if (!targetSheet) {
      throw new Error('Spreadsheet has no populated worksheets.');
    }

    const rows = [];
    targetSheet.eachRow({ includeEmpty: false }, (row) => {
      const rowValues = [];
      const len = row.cellCount || (Array.isArray(row.values) ? row.values.length : 0);
      for (let c = 1; c <= Math.max(len, 20); c++) {
        const cell = row.getCell(c);
        if (cell && cell.value !== undefined && cell.value !== null) {
          rowValues.push(extractCellValue(cell.value));
        } else {
          rowValues.push('');
        }
      }
      // Trim trailing empty cells
      while (rowValues.length > 0 && rowValues[rowValues.length - 1] === '') {
        rowValues.pop();
      }
      if (rowValues.length > 0) {
        rows.push(rowValues);
      }
    });

    if (rows.length === 0) {
      throw new Error('Spreadsheet contains no readable rows.');
    }

    const detected = detectSpreadsheetStructure(rows, originalName, fallbackInvoiceNo);
    return {
      fileType: 'excel',
      fileName: originalName,
      ...detected,
    };
  } catch (error) {
    console.warn('[Excel OpenXML failed, falling back to legacy/text parser]:', error.message);
    return await parseLegacyExcelDocument(filePath, originalName, fallbackInvoiceNo);
  }
};

/**
 * Parse Legacy Excel (.xls) or OpenDocument (.ods)
 * Supports: OpenXML saved as .xls, HTML table exports, TSV exports, and text fallback
 */
const parseLegacyExcelDocument = async (filePath, originalName, fallbackInvoiceNo = null) => {
  // 1. Try ExcelJS xlsx parser in case it's actually an OpenXML file with .xls extension
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    if (workbook.worksheets.length > 0 && workbook.worksheets[0].rowCount > 0) {
      const rows = [];
      workbook.worksheets[0].eachRow({ includeEmpty: false }, (row) => {
        const vals = Array.isArray(row.values) ? row.values.slice(1).map(extractCellValue) : [];
        if (vals.some((v) => v.length > 0)) rows.push(vals);
      });
      if (rows.length > 0) {
        const detected = detectSpreadsheetStructure(rows, originalName, fallbackInvoiceNo);
        return { fileType: 'excel', fileName: originalName, ...detected };
      }
    }
  } catch (e) {
    // not an OpenXML container
  }

  // 2. Read as text/buffer to check for HTML table or TSV/CSV format
  const content = fs.readFileSync(filePath, 'utf8');

  // Check HTML table format (common with ERP exports)
  if (content.includes('<table') || content.includes('<tr')) {
    const rows = [];
    const trMatches = content.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    for (const tr of trMatches) {
      const cells = [];
      const tdMatches = tr.match(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi) || [];
      for (const td of tdMatches) {
        const clean = td.replace(/<[^>]+>/g, '').trim().replace(/&nbsp;/g, ' ');
        cells.push(clean);
      }
      if (cells.some((c) => c.length > 0)) rows.push(cells);
    }

    if (rows.length > 0) {
      const detected = detectSpreadsheetStructure(rows, originalName, fallbackInvoiceNo);
      return { fileType: 'excel', fileName: originalName, ...detected };
    }
  }

  // Check TSV / CSV text lines
  if (content.includes('\t') || content.includes(',')) {
    return await parseDelimitedDocument(filePath, originalName, fallbackInvoiceNo);
  }

  // Fallback: Parse as text document
  const parsed = parseBillText(content, fallbackInvoiceNo);
  return {
    fileType: 'excel',
    fileName: originalName,
    isMultiRow: false,
    extractedData: parsed,
  };
};

/**
 * Parse Delimited Text Document (.csv, .tsv, .tab, .psv) with auto delimiter detection
 */
const parseDelimitedDocument = async (filePath, originalName, fallbackInvoiceNo = null) => {
  try {
    const rawContent = fs.readFileSync(filePath, 'utf8');
    const lines = rawContent.split(/\r?\n/).filter((l) => l.trim().length > 0);

    if (lines.length === 0) {
      throw new Error('Delimited file is empty.');
    }

    // Auto-detect delimiter from first 5 lines
    const sample = lines.slice(0, 5).join('\n');
    const delimiters = ['\t', ',', ';', '|'];
    let bestDelimiter = ',';
    let maxCount = -1;

    for (const delim of delimiters) {
      const count = (sample.match(new RegExp('\\' + delim, 'g')) || []).length;
      if (count > maxCount) {
        maxCount = count;
        bestDelimiter = delim;
      }
    }

    // Parse rows respecting quoted fields
    const rows = [];
    for (const line of lines) {
      const row = [];
      let inQuotes = false;
      let curr = '';

      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          inQuotes = !inQuotes;
        } else if (ch === bestDelimiter && !inQuotes) {
          row.push(curr.trim());
          curr = '';
        } else {
          curr += ch;
        }
      }
      row.push(curr.trim());
      if (row.some((c) => c.length > 0)) {
        rows.push(row);
      }
    }

    if (rows.length === 0) {
      throw new Error('No data rows found in delimited file.');
    }

    const detected = detectSpreadsheetStructure(rows, originalName, fallbackInvoiceNo);
    return {
      fileType: bestDelimiter === '\t' ? 'tsv' : 'csv',
      fileName: originalName,
      ...detected,
    };
  } catch (error) {
    console.error('[Delimited Parser Error]', error);
    throw new Error(`Failed to parse CSV/TSV table: ${error.message}`);
  }
};

/**
 * Parse Word / Office Document (.docx, .doc, .odt)
 */
const parseWordDocument = async (filePath, originalName, fallbackInvoiceNo = null) => {
  try {
    let extractedText = extractZipText(filePath);
    if (!extractedText || extractedText.length < 10) {
      // Fallback: read raw buffer strings
      const buffer = fs.readFileSync(filePath);
      extractedText = buffer.toString('utf8').replace(/[^\x20-\x7E\n\r\t]/g, ' ');
    }

    const parsed = parseBillText(extractedText, fallbackInvoiceNo);
    return {
      fileType: 'word',
      fileName: originalName,
      isMultiRow: false,
      extractedData: {
        ...parsed,
        docType: parsed.docType || 'invoice',
      },
    };
  } catch (error) {
    console.error('[Word Document Parser Error]', error);
    throw new Error(`Failed to parse Word document: ${error.message}`);
  }
};

/**
 * Parse HTML / XML Markup Documents
 */
const parseMarkupDocument = async (filePath, originalName, fallbackInvoiceNo = null) => {
  try {
    const content = fs.readFileSync(filePath, 'utf8');

    // Check if it contains a table
    if (content.includes('<table') || content.includes('<tr')) {
      const rows = [];
      const trMatches = content.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
      for (const tr of trMatches) {
        const cells = [];
        const tdMatches = tr.match(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi) || [];
        for (const td of tdMatches) {
          const clean = td.replace(/<[^>]+>/g, '').trim().replace(/&nbsp;/g, ' ');
          cells.push(clean);
        }
        if (cells.some((c) => c.length > 0)) rows.push(cells);
      }
      if (rows.length > 1) {
        const detected = detectSpreadsheetStructure(rows, originalName, fallbackInvoiceNo);
        return { fileType: 'markup', fileName: originalName, ...detected };
      }
    }

    const text = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');

    const parsed = parseBillText(text, fallbackInvoiceNo);
    return {
      fileType: 'markup',
      fileName: originalName,
      isMultiRow: false,
      extractedData: parsed,
    };
  } catch (error) {
    console.error('[Markup Parser Error]', error);
    throw new Error(`Failed to parse markup file: ${error.message}`);
  }
};

/**
 * Detect spreadsheet columns and categorize into Invoices, Stock Items, Sales, or Customers
 */
const detectSpreadsheetStructure = (rows, originalName, fallbackInvoiceNo = null) => {
  const defaultInvNo = fallbackInvoiceNo || 'INV-1';
  const lowerName = (originalName || '').toLowerCase();

  if (rows.length <= 1) {
    const line = rows.length === 1 ? rows[0].join(' ') : '';
    const parsed = parseBillText(line, defaultInvNo);
    return {
      isMultiRow: false,
      extractedData: parsed,
    };
  }

  const headerRow = rows[0].map((h) => String(h || '').trim().toLowerCase());
  const dataRows = rows.slice(1).filter((r) => r.some((c) => String(c || '').trim().length > 0));

  const findCol = (keywords) => {
    return headerRow.findIndex((h) => keywords.some((kw) => h === kw || h.includes(kw)));
  };

  const itemIdx = findCol(['item', 'product', 'description', 'particular', 'part', 'sku', 'goods']);
  const qtyIdx = findCol(['qty', 'quantity', 'units', 'count', 'nos']);
  const rateIdx = findCol(['rate', 'price', 'unit price', 'cost', 'unit rate']);
  const totalIdx = findCol(['total', 'amount', 'net', 'line total', 'total amount', 'gross']);
  const custIdx = findCol(['customer', 'client', 'vendor', 'party', 'buyer', 'party name', 'customer name']);
  const dateIdx = findCol(['date', 'bill date', 'invoice date', 'sale date', 'entry date', 'time']);
  const dueIdx = findCol(['due date', 'due', 'expiry', 'payment due']);
  const contactIdx = findCol(['contact', 'phone', 'email', 'mobile', 'address']);
  const termsIdx = findCol(['terms', 'billing terms', 'days', 'credit days']);
  const invNumIdx = findCol(['invoice #', 'inv no', 'invoice no', 'bill no', 'voucher no', 'doc #']);
  const statusIdx = findCol(['status', 'payment status', 'paid status']);

  // 1. Stock / Inventory Sheet
  const isExplicitStock = lowerName.includes('stock') || lowerName.includes('inventory') || lowerName.includes('item');
  const isStockColumns = itemIdx !== -1 && (qtyIdx !== -1 || rateIdx !== -1) && custIdx === -1 && invNumIdx === -1;

  if (isExplicitStock || isStockColumns) {
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

  // 2. Customer Directory Sheet
  const isExplicitCust = lowerName.includes('customer') || lowerName.includes('client') || lowerName.includes('directory');
  const isCustomerColumns = custIdx !== -1 && (contactIdx !== -1 || termsIdx !== -1) && qtyIdx === -1 && itemIdx === -1;

  if (isExplicitCust || isCustomerColumns) {
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

  // 3. Multi-Row Sales Sheet (Multiple transactions across customers/items)
  const isExplicitSales = lowerName.includes('sale') || lowerName.includes('transaction') || lowerName.includes('ledger');
  const isSalesColumns = (custIdx !== -1 || dateIdx !== -1) && itemIdx !== -1 && (qtyIdx !== -1 || rateIdx !== -1 || totalIdx !== -1);

  if (isExplicitSales || (isSalesColumns && dataRows.length > 1)) {
    const sales = dataRows.map((r, i) => {
      const customer_name = String(r[custIdx !== -1 ? custIdx : 0] || 'General Customer').trim();
      const item_name = String(r[itemIdx !== -1 ? itemIdx : 1] || `Item ${i + 1}`).trim();
      const units_sold = Math.max(1, parseInt(r[qtyIdx !== -1 ? qtyIdx : 2], 10) || 1);
      const rate = parseFloat(r[rateIdx !== -1 ? rateIdx : 3]) || 0;
      const total = totalIdx !== -1 && r[totalIdx] ? parseFloat(r[totalIdx]) : units_sold * rate;
      const sale_date = dateIdx !== -1 && r[dateIdx] ? String(r[dateIdx]).trim() : new Date().toISOString().split('T')[0];

      return {
        customer_name,
        item_name,
        units_sold,
        rate: rate || (units_sold > 0 ? parseFloat((total / units_sold).toFixed(2)) : 0),
        total: total || units_sold * rate,
        sale_date,
      };
    }).filter((s) => s.customer_name.length > 0 && s.item_name.length > 0);

    return {
      isMultiRow: true,
      importType: 'sales',
      summary: `Extracted ${sales.length} Sales transactions from ledger.`,
      items: sales,
    };
  }

  // 4. Invoices Table Sheet
  const isExplicitInvoices = lowerName.includes('invoice') || lowerName.includes('bill') || lowerName.includes('receivable');
  const isInvoicesColumns = (invNumIdx !== -1 || dueIdx !== -1 || statusIdx !== -1) && (totalIdx !== -1 || rateIdx !== -1);

  if (isExplicitInvoices && isInvoicesColumns && dataRows.length > 1) {
    const invoices = dataRows.map((r, i) => {
      const customer_name = String(r[custIdx !== -1 ? custIdx : 0] || 'General Customer').trim();
      const invoice_number = invNumIdx !== -1 && r[invNumIdx] ? String(r[invNumIdx]).trim() : `INV-${i + 1}`;
      const amount = parseFloat(r[totalIdx !== -1 ? totalIdx : 1]) || 0;
      const due_date = dueIdx !== -1 && r[dueIdx] ? String(r[dueIdx]).trim() : new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
      const status = statusIdx !== -1 && r[statusIdx] ? String(r[statusIdx]).trim().toLowerCase() : 'pending';

      return {
        customer_name,
        invoice_number,
        amount,
        due_date,
        status: ['pending', 'paid', 'overdue'].includes(status) ? status : 'pending',
      };
    }).filter((inv) => inv.customer_name.length > 0 && inv.amount > 0);

    return {
      isMultiRow: true,
      importType: 'invoices',
      summary: `Extracted ${invoices.length} Invoices from billing spreadsheet.`,
      items: invoices,
    };
  }

  // 5. Single itemized bill with line items
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
      // Check if stock or customers or sales
      const first = json[0] || {};
      let importType = 'stock';
      if (first.billing_terms !== undefined || (first.contact_info !== undefined && first.name !== undefined)) {
        importType = 'customers';
      } else if (first.customer_name !== undefined || first.units_sold !== undefined) {
        importType = 'sales';
      } else if (first.amount !== undefined && first.due_date !== undefined) {
        importType = 'invoices';
      }

      return {
        fileType: 'json',
        fileName: originalName,
        isMultiRow: true,
        importType,
        items: json,
        summary: `Extracted ${json.length} records from JSON array.`,
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
  try {
    const parsed = await processBillImage(filePath, fallbackInvoiceNo);
    return {
      fileType: 'image',
      fileName: originalName,
      isMultiRow: false,
      extractedData: parsed,
    };
  } catch (error) {
    console.warn('[Image OCR warning, providing structured editable template]:', error.message);
    const fallbackData = parseBillText(`Scanned Image ${originalName}`, fallbackInvoiceNo);
    return {
      fileType: 'image',
      fileName: originalName,
      isMultiRow: false,
      extractedData: fallbackData,
    };
  }
};

module.exports = {
  parseUniversalFile,
  parsePDFDocument,
  parseExcelDocument,
  parseLegacyExcelDocument,
  parseDelimitedDocument,
  parseWordDocument,
  parseMarkupDocument,
  parseJSONDocument,
  parsePlainTextDocument,
  parseImageDocument,
};
