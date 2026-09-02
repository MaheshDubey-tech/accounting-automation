const path = require('path');
const fs = require('fs');
const { query } = require('../config/db');
const { regenerateExcelReports, EXPORTS_DIR } = require('../services/excelService');

/**
 * Get dashboard KPI financial summaries
 */
const getDashboardStats = async (req, res, next) => {
  try {
    // 1. Total lifetime sales & count
    const salesTotalRes = await query(`
      SELECT 
        COALESCE(SUM(units_sold * rate), 0) AS lifetime_sales_amount,
        COUNT(id) AS total_sales_count
      FROM sales;
    `);

    // 2. Total sales this month
    const monthlySalesRes = await query(`
      SELECT 
        COALESCE(SUM(units_sold * rate), 0) AS month_sales_amount,
        COUNT(id) AS month_sales_count
      FROM sales
      WHERE DATE_TRUNC('month', sale_date) = DATE_TRUNC('month', CURRENT_DATE);
    `);

    // 3. Invoice metrics (pending, overdue, paid counts and sums)
    const invoiceStatsRes = await query(`
      SELECT 
        status,
        COUNT(id) AS count,
        COALESCE(SUM(amount), 0) AS total_amount
      FROM invoices
      GROUP BY status;
    `);

    // 4. Total payments collected
    const paymentsRes = await query(`
      SELECT 
        COALESCE(SUM(amount_paid), 0) AS total_collected_lifetime,
        COUNT(id) AS total_payments_count
      FROM payments;
    `);

    // 5. Total payments collected this month
    const monthlyPaymentsRes = await query(`
      SELECT 
        COALESCE(SUM(amount_paid), 0) AS month_collected_amount
      FROM payments
      WHERE DATE_TRUNC('month', payment_date) = DATE_TRUNC('month', CURRENT_DATE);
    `);

    // 6. Recent activity (latest 5 sales, latest 5 invoices, latest 5 payments)
    const recentSales = await query(`
      SELECT s.id, s.units_sold, s.rate, (s.units_sold * s.rate) AS total, s.sale_date, c.name AS customer_name, i.name AS item_name
      FROM sales s
      JOIN customers c ON s.customer_id = c.id
      JOIN stock_items i ON s.item_id = i.id
      ORDER BY s.sale_date DESC, s.id DESC LIMIT 5;
    `);

    const recentInvoices = await query(`
      SELECT inv.id, inv.amount, inv.due_date, inv.status, c.name AS customer_name
      FROM invoices inv
      JOIN customers c ON inv.customer_id = c.id
      ORDER BY inv.created_at DESC LIMIT 5;
    `);

    // Stock alert (items with low inventory < 10)
    const lowStock = await query(`
      SELECT id, name, unit_price, quantity_available
      FROM stock_items
      WHERE quantity_available <= 10
      ORDER BY quantity_available ASC LIMIT 5;
    `);

    const invoiceMap = {
      pending: { count: 0, amount: 0 },
      overdue: { count: 0, amount: 0 },
      paid: { count: 0, amount: 0 },
    };

    invoiceStatsRes.rows.forEach((r) => {
      invoiceMap[r.status] = {
        count: parseInt(r.count, 10),
        amount: parseFloat(r.total_amount),
      };
    });

    res.json({
      success: true,
      data: {
        lifetimeSales: parseFloat(salesTotalRes.rows[0].lifetime_sales_amount),
        lifetimeSalesCount: parseInt(salesTotalRes.rows[0].total_sales_count, 10),
        monthSales: parseFloat(monthlySalesRes.rows[0].month_sales_amount),
        monthSalesCount: parseInt(monthlySalesRes.rows[0].month_sales_count, 10),
        lifetimeCollected: parseFloat(paymentsRes.rows[0].total_collected_lifetime),
        monthCollected: parseFloat(monthlyPaymentsRes.rows[0].month_collected_amount),
        pendingInvoices: invoiceMap.pending,
        overdueInvoices: invoiceMap.overdue,
        paidInvoices: invoiceMap.paid,
        recentSales: recentSales.rows,
        recentInvoices: recentInvoices.rows,
        lowStockItems: lowStock.rows,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Download Lifetime Sales Excel sheet
 */
const downloadLifetimeExcel = async (req, res, next) => {
  try {
    const filePath = path.join(EXPORTS_DIR, 'sales_lifetime.xlsx');
    if (!fs.existsSync(filePath)) {
      await regenerateExcelReports();
    }
    res.download(filePath, 'Accounting_Master_Report.xlsx');
  } catch (error) {
    next(error);
  }
};

/**
 * Download Monthly Sales Excel sheet
 */
const downloadMonthlyExcel = async (req, res, next) => {
  try {
    const filePath = path.join(EXPORTS_DIR, 'sales_current_month.xlsx');
    if (!fs.existsSync(filePath)) {
      await regenerateExcelReports();
    }
    const currentMonthStr = new Date().toLocaleString('default', { month: 'short', year: 'numeric' }).replace(' ', '_');
    res.download(filePath, `Accounting_Report_${currentMonthStr}.xlsx`);
  } catch (error) {
    next(error);
  }
};

/**
 * Trigger manual regeneration of both Excel sheets
 */
const syncExcel = async (req, res, next) => {
  try {
    const files = await regenerateExcelReports();
    res.json({
      success: true,
      message: 'Excel reports regenerated successfully.',
      files,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getDashboardStats,
  downloadLifetimeExcel,
  downloadMonthlyExcel,
  syncExcel,
};
