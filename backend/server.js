require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const { authenticateToken, requireRole } = require('./middleware/auth');
const errorHandler = require('./middleware/errorHandler');
const { initInvoiceCron, runInvoiceStatusCheck } = require('./jobs/invoiceCron');
const { regenerateExcelReports } = require('./services/excelService');

// Controllers
const authCtrl = require('./controllers/authController');
const customerCtrl = require('./controllers/customerController');
const stockCtrl = require('./controllers/stockController');
const salesCtrl = require('./controllers/salesController');
const invoiceCtrl = require('./controllers/invoiceController');
const paymentCtrl = require('./controllers/paymentController');
const ocrCtrl = require('./controllers/ocrController');
const reportCtrl = require('./controllers/reportController');

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../frontend/public')));
app.use('/css', express.static(path.join(__dirname, '../frontend/css')));
app.use('/js', express.static(path.join(__dirname, '../frontend/js')));

// Ensure directories
['exports', 'uploads'].forEach((dir) => {
  const dirPath = path.join(__dirname, '..', dir);
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
});

// ==========================================
// API ROUTES
// ==========================================

// 1. Auth Routes (Public)
app.get('/api/auth/setup-status', authCtrl.checkSetupStatus);
app.post('/api/auth/setup-admin', authCtrl.setupAdmin);
app.post('/api/auth/login', authCtrl.login);
app.get('/api/auth/me', authenticateToken, authCtrl.getMe);
app.post('/api/auth/register-user', authenticateToken, requireRole('admin'), authCtrl.registerUser);

// 2. Customer Routes (Protected)
app.get('/api/customers', authenticateToken, customerCtrl.getAllCustomers);
app.get('/api/customers/:id', authenticateToken, customerCtrl.getCustomerById);
app.post('/api/customers', authenticateToken, customerCtrl.createCustomer);
app.put('/api/customers/:id', authenticateToken, customerCtrl.updateCustomer);
app.delete('/api/customers/:id', authenticateToken, customerCtrl.deleteCustomer);

// 3. Stock Item Routes (Protected)
app.get('/api/stock', authenticateToken, stockCtrl.getAllStock);
app.get('/api/stock/:id', authenticateToken, stockCtrl.getStockById);
app.post('/api/stock', authenticateToken, stockCtrl.createStock);
app.put('/api/stock/:id', authenticateToken, stockCtrl.updateStock);
app.delete('/api/stock/:id', authenticateToken, stockCtrl.deleteStock);

// 4. Sales Routes (Protected)
app.get('/api/sales', authenticateToken, salesCtrl.getAllSales);
app.get('/api/sales/:id', authenticateToken, salesCtrl.getSaleById);
app.post('/api/sales', authenticateToken, salesCtrl.createSale);
app.put('/api/sales/:id', authenticateToken, salesCtrl.updateSale);
app.delete('/api/sales/:id', authenticateToken, salesCtrl.deleteSale);

// 5. Invoice Routes (Protected)
app.get('/api/invoices', authenticateToken, invoiceCtrl.getAllInvoices);
app.get('/api/invoices/reminders', authenticateToken, invoiceCtrl.getRemindersLog);
app.get('/api/invoices/:id', authenticateToken, invoiceCtrl.getInvoiceById);
app.put('/api/invoices/:id', authenticateToken, invoiceCtrl.updateInvoice);
app.delete('/api/invoices/:id', authenticateToken, invoiceCtrl.deleteInvoice);

// 6. Payment Routes (Protected)
app.get('/api/payments', authenticateToken, paymentCtrl.getAllPayments);
app.get('/api/payments/:id', authenticateToken, paymentCtrl.getPaymentById);
app.post('/api/payments', authenticateToken, paymentCtrl.createPayment);
app.put('/api/payments/:id', authenticateToken, paymentCtrl.updatePayment);
app.delete('/api/payments/:id', authenticateToken, paymentCtrl.deletePayment);

// 7. OCR Bill Scanning Route (Protected)
app.post('/api/ocr/scan', authenticateToken, ocrCtrl.upload.single('bill_image'), ocrCtrl.scanBillImage);
app.post('/api/ocr/confirm', authenticateToken, ocrCtrl.confirmExtractedBill);

// 8. Reports & Excel Export Routes (Protected)
app.get('/api/reports/stats', authenticateToken, reportCtrl.getDashboardStats);
app.get('/api/reports/excel/lifetime', authenticateToken, reportCtrl.downloadLifetimeExcel);
app.get('/api/reports/excel/monthly', authenticateToken, reportCtrl.downloadMonthlyExcel);
app.post('/api/reports/excel/sync', authenticateToken, reportCtrl.syncExcel);

// 9. Cron Verification Trigger (Protected)
app.post('/api/cron/run-check', authenticateToken, async (req, res, next) => {
  try {
    const result = await runInvoiceStatusCheck();
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Centralized error handler
app.use(errorHandler);

// Wildcard fallback for HTML pages
app.get('*', (req, res) => {
  // If requesting an html page that exists, send it
  const reqPath = req.path === '/' ? '/index.html' : req.path;
  const filePath = path.join(__dirname, '../frontend/public', reqPath.endsWith('.html') ? reqPath : `${reqPath}.html`);
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

// Start Server
if (require.main === module) {
  const server = app.listen(PORT, async () => {
    console.log(`🚀 Accounting Server running on http://localhost:${PORT}`);
    
    // Initialize background cron job
    initInvoiceCron();

    // Generate initial blank Excel reports
    regenerateExcelReports().catch((e) => console.warn('Initial Excel generation:', e.message));
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ Port ${PORT} is already in use by another process.`);
      console.error(`👉 You can free it with: npx kill-port ${PORT} (or change PORT in .env)`);
    } else {
      console.error('Server error:', err);
    }
    process.exit(1);
  });
}

module.exports = app;
