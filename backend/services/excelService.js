const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const { query } = require('../config/db');

const EXPORTS_DIR = path.resolve(process.env.EXPORTS_DIR || path.join(__dirname, '../../exports'));

// Ensure exports directory exists
if (!fs.existsSync(EXPORTS_DIR)) {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
}

/**
 * Format date string YYYY-MM-DD
 */
const formatDate = (date) => {
  if (!date) return '';
  const d = new Date(date);
  return d.toISOString().split('T')[0];
};

/**
 * Build styled Excel workbook
 */
const generateWorkbook = async (isCurrentMonthOnly = false) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Accounting System';
  workbook.created = new Date();

  // Query Sales data
  let salesQuery = `
    SELECT 
      s.id AS sale_id,
      s.sale_date,
      c.name AS customer_name,
      c.billing_terms,
      i.name AS item_name,
      s.units_sold,
      s.rate,
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
  `;

  const queryParams = [];
  if (isCurrentMonthOnly) {
    salesQuery += ` WHERE DATE_TRUNC('month', s.sale_date) = DATE_TRUNC('month', CURRENT_DATE)`;
  }

  salesQuery += ` GROUP BY s.id, c.name, c.billing_terms, i.name, inv.id, inv.due_date, inv.status ORDER BY s.sale_date DESC, s.id DESC`;

  const salesResult = await query(salesQuery, queryParams);
  const rows = salesResult.rows;

  // 1. Sales & Invoices Sheet
  const sheetTitle = isCurrentMonthOnly ? 'Current Month Sales' : 'Lifetime Sales';
  const worksheet = workbook.addWorksheet(sheetTitle, {
    views: [{ showGridLines: true }],
  });

  // Header Title Row
  worksheet.mergeCells('A1', 'K1');
  const titleCell = worksheet.getCell('A1');
  titleCell.value = `Accounting Master Report - ${sheetTitle} (Generated: ${new Date().toLocaleString()})`;
  titleCell.font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1E293B' }, // Dark slate
  };
  titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
  worksheet.getRow(1).height = 30;

  // Table Columns
  worksheet.getRow(3).values = [
    'Sale ID',
    'Sale Date',
    'Customer Name',
    'Item Description',
    'Units Sold',
    'Unit Rate ($)',
    'Total Amount ($)',
    'Invoice #',
    'Due Date',
    'Invoice Status',
    'Amount Paid ($)',
  ];

  const headerRow = worksheet.getRow(3);
  headerRow.height = 24;
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  for (let i = 1; i <= 11; i++) {
    const cell = headerRow.getCell(i);
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF2563EB' }, // Royal Blue
    };
    cell.border = {
      top: { style: 'thin' },
      left: { style: 'thin' },
      bottom: { style: 'medium' },
      right: { style: 'thin' },
    };
  }

  let totalSalesSum = 0;
  let totalPaidSum = 0;

  let currentRowIdx = 4;
  rows.forEach((row) => {
    const total = parseFloat(row.total_amount) || 0;
    const paid = parseFloat(row.total_paid) || 0;
    totalSalesSum += total;
    totalPaidSum += paid;

    const dataRow = worksheet.getRow(currentRowIdx);
    dataRow.values = [
      row.sale_id,
      formatDate(row.sale_date),
      row.customer_name,
      row.item_name,
      parseInt(row.units_sold, 10),
      parseFloat(row.rate),
      total,
      row.invoice_id ? `INV-${row.invoice_id}` : 'N/A',
      formatDate(row.due_date),
      (row.invoice_status || 'N/A').toUpperCase(),
      paid,
    ];

    // Status coloring
    const statusCell = dataRow.getCell(10);
    if (row.invoice_status === 'paid') {
      statusCell.font = { color: { argb: 'FF16A34A' }, bold: true };
    } else if (row.invoice_status === 'overdue') {
      statusCell.font = { color: { argb: 'FFDC2626' }, bold: true };
    } else {
      statusCell.font = { color: { argb: 'FFD97706' }, bold: true };
    }

    // Number formats
    dataRow.getCell(6).numFmt = '$#,##0.00';
    dataRow.getCell(7).numFmt = '$#,##0.00';
    dataRow.getCell(11).numFmt = '$#,##0.00';

    // Borders
    for (let c = 1; c <= 11; c++) {
      dataRow.getCell(c).border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      };
    }

    currentRowIdx++;
  });

  // Summary Row
  if (rows.length > 0) {
    const summaryRow = worksheet.getRow(currentRowIdx);
    summaryRow.values = [
      'TOTALS',
      '',
      '',
      '',
      '',
      '',
      totalSalesSum,
      '',
      '',
      '',
      totalPaidSum,
    ];
    summaryRow.font = { bold: true };
    summaryRow.getCell(7).numFmt = '$#,##0.00';
    summaryRow.getCell(11).numFmt = '$#,##0.00';
    for (let c = 1; c <= 11; c++) {
      summaryRow.getCell(c).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF1F5F9' },
      };
      summaryRow.getCell(c).border = {
        top: { style: 'medium' },
        bottom: { style: 'double' },
      };
    }
  }

  // Adjust column widths automatically
  worksheet.columns.forEach((column) => {
    let maxLength = 0;
    column.eachCell({ includeEmpty: true }, (cell) => {
      const colVal = cell.value ? cell.value.toString() : '';
      maxLength = Math.max(maxLength, colVal.length);
    });
    column.width = Math.max(maxLength + 4, 12);
  });

  return workbook;
};

/**
 * Regenerate both lifetime and monthly Excel files
 */
const regenerateExcelReports = async () => {
  try {
    const lifetimeWorkbook = await generateWorkbook(false);
    const lifetimePath = path.join(EXPORTS_DIR, 'sales_lifetime.xlsx');
    await lifetimeWorkbook.xlsx.writeFile(lifetimePath);

    const monthlyWorkbook = await generateWorkbook(true);
    const monthlyPath = path.join(EXPORTS_DIR, 'sales_current_month.xlsx');
    await monthlyWorkbook.xlsx.writeFile(monthlyPath);

    console.log(`[ExcelService] Updated Excel files at ${new Date().toISOString()}`);
    return { lifetimePath, monthlyPath };
  } catch (error) {
    console.error('[ExcelService] Failed to regenerate Excel sheets:', error);
    throw error;
  }
};

module.exports = {
  regenerateExcelReports,
  generateWorkbook,
  EXPORTS_DIR,
};
