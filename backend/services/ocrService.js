const Tesseract = require('tesseract.js');
const fs = require('fs');

/**
 * Intelligent parser for Bills, Invoices, and Receipts
 */
const parseBillText = (text) => {
  if (!text || typeof text !== 'string') {
    return {
      docType: 'invoice',
      invoiceNumber: `INV-${Date.now().toString().slice(-6)}`,
      vendorName: 'Scanned Vendor',
      customerName: 'Default Customer',
      contactInfo: '',
      taxId: '',
      invoiceDate: new Date().toISOString().split('T')[0],
      dueDate: new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
      items: [{ description: 'General Item', quantity: 1, unit_price: 0, total: 0 }],
      subtotal: 0,
      taxRate: 0,
      taxAmount: 0,
      discount: 0,
      totalAmount: 0,
      paymentStatus: 'pending',
      paymentMode: 'Bank Transfer',
      category: 'General Supplies',
      confidence: { overall: 'low', fields: {} },
      rawText: '',
    };
  }

  const rawLines = text.split('\n');
  const cleanLines = rawLines.map((l) => l.trim()).filter((l) => l.length > 0);
  const lowerText = text.toLowerCase();

  // 1. Detect Document Type
  let docType = 'invoice';
  if (lowerText.includes('receipt') || lowerText.includes('cash memo')) {
    docType = 'receipt';
  } else if (lowerText.includes('purchase order') || lowerText.includes('vendor bill') || lowerText.includes('tax bill')) {
    docType = 'bill';
  }

  // 2. Detect Invoice / Bill Number
  let invoiceNumber = '';
  const invNumPatterns = [
    /(?:invoice|bill|receipt|tax\s*invoice|inv|ref|doc|order)\s*(?:no\.?|num|number|#|code)?\s*[:\-\s]\s*([a-zA-Z0-9\-_/]{3,30})/i,
    /\b(INV[-/][0-9]{3,10})\b/i,
    /\b(BILL[-/][0-9]{3,10})\b/i,
    /#\s*([a-zA-Z0-9\-_/]{3,20})/i,
    /\b([A-Z]{2,4}[-][0-9]{4,8})\b/,
  ];

  for (const pattern of invNumPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const candidate = match[1].trim().replace(/[:;,]$/, '');
      if (candidate.length >= 3 && !['date', 'total', 'amount', 'name', 'phone', 'mail'].includes(candidate.toLowerCase())) {
        invoiceNumber = candidate;
        break;
      }
    }
  }

  if (!invoiceNumber) {
    invoiceNumber = `INV-${Math.floor(100000 + Math.random() * 900000)}`;
  }

  // 3. Detect Vendor / Company Name
  let vendorName = '';
  // Check for explicit "From:", "Vendor:", "Supplier:", "Billed By:"
  const vendorLabelMatch = text.match(/(?:from|vendor|supplier|billed\s*by|seller|merchant)\s*[:\-]\s*([a-zA-Z0-9\s&.,'-]{3,50})/i);
  if (vendorLabelMatch && vendorLabelMatch[1]) {
    vendorName = vendorLabelMatch[1].trim();
  }

  if (!vendorName) {
    // Pick the most prominent early line that isn't a generic heading
    const headerCandidates = cleanLines.slice(0, 6).filter((line) => {
      const lower = line.toLowerCase();
      return (
        !lower.includes('invoice') &&
        !lower.includes('tax invoice') &&
        !lower.includes('bill of supply') &&
        !lower.includes('receipt') &&
        !lower.includes('date') &&
        !lower.includes('phone') &&
        !lower.includes('tel:') &&
        !lower.includes('email') &&
        !lower.includes('gstin') &&
        !lower.includes('gst') &&
        !lower.includes('pan') &&
        !lower.includes('address') &&
        !lower.includes('welcome') &&
        !lower.includes('original') &&
        !lower.includes('duplicate') &&
        line.replace(/[^a-zA-Z]/g, '').length >= 3
      );
    });

    if (headerCandidates.length > 0) {
      vendorName = headerCandidates[0].replace(/[^a-zA-Z0-9\s&.,'-]/g, '').trim();
    }
  }

  if (!vendorName) {
    vendorName = 'Scanned Vendor / Supplier';
  }

  // 4. Detect Customer / Buyer Name
  let customerName = '';
  const customerLabelMatch = text.match(/(?:to|bill\s*to|ship\s*to|customer|client|buyer|billed\s*to)\s*[:\-]\s*([a-zA-Z0-9\s&.,'-]{3,50})/i);
  if (customerLabelMatch && customerLabelMatch[1]) {
    customerName = customerLabelMatch[1].trim();
  }
  if (!customerName) {
    customerName = vendorName; // default to vendor/issuer name
  }

  // 5. Detect Tax ID / GSTIN / PAN / VAT
  let taxId = '';
  const gstMatch = text.match(/\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1})\b/); // Standard 15-digit GSTIN
  if (gstMatch && gstMatch[1]) {
    taxId = gstMatch[1];
  } else {
    const genericTax = text.match(/(?:gstin|gst|tax\s*id|vat|pan|ein)\s*(?:no\.?|#)?\s*[:\-]?\s*([a-zA-Z0-9\-_]{6,20})/i);
    if (genericTax && genericTax[1]) {
      taxId = genericTax[1].trim();
    }
  }

  // 6. Detect Contact Info (Phone / Email)
  let contactInfo = '';
  const phoneMatch = text.match(/(?:tel|phone|mob|contact|cell)?\s*[:\-]?\s*(\+?[0-9]{1,3}[-.\s]?[0-9]{3,5}[-.\s]?[0-9]{3,5})/i);
  if (phoneMatch && phoneMatch[1] && phoneMatch[1].replace(/[^0-9]/g, '').length >= 8) {
    contactInfo += phoneMatch[1].trim();
  }
  const emailMatch = text.match(/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/);
  if (emailMatch && emailMatch[1]) {
    contactInfo = contactInfo ? `${contactInfo} | ${emailMatch[1]}` : emailMatch[1];
  }

  // 7. Detect Dates (Invoice Date & Due Date)
  let invoiceDate = '';
  let dueDate = '';

  const datePatterns = [
    /\b(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\b/, // 2026-08-28
    /\b(\d{1,2}[-/.]\d{1,2}[-/.]\d{4})\b/, // 28/08/2026 or 08/28/2026
    /\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})\b/i,
    /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/i,
  ];

  // Look for explicit "Date:" line
  const dateLineMatch = text.match(/(?:date|invoice\s*date|bill\s*date|dated)\s*[:\-]?\s*([0-9a-zA-Z\s,./-]{6,25})/i);
  if (dateLineMatch && dateLineMatch[1]) {
    for (const pat of datePatterns) {
      const match = dateLineMatch[1].match(pat);
      if (match && match[1]) {
        const parsed = new Date(match[1]);
        if (!isNaN(parsed.getTime())) {
          invoiceDate = parsed.toISOString().split('T')[0];
          break;
        }
      }
    }
  }

  // Fallback date match across entire text
  if (!invoiceDate) {
    for (const pattern of datePatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        try {
          const parsedDate = new Date(match[1]);
          if (!isNaN(parsedDate.getTime())) {
            invoiceDate = parsedDate.toISOString().split('T')[0];
            break;
          }
        } catch (e) {}
      }
    }
  }

  if (!invoiceDate) {
    invoiceDate = new Date().toISOString().split('T')[0];
  }

  // Look for Due Date
  const dueDateMatch = text.match(/(?:due\s*date|payment\s*due|pay\s*by)\s*[:\-]?\s*([0-9a-zA-Z\s,./-]{6,25})/i);
  if (dueDateMatch && dueDateMatch[1]) {
    for (const pat of datePatterns) {
      const match = dueDateMatch[1].match(pat);
      if (match && match[1]) {
        const parsed = new Date(match[1]);
        if (!isNaN(parsed.getTime())) {
          dueDate = parsed.toISOString().split('T')[0];
          break;
        }
      }
    }
  }

  if (!dueDate) {
    const invD = new Date(invoiceDate);
    invD.setDate(invD.getDate() + 30);
    dueDate = invD.toISOString().split('T')[0];
  }

  // 8. Financial Amounts Extraction (Total, Subtotal, Tax, Discount)
  let totalAmount = null;
  let subtotal = null;
  let taxRate = 0;
  let taxAmount = 0;
  let discount = 0;

  // Total patterns
  const totalKeywords = [
    'grand total',
    'net payable',
    'total amount',
    'balance due',
    'amount due',
    'invoice total',
    'final amount',
    'total:',
    'total',
  ];

  for (const line of cleanLines) {
    const lower = line.toLowerCase();
    for (const kw of totalKeywords) {
      if (lower.includes(kw)) {
        const amtMatch = line.match(/(?:[$€£₹]?)\s*([\d,]+\.\d{2}|\b\d+\b)/);
        if (amtMatch && amtMatch[1]) {
          const num = parseFloat(amtMatch[1].replace(/,/g, ''));
          if (!isNaN(num) && num > 0) {
            totalAmount = num;
            break;
          }
        }
      }
    }
    if (totalAmount) break;
  }

  // Subtotal check
  for (const line of cleanLines) {
    const lower = line.toLowerCase();
    if (lower.includes('subtotal') || lower.includes('sub total') || lower.includes('net total')) {
      const amtMatch = line.match(/(?:[$€£₹]?)\s*([\d,]+\.\d{2}|\b\d+\b)/);
      if (amtMatch && amtMatch[1]) {
        const num = parseFloat(amtMatch[1].replace(/,/g, ''));
        if (!isNaN(num) && num > 0) {
          subtotal = num;
          break;
        }
      }
    }
  }

  // Tax detection (GST / VAT / Tax)
  const taxMatch = text.match(/(?:gst|tax|vat|cgst|sgst|igst)\s*(?:@\s*)?(\d{1,2}(?:\.\d{1,2})?)\s*%/i);
  if (taxMatch && taxMatch[1]) {
    taxRate = parseFloat(taxMatch[1]) || 0;
  }

  const taxAmtMatch = text.match(/(?:tax\s*amount|total\s*tax|gst\s*amount|vat\s*amount)\s*[:\-]?\s*(?:[$€£₹]?)\s*([\d,]+\.\d{2})/i);
  if (taxAmtMatch && taxAmtMatch[1]) {
    taxAmount = parseFloat(taxAmtMatch[1].replace(/,/g, '')) || 0;
  }

  // Discount detection
  const discMatch = text.match(/(?:discount|disc|savings)\s*[:\-]?\s*(?:[$€£₹]?)\s*([\d,]+\.\d{2})/i);
  if (discMatch && discMatch[1]) {
    discount = parseFloat(discMatch[1].replace(/,/g, '')) || 0;
  }

  // Fallback Amount Check
  if (!totalAmount) {
    const allAmounts = [];
    const amountRegex = /(?:[$€£₹]?)\s*(\d{1,3}(?:,\d{3})*\.\d{2})/g;
    let match;
    while ((match = amountRegex.exec(text)) !== null) {
      const val = parseFloat(match[1].replace(/,/g, ''));
      if (!isNaN(val) && val > 0) allAmounts.push(val);
    }
    if (allAmounts.length > 0) {
      totalAmount = Math.max(...allAmounts);
    } else {
      totalAmount = 0;
    }
  }

  if (!subtotal) {
    subtotal = totalAmount;
  }

  // 9. Line Items Extraction
  const items = [];
  const itemLineRegex = /^([a-zA-Z0-9\s&.,'-]{3,40})\s+(\d+)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$/;

  for (const line of cleanLines) {
    const match = line.match(itemLineRegex);
    if (match) {
      const desc = match[1].trim();
      const qty = parseInt(match[2], 10);
      const rate = parseFloat(match[3].replace(/,/g, ''));
      const lineTot = parseFloat(match[4].replace(/,/g, ''));

      if (desc && !['subtotal', 'total', 'tax', 'discount'].includes(desc.toLowerCase())) {
        items.push({
          description: desc,
          quantity: qty > 0 ? qty : 1,
          unit_price: rate,
          total: lineTot || qty * rate,
        });
      }
    }
  }

  // If no structured item table rows matched, provide a default clean line item from total
  if (items.length === 0) {
    let mainItemDesc = 'General Inventory / Accounting Item';
    // Try to find a descriptive product or service line
    for (const line of cleanLines.slice(2, 10)) {
      if (
        line.length > 4 &&
        line.length < 50 &&
        !line.match(/\d{4}/) &&
        !line.toLowerCase().includes('total') &&
        !line.toLowerCase().includes('invoice') &&
        !line.toLowerCase().includes('date') &&
        !line.toLowerCase().includes('phone')
      ) {
        mainItemDesc = line.replace(/[^a-zA-Z0-9\s&.,'-]/g, '').trim();
        break;
      }
    }

    items.push({
      description: mainItemDesc,
      quantity: 1,
      unit_price: subtotal || totalAmount,
      total: subtotal || totalAmount,
    });
  }

  // 10. Payment Status & Mode
  let paymentStatus = 'pending';
  let paymentMode = 'Bank Transfer';

  if (lowerText.includes('paid in full') || lowerText.includes('payment received') || lowerText.includes('status: paid') || docType === 'receipt') {
    paymentStatus = 'paid';
  }

  if (lowerText.includes('upi') || lowerText.includes('gpay') || lowerText.includes('phonepe') || lowerText.includes('paytm')) {
    paymentMode = 'UPI';
  } else if (lowerText.includes('cash')) {
    paymentMode = 'Cash';
  } else if (lowerText.includes('card') || lowerText.includes('visa') || lowerText.includes('mastercard')) {
    paymentMode = 'Credit Card';
  } else if (lowerText.includes('cheque') || lowerText.includes('check')) {
    paymentMode = 'Cheque';
  }

  // 11. Category Classification
  let category = 'General Supplies';
  if (lowerText.includes('fuel') || lowerText.includes('travel') || lowerText.includes('cab') || lowerText.includes('flight')) {
    category = 'Travel & Transportation';
  } else if (lowerText.includes('server') || lowerText.includes('software') || lowerText.includes('subscription') || lowerText.includes('hosting')) {
    category = 'Software & Tech';
  } else if (lowerText.includes('office') || lowerText.includes('stationery') || lowerText.includes('paper') || lowerText.includes('print')) {
    category = 'Office Supplies';
  } else if (lowerText.includes('electricity') || lowerText.includes('power') || lowerText.includes('water') || lowerText.includes('internet')) {
    category = 'Utilities';
  } else if (lowerText.includes('consulting') || lowerText.includes('service') || lowerText.includes('audit') || lowerText.includes('legal')) {
    category = 'Professional Services';
  }

  return {
    docType,
    invoiceNumber,
    vendorName,
    customerName,
    contactInfo,
    taxId,
    invoiceDate,
    dueDate,
    items,
    subtotal: parseFloat((subtotal || totalAmount).toFixed(2)),
    taxRate,
    taxAmount: parseFloat(taxAmount.toFixed(2)),
    discount: parseFloat(discount.toFixed(2)),
    totalAmount: parseFloat(totalAmount.toFixed(2)),
    paymentStatus,
    paymentMode,
    category,
    confidence: {
      overall: totalAmount > 0 && vendorName ? 'high' : 'medium',
      vendor: vendorName ? 95 : 50,
      amount: totalAmount > 0 ? 98 : 40,
      date: invoiceDate ? 95 : 60,
      invoiceNumber: invoiceNumber ? 90 : 50,
    },
    rawText: text,
  };
};

/**
 * Process image file and extract data using Tesseract OCR
 * @param {string} imagePath - Path to the image
 */
const processBillImage = async (imagePath) => {
  try {
    const { data: { text } } = await Tesseract.recognize(imagePath, 'eng', {
      logger: () => {}, // suppress verbosity in prod
    });

    const parsed = parseBillText(text);
    return parsed;
  } catch (error) {
    console.error('[OCR Service Error]', error);
    throw new Error(`OCR processing failed: ${error.message}`);
  }
};

module.exports = {
  processBillImage,
  parseBillText,
};
