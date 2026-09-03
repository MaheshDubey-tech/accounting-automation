/**
 * Accounting Main Application Controller
 * Handles Navigation, State Management, Cascade Deletions,
 * Live Camera Scanner, Automatic OCR Extraction, and Verification Workflows.
 */
const App = (() => {
  // Application State
  const state = {
    user: null,
    customers: [],
    stock: [],
    sales: [],
    invoices: [],
    payments: [],
    reminders: [],
    users: [],
    stats: {},
    activeSection: 'dashboard',
    invoiceFilter: 'all',
    currentOCRData: null,
    ocrZoomLevel: 1,
    cameraStream: null,
    cameraFacingMode: 'environment',
    scanHistory: [],
  };

  // Helper formatting functions
  const formatCurrency = (amount) => {
    const val = parseFloat(amount) || 0;
    return '₹' + val.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return 'N/A';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  const getTodayDateStr = () => new Date().toISOString().split('T')[0];

  const escapeHtml = (str) => {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[m]));
  };

  const extractData = (res) => {
    if (res && res.data !== undefined) return res.data;
    return res;
  };

  // ==========================================
  // NAVIGATION & ROUTING
  // ==========================================
  const navigateTo = (sectionId) => {
    const target = sectionId.replace('#', '') || 'dashboard';
    state.activeSection = target;

    // Update Sidebar Links
    document.querySelectorAll('.sidebar__nav .nav-link').forEach((link) => {
      if (link.getAttribute('data-nav') === target) {
        link.classList.add('active');
      } else {
        link.classList.remove('active');
      }
    });

    // Update Content Sections
    document.querySelectorAll('.app-section').forEach((sec) => {
      if (sec.id === `section-${target}`) {
        sec.classList.add('active');
      } else {
        sec.classList.remove('active');
      }
    });

    // Update Page Header Title
    const titles = {
      dashboard: 'Financial Overview',
      customers: 'Customers Directory',
      stock: 'Stock Inventory',
      sales: 'Sales Entry & Ledger',
      invoices: 'Invoices & Notices Tracker',
      payments: 'Payments Ledger',
      ocr: 'Intelligent Bill & Invoice Scanner',
      reports: 'Excel Reports & Analytics',
      users: 'User Account Management',
    };
    const titleEl = document.getElementById('pageTitle');
    if (titleEl) titleEl.textContent = titles[target] || 'Accounting';

    // Auto-refresh data on navigation
    refreshCurrentSectionData(target);
  };

  const refreshCurrentSectionData = (section) => {
    switch (section) {
      case 'dashboard':
        loadDashboardStats();
        break;
      case 'customers':
        loadCustomers();
        break;
      case 'stock':
        loadStock();
        break;
      case 'sales':
        loadSales();
        loadCustomers();
        loadStock();
        break;
      case 'invoices':
        loadInvoices();
        loadReminders();
        break;
      case 'payments':
        loadPayments();
        loadInvoices();
        break;
      case 'users':
        if (state.user && state.user.role === 'admin') loadUsers();
        break;
    }
  };

  // Global Refresh - updates every view & stats when data is added/deleted
  const refreshAllData = async () => {
    try {
      await Promise.allSettled([
        loadDashboardStats(),
        loadCustomers(),
        loadStock(),
        loadSales(),
        loadInvoices(),
        loadPayments(),
      ]);
    } catch (e) {
      console.warn('Global refresh error:', e);
    }
  };

  // ==========================================
  // DASHBOARD
  // ==========================================
  const loadDashboardStats = async () => {
    try {
      const res = await API.get('/reports/stats');
      const stats = extractData(res);
      state.stats = stats;

      const totalSales = stats.lifetimeSales || 0;
      const collected = stats.lifetimeCollected || 0;
      const pendingAmt = stats.pendingInvoices ? stats.pendingInvoices.amount : 0;
      const overdueAmt = stats.overdueInvoices ? stats.overdueInvoices.amount : 0;
      const pendingCount = (stats.pendingInvoices ? stats.pendingInvoices.count : 0) + (stats.overdueInvoices ? stats.overdueInvoices.count : 0);

      document.getElementById('kpiTotalSales').textContent = formatCurrency(totalSales);
      document.getElementById('kpiSalesCount').textContent = `${stats.lifetimeSalesCount || 0} Transactions`;

      document.getElementById('kpiOutstanding').textContent = formatCurrency(pendingAmt + overdueAmt);
      document.getElementById('kpiPendingCount').textContent = `${pendingCount} Invoices Due`;

      document.getElementById('kpiCollected').textContent = formatCurrency(collected);
      document.getElementById('kpiMonthCollected').textContent = `${formatCurrency(stats.monthCollected || 0)} This Month`;

      document.getElementById('kpiOverdueAmount').textContent = formatCurrency(overdueAmt);
      document.getElementById('kpiOverdueCount').textContent = `${stats.overdueInvoices ? stats.overdueInvoices.count : 0} Overdue`;

      // Render Recent Sales in Dashboard
      const dashSalesBody = document.getElementById('dashSalesBody');
      if (stats.recentSales && stats.recentSales.length > 0) {
        dashSalesBody.innerHTML = stats.recentSales.map((s) => `
          <tr>
            <td>${formatDate(s.sale_date)}</td>
            <td><strong>${escapeHtml(s.customer_name)}</strong></td>
            <td>${escapeHtml(s.item_name)}</td>
            <td>${s.units_sold}</td>
            <td><strong>${formatCurrency(s.total)}</strong></td>
          </tr>
        `).join('');
      } else {
        dashSalesBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No sales recorded yet.</td></tr>`;
      }

      // Render Low Stock in Dashboard
      const dashStockBody = document.getElementById('dashStockBody');
      if (stats.lowStockItems && stats.lowStockItems.length > 0) {
        dashStockBody.innerHTML = stats.lowStockItems.map((item) => `
          <tr>
            <td><strong>${escapeHtml(item.name)}</strong></td>
            <td>${item.quantity_available} units</td>
            <td>
              <span class="${item.quantity_available <= 5 ? 'stock-critical' : 'stock-warning'}">
                ${item.quantity_available <= 0 ? 'Out of Stock' : 'Low Stock'}
              </span>
            </td>
          </tr>
        `).join('');
      } else {
        dashStockBody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-muted);">All inventory healthy.</td></tr>`;
      }
    } catch (err) {
      console.error('Failed to load dashboard stats:', err);
    }
  };

  // ==========================================
  // CUSTOMERS MANAGEMENT
  // ==========================================
  const loadCustomers = async () => {
    try {
      const res = await API.get('/customers');
      state.customers = extractData(res) || [];
      renderCustomersTable(state.customers);
      populateCustomerDropdowns(state.customers);
    } catch (err) {
      Toast.error('Failed to load customers: ' + err.message);
    }
  };

  const renderCustomersTable = (customers) => {
    const tbody = document.getElementById('customerTableBody');
    if (!customers || customers.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No customers found. Click "+ Add Customer" to create one.</td></tr>`;
      return;
    }

    tbody.innerHTML = customers.map((c) => {
      const invoiced = parseFloat(c.total_invoiced_amount) || 0;
      const paid = parseFloat(c.total_paid_amount) || 0;
      const outstanding = Math.max(0, invoiced - paid);

      return `
        <tr>
          <td><strong>${escapeHtml(c.name)}</strong></td>
          <td>${escapeHtml(c.contact_info || '—')}</td>
          <td><span class="badge" style="background: var(--bg-surface-elevated);">${c.billing_terms} Days</span></td>
          <td>${c.total_sales_count || 0}</td>
          <td>${formatCurrency(invoiced)}</td>
          <td style="color: var(--success); font-weight: 600;">${formatCurrency(paid)}</td>
          <td style="color: ${outstanding > 0 ? 'var(--danger)' : 'var(--text-muted)'}; font-weight: 700;">${formatCurrency(outstanding)}</td>
          <td>
            <div class="table-actions">
              <button class="btn btn--secondary btn--sm" onclick="App.openCustomerModal(${c.id});" title="Edit Customer">Edit</button>
              <button class="btn btn--danger btn--sm" onclick="App.deleteCustomer(${c.id}, '${escapeHtml(c.name)}');" title="Delete Everywhere">Delete</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  };

  const populateCustomerDropdowns = (customers) => {
    const saleSelect = document.getElementById('saleCustomerSelect');
    if (saleSelect) {
      const currentVal = saleSelect.value;
      saleSelect.innerHTML = '<option value="">-- Choose Customer --</option>' +
        customers.map((c) => `<option value="${c.id}">${escapeHtml(c.name)} (${c.billing_terms}d terms)</option>`).join('');
      if (currentVal) saleSelect.value = currentVal;
    }
  };

  const openCustomerModal = (customerId = null) => {
    const form = document.getElementById('customerForm');
    form.reset();
    document.getElementById('customerIdInput').value = '';
    const title = document.getElementById('modalCustomerTitle');

    if (customerId) {
      title.textContent = 'Edit Customer';
      const c = state.customers.find((cust) => cust.id === customerId);
      if (c) {
        document.getElementById('customerIdInput').value = c.id;
        document.getElementById('customerNameInput').value = c.name;
        document.getElementById('customerContactInput').value = c.contact_info || '';
        document.getElementById('customerTermsInput').value = c.billing_terms || 30;
      }
    } else {
      title.textContent = 'Add New Customer';
      document.getElementById('customerTermsInput').value = 30;
    }

    Modal.open('modalCustomer');
  };

  const deleteCustomer = async (id, name) => {
    if (!confirm(`⚠️ Are you sure you want to delete customer "${name}"?\n\nThis will permanently delete this customer AND all their associated sales, invoices, and payments from EVERYWHERE (database and live Excel reports).`)) {
      return;
    }

    try {
      const res = await API.delete(`/customers/${id}`);
      Toast.success(res.message || 'Customer and all associated records deleted everywhere.');
      await refreshAllData();
    } catch (err) {
      Toast.error('Delete failed: ' + err.message);
    }
  };

  // ==========================================
  // STOCK INVENTORY
  // ==========================================
  const loadStock = async () => {
    try {
      const res = await API.get('/stock');
      state.stock = extractData(res) || [];
      renderStockTable(state.stock);
      populateStockDropdowns(state.stock);
    } catch (err) {
      Toast.error('Failed to load stock: ' + err.message);
    }
  };

  const renderStockTable = (stock) => {
    const tbody = document.getElementById('stockTableBody');
    if (!stock || stock.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No stock items found. Click "+ Add Stock Item" to add products.</td></tr>`;
      return;
    }

    tbody.innerHTML = stock.map((s) => {
      let statusBadge = `<span class="badge badge--paid">In Stock</span>`;
      if (s.quantity_available <= 0) {
        statusBadge = `<span class="badge badge--overdue">Out of Stock</span>`;
      } else if (s.quantity_available <= 10) {
        statusBadge = `<span class="badge badge--pending">Low (${s.quantity_available})</span>`;
      }

      return `
        <tr>
          <td><strong>${escapeHtml(s.name)}</strong></td>
          <td>${formatCurrency(s.unit_price)}</td>
          <td><strong>${s.quantity_available}</strong></td>
          <td>${s.total_units_sold || 0}</td>
          <td>${statusBadge}</td>
          <td>
            <div class="table-actions">
              <button class="btn btn--secondary btn--sm" onclick="App.openStockModal(${s.id});">Edit</button>
              <button class="btn btn--danger btn--sm" onclick="App.deleteStock(${s.id}, '${escapeHtml(s.name)}');">Delete</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  };

  const populateStockDropdowns = (stock) => {
    const saleItemSelect = document.getElementById('saleItemSelect');
    if (saleItemSelect) {
      const currentVal = saleItemSelect.value;
      saleItemSelect.innerHTML = '<option value="">-- Choose Item --</option>' +
        stock.map((s) => `<option value="${s.id}" data-price="${s.unit_price}" data-qty="${s.quantity_available}">${escapeHtml(s.name)} (₹${s.unit_price}, ${s.quantity_available} avail)</option>`).join('');
      if (currentVal) saleItemSelect.value = currentVal;
    }
  };

  const openStockModal = (stockId = null) => {
    const form = document.getElementById('stockForm');
    form.reset();
    document.getElementById('stockIdInput').value = '';
    const title = document.getElementById('modalStockTitle');

    if (stockId) {
      title.textContent = 'Edit Stock Item';
      const s = state.stock.find((item) => item.id === stockId);
      if (s) {
        document.getElementById('stockIdInput').value = s.id;
        document.getElementById('stockNameInput').value = s.name;
        document.getElementById('stockQtyInput').value = s.quantity_available;
        document.getElementById('stockPriceInput').value = s.unit_price;
      }
    } else {
      title.textContent = 'Add Stock Item';
      document.getElementById('stockQtyInput').value = 100;
      document.getElementById('stockPriceInput').value = '0.00';
    }

    Modal.open('modalStock');
  };

  const deleteStock = async (id, name) => {
    if (!confirm(`⚠️ Are you sure you want to delete stock item "${name}"?\n\nThis will remove the item AND any associated sales, invoices, and payments from EVERYWHERE (database and live Excel reports).`)) {
      return;
    }

    try {
      const res = await API.delete(`/stock/${id}`);
      Toast.success(res.message || 'Stock item and linked sales deleted everywhere.');
      await refreshAllData();
    } catch (err) {
      Toast.error('Delete failed: ' + err.message);
    }
  };

  // ==========================================
  // SALES ENTRY & LEDGER
  // ==========================================
  const loadSales = async () => {
    try {
      const res = await API.get('/sales');
      state.sales = extractData(res) || [];
      renderSalesTable(state.sales);
    } catch (err) {
      Toast.error('Failed to load sales: ' + err.message);
    }
  };

  const renderSalesTable = (sales) => {
    const tbody = document.getElementById('salesTableBody');
    if (!sales || sales.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; color: var(--text-muted);">No sales recorded yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = sales.map((s) => {
      const total = parseFloat(s.total_amount) || (s.units_sold * s.rate);
      let statusBadge = `<span class="badge badge--pending">Pending</span>`;
      if (s.invoice_status === 'paid') statusBadge = `<span class="badge badge--paid">Paid</span>`;
      else if (s.invoice_status === 'overdue') statusBadge = `<span class="badge badge--overdue">Overdue</span>`;

      return `
        <tr>
          <td>#${s.id}</td>
          <td>${formatDate(s.sale_date)}</td>
          <td><strong>${escapeHtml(s.customer_name)}</strong></td>
          <td>${escapeHtml(s.item_name)}</td>
          <td>${s.units_sold}</td>
          <td>${formatCurrency(s.rate)}</td>
          <td><strong>${formatCurrency(total)}</strong></td>
          <td>${s.invoice_id ? `<button class="btn btn--secondary btn--sm" onclick="App.viewInvoice(${s.invoice_id});">INV-${s.invoice_id}</button>` : 'N/A'}</td>
          <td>${statusBadge}</td>
          <td>
            <div class="table-actions">
              <button class="btn btn--danger btn--sm" onclick="App.deleteSale(${s.id});" title="Delete Sale everywhere">Delete</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  };

  const deleteSale = async (id) => {
    if (!confirm(`⚠️ Are you sure you want to delete Sale #${id}?\n\nThis will restore stock inventory, delete its linked invoice & payments, and update Excel sheets everywhere.`)) {
      return;
    }

    try {
      const res = await API.delete(`/sales/${id}`);
      Toast.success(res.message || 'Sale deleted, stock restored, and invoice removed everywhere.');
      await refreshAllData();
    } catch (err) {
      Toast.error('Delete sale failed: ' + err.message);
    }
  };

  // ==========================================
  // INVOICES & REMINDERS
  // ==========================================
  const loadInvoices = async () => {
    try {
      const res = await API.get('/invoices');
      state.invoices = extractData(res) || [];
      renderInvoicesTable();
      populatePaymentInvoiceDropdown(state.invoices);
    } catch (err) {
      Toast.error('Failed to load invoices: ' + err.message);
    }
  };

  const renderInvoicesTable = () => {
    const tbody = document.getElementById('invoiceTableBody');
    let list = state.invoices;

    if (state.invoiceFilter !== 'all') {
      list = list.filter((inv) => inv.status === state.invoiceFilter);
    }

    if (!list || list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No ${state.invoiceFilter !== 'all' ? state.invoiceFilter : ''} invoices found.</td></tr>`;
      return;
    }

    tbody.innerHTML = list.map((inv) => {
      const amount = parseFloat(inv.amount) || 0;
      const paid = parseFloat(inv.amount_paid || inv.total_paid) || 0;
      const balance = Math.max(0, amount - paid);

      let statusBadge = `<span class="badge badge--pending">Pending</span>`;
      if (inv.status === 'paid') statusBadge = `<span class="badge badge--paid">Paid</span>`;
      else if (inv.status === 'overdue') statusBadge = `<span class="badge badge--overdue">Overdue</span>`;

      return `
        <tr>
          <td><strong>INV-${inv.id}</strong></td>
          <td>${escapeHtml(inv.customer_name)}</td>
          <td>${formatCurrency(amount)}</td>
          <td style="color: var(--success);">${formatCurrency(paid)}</td>
          <td style="color: ${balance > 0 ? 'var(--danger)' : 'var(--text-muted)'}; font-weight: 700;">${formatCurrency(balance)}</td>
          <td>${formatDate(inv.due_date)}</td>
          <td>${statusBadge}</td>
          <td>
            <div class="table-actions">
              <button class="btn btn--secondary btn--sm" onclick="App.viewInvoice(${inv.id});">View / Print</button>
              ${balance > 0 ? `<button class="btn btn--success btn--sm" onclick="App.openPaymentForInvoice(${inv.id}, ${balance});">Pay</button>` : ''}
              <button class="btn btn--danger btn--sm" onclick="App.deleteInvoice(${inv.id});" title="Delete everywhere">Delete</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  };

  const populatePaymentInvoiceDropdown = (invoices) => {
    const select = document.getElementById('paymentInvoiceSelect');
    if (select) {
      const currentVal = select.value;
      const pendingInvoices = invoices.filter((i) => i.status !== 'paid');
      select.innerHTML = '<option value="">-- Choose Pending / Overdue Invoice --</option>' +
        pendingInvoices.map((i) => {
          const bal = Math.max(0, parseFloat(i.amount) - parseFloat(i.amount_paid || 0));
          return `<option value="${i.id}" data-amount="${bal}" data-customer="${escapeHtml(i.customer_name)}">INV-${i.id} - ${escapeHtml(i.customer_name)} (Bal: ₹${bal.toFixed(2)}, Due: ${formatDate(i.due_date)})</option>`;
        }).join('');
      if (currentVal) select.value = currentVal;
    }
  };

  const loadReminders = async () => {
    try {
      const res = await API.get('/invoices/reminders');
      state.reminders = extractData(res) || [];
      const tbody = document.getElementById('remindersTableBody');
      if (!state.reminders || state.reminders.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No 3-day notice reminders sent yet.</td></tr>`;
        return;
      }

      tbody.innerHTML = state.reminders.map((r) => `
        <tr>
          <td>${formatDate(r.reminder_date || r.created_at)}</td>
          <td><strong>${escapeHtml(r.customer_name)}</strong></td>
          <td>INV-${r.invoice_id}</td>
          <td>${formatDate(r.due_date)}</td>
          <td>${formatCurrency(r.amount)}</td>
          <td><span style="font-size: 0.8rem; color: var(--text-secondary);">${escapeHtml(r.message)}</span></td>
        </tr>
      `).join('');
    } catch (e) {
      console.warn('Failed to load reminders:', e);
    }
  };

  const deleteInvoice = async (id) => {
    if (!confirm(`⚠️ Are you sure you want to delete Invoice INV-${id}?\n\nThis will restore stock for any linked sale, delete its payment records, and update Excel sheets everywhere.`)) {
      return;
    }

    try {
      const res = await API.delete(`/invoices/${id}`);
      Toast.success(res.message || 'Invoice and linked records deleted everywhere.');
      await refreshAllData();
    } catch (err) {
      Toast.error('Delete invoice failed: ' + err.message);
    }
  };

  const viewInvoice = (id) => {
    const inv = state.invoices.find((i) => i.id === id);
    if (!inv) return;

    const modalBody = document.getElementById('modalInvoiceDetailBody');
    const amount = parseFloat(inv.amount) || 0;
    const paid = parseFloat(inv.amount_paid || inv.total_paid) || 0;
    const balance = Math.max(0, amount - paid);

    modalBody.innerHTML = `
      <div class="invoice-print-view" id="printableInvoiceView">
        <div class="invoice-print-header">
          <div>
            <h2 style="font-size: 1.5rem; font-weight: 800; color: #1e3a8a; margin: 0;">ACCOUNTING INVOICE</h2>
            <p style="margin: 0.25rem 0 0; font-size: 0.85rem; color: #4b5563;">Official Billing Statement & Receipt</p>
          </div>
          <div style="text-align: right;">
            <h3 style="margin: 0; font-size: 1.25rem; font-weight: 700;">INV-${inv.id}</h3>
            <p style="margin: 0.25rem 0 0; font-size: 0.85rem; color: #4b5563;">Issue Date: ${formatDate(inv.created_at || inv.sale_date)}</p>
            <p style="margin: 0; font-size: 0.85rem; color: #4b5563;">Due Date: <strong>${formatDate(inv.due_date)}</strong></p>
          </div>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin-bottom: 1.5rem;">
          <div>
            <h4 style="font-size: 0.8rem; text-transform: uppercase; color: #6b7280; margin-bottom: 0.25rem;">Billed To:</h4>
            <div style="font-weight: 700; font-size: 1.05rem; color: #111827;">${escapeHtml(inv.customer_name)}</div>
            <div style="font-size: 0.85rem; color: #4b5563;">${escapeHtml(inv.contact_info || '')}</div>
          </div>
          <div style="text-align: right;">
            <h4 style="font-size: 0.8rem; text-transform: uppercase; color: #6b7280; margin-bottom: 0.25rem;">Invoice Status:</h4>
            <span style="display: inline-block; padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.8rem; font-weight: 700; text-transform: uppercase; background: ${inv.status === 'paid' ? '#dcfce7; color: #166534;' : (inv.status === 'overdue' ? '#fee2e2; color: #991b1b;' : '#fef3c7; color: #92400e;')}">
              ${inv.status}
            </span>
          </div>
        </div>

        <table style="width: 100%; border-collapse: collapse; margin-bottom: 1.5rem;">
          <thead>
            <tr style="background: #f3f4f6; text-align: left; font-size: 0.8rem; color: #374151;">
              <th style="padding: 0.6rem 0.75rem;">Description</th>
              <th style="padding: 0.6rem 0.75rem; text-align: right;">Total Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr style="border-bottom: 1px solid #e5e7eb;">
              <td style="padding: 0.75rem;">Sale #${inv.sale_id || inv.id} - ${escapeHtml(inv.item_name || 'Standard Accounting Service')}</td>
              <td style="padding: 0.75rem; text-align: right; font-weight: 600;">${formatCurrency(amount)}</td>
            </tr>
          </tbody>
        </table>

        <div style="display: flex; justify-content: flex-end; margin-bottom: 1.5rem;">
          <div style="width: 250px; display: flex; flex-direction: column; gap: 0.4rem; font-size: 0.9rem;">
            <div style="display: flex; justify-content: space-between;">
              <span>Total Amount:</span>
              <span>${formatCurrency(amount)}</span>
            </div>
            <div style="display: flex; justify-content: space-between; color: #16a34a;">
              <span>Total Paid:</span>
              <span>${formatCurrency(paid)}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-weight: 800; font-size: 1.1rem; border-top: 2px solid #e5e7eb; padding-top: 0.4rem; color: #111827;">
              <span>Balance Due:</span>
              <span>${formatCurrency(balance)}</span>
            </div>
          </div>
        </div>

        <div style="border-top: 1px dashed #d1d5db; padding-top: 1rem; text-align: center; font-size: 0.75rem; color: #9ca3af;">
          Generated automatically by Accounting Portal • System Synchronized
        </div>
      </div>
    `;

    Modal.open('modalInvoiceDetail');
  };

  const printCurrentModal = () => {
    const printContent = document.getElementById('printableInvoiceView');
    if (!printContent) return;

    const printWin = window.open('', '_blank');
    printWin.document.write(`
      <html>
        <head>
          <title>Invoice Print</title>
          <style>
            body { font-family: Inter, system-ui, sans-serif; padding: 20px; color: #111; }
            table { width: 100%; border-collapse: collapse; }
            th, td { padding: 8px 12px; border-bottom: 1px solid #ddd; }
          </style>
        </head>
        <body onload="window.print();window.close();">
          ${printContent.innerHTML}
        </body>
      </html>
    `);
    printWin.document.close();
  };

  // ==========================================
  // PAYMENTS LEDGER
  // ==========================================
  const loadPayments = async () => {
    try {
      const res = await API.get('/payments');
      state.payments = extractData(res) || [];
      renderPaymentsTable(state.payments);
    } catch (err) {
      Toast.error('Failed to load payments: ' + err.message);
    }
  };

  const renderPaymentsTable = (payments) => {
    const tbody = document.getElementById('paymentTableBody');
    if (!payments || payments.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No payment receipts recorded yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = payments.map((p) => `
      <tr>
        <td>#PAY-${p.id}</td>
        <td>${formatDate(p.payment_date)}</td>
        <td><strong>${escapeHtml(p.customer_name)}</strong></td>
        <td>INV-${p.invoice_id}</td>
        <td style="color: var(--success); font-weight: 700;">${formatCurrency(p.amount_paid)}</td>
        <td><span class="badge" style="background: var(--bg-surface-elevated);">${escapeHtml(p.mode)}</span></td>
        <td>${escapeHtml(p.notes || '—')}</td>
        <td>
          <div class="table-actions">
            <button class="btn btn--danger btn--sm" onclick="App.deletePayment(${p.id});" title="Delete everywhere">Delete</button>
          </div>
        </td>
      </tr>
    `).join('');
  };

  const openPaymentModal = () => {
    const form = document.getElementById('paymentForm');
    form.reset();
    document.getElementById('paymentDateInput').value = getTodayDateStr();
    document.getElementById('paymentInvoiceDetailsPreview').textContent = '';
    Modal.open('modalPayment');
  };

  const openPaymentForInvoice = (invoiceId, balance) => {
    openPaymentModal();
    const select = document.getElementById('paymentInvoiceSelect');
    if (select) {
      select.value = invoiceId;
      document.getElementById('paymentAmountInput').value = balance.toFixed(2);
      document.getElementById('paymentInvoiceDetailsPreview').textContent = `Target Invoice: INV-${invoiceId} | Balance: ₹${balance.toFixed(2)}`;
    }
  };

  const deletePayment = async (id) => {
    if (!confirm(`⚠️ Are you sure you want to delete Payment receipt #PAY-${id}?\n\nThis will remove the payment, re-evaluate the invoice balance and status, and update Excel sheets everywhere.`)) {
      return;
    }

    try {
      const res = await API.delete(`/payments/${id}`);
      Toast.success(res.message || 'Payment deleted and invoice status re-evaluated everywhere.');
      await refreshAllData();
    } catch (err) {
      Toast.error('Delete payment failed: ' + err.message);
    }
  };

  // ==========================================
  // UNIVERSAL DOCUMENT & FILE AUTO-IMPORTER
  // ==========================================
  const initOCR = () => {
    const dropzone = document.getElementById('ocrDropzone');
    const fileInput = document.getElementById('ocrFileInput');

    // Input Mode Tabs
    document.getElementById('btnModeUpload').addEventListener('click', () => {
      fileInput.click();
    });

    document.getElementById('btnModeCamera').addEventListener('click', () => {
      openCameraModal();
    });

    document.getElementById('btnModePaste').addEventListener('click', () => {
      Toast.info('Press Ctrl+V (or Cmd+V on Mac) anywhere to paste your copied invoice screenshot or text.');
    });

    // Dropzone Events
    dropzone.addEventListener('click', () => fileInput.click());
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        processUniversalFile(e.dataTransfer.files[0]);
      }
    });

    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) {
        processUniversalFile(fileInput.files[0]);
      }
    });

    // Global Paste Listener for Screenshots or Text
    window.addEventListener('paste', (e) => {
      const items = (e.clipboardData || e.originalEvent.clipboardData).items;
      for (const item of items) {
        if (item.type.indexOf('image') !== -1) {
          const blob = item.getAsFile();
          Toast.info('Image detected from clipboard! Processing...');
          navigateTo('ocr');
          processUniversalFile(blob);
          break;
        }
      }
    });

    // Zoom Controls
    document.getElementById('btnZoomIn').addEventListener('click', () => {
      state.ocrZoomLevel = Math.min(state.ocrZoomLevel + 0.25, 3);
      document.getElementById('ocrImagePreview').style.transform = `scale(${state.ocrZoomLevel})`;
    });

    document.getElementById('btnZoomOut').addEventListener('click', () => {
      state.ocrZoomLevel = Math.max(state.ocrZoomLevel - 0.25, 0.5);
      document.getElementById('ocrImagePreview').style.transform = `scale(${state.ocrZoomLevel})`;
    });

    document.getElementById('btnZoomReset').addEventListener('click', () => {
      state.ocrZoomLevel = 1;
      document.getElementById('ocrImagePreview').style.transform = 'scale(1)';
    });

    // Raw text toggle
    document.getElementById('btnToggleRawText').addEventListener('click', () => {
      const wrapper = document.getElementById('rawTextWrapper');
      wrapper.style.display = wrapper.style.display === 'none' ? 'block' : 'none';
    });

    // Payment status change toggle
    document.getElementById('ocrPaymentStatusSelect').addEventListener('change', (e) => {
      const modeGroup = document.getElementById('ocrPaymentModeGroup');
      modeGroup.style.display = e.target.value === 'paid' ? 'block' : 'none';
    });

    // Real-time tax & discount input listeners
    document.getElementById('ocrTaxRateInput').addEventListener('input', recalculateTotals);
    document.getElementById('ocrDiscountInput').addEventListener('input', recalculateTotals);

    // Confirmation form submission
    document.getElementById('ocrConfirmationForm').addEventListener('submit', handleOCRConfirmationSubmit);
  };

  /**
   * Process any uploaded file (PDF, Excel, CSV, Image, Text/JSON)
   */
  const processUniversalFile = async (file) => {
    if (!file) return;

    const imgPreview = document.getElementById('ocrImagePreview');
    const textPreview = document.getElementById('ocrTextFallbackPreview');
    const isImage = file.type && file.type.startsWith('image/');
    const isPDF = file.type === 'application/pdf' || file.name.endsWith('.pdf');
    const isExcel = file.name.endsWith('.xlsx') || file.name.endsWith('.xls');
    const isCSV = file.name.endsWith('.csv');

    if (isImage) {
      imgPreview.style.display = 'block';
      textPreview.style.display = 'none';
      const reader = new FileReader();
      reader.onload = (e) => {
        imgPreview.src = e.target.result;
      };
      reader.readAsDataURL(file);
    } else {
      imgPreview.style.display = 'none';
      textPreview.style.display = 'block';
      let typeLabel = isPDF ? '📄 PDF Document' : (isExcel ? '📊 Excel Spreadsheet' : (isCSV ? '📋 CSV Table' : '📝 Text Document'));
      textPreview.textContent = `${typeLabel}\n\nFile Name: ${file.name}\nFile Size: ${(file.size / 1024).toFixed(1)} KB\n\nReading and parsing structured records automatically...`;
    }

    const formData = new FormData();
    formData.append('bill_image', file);

    await executeUniversalUpload(formData, file.name);
  };

  /**
   * Execute upload and parsing on the backend
   */
  const executeUniversalUpload = async (body, fileName = 'Uploaded Document') => {
    const progressWrapper = document.getElementById('ocrProgressWrapper');
    const reviewGrid = document.getElementById('ocrReviewGrid');
    const batchGrid = document.getElementById('ocrBatchGrid');
    const statusText = document.getElementById('ocrProgressStatus');

    progressWrapper.style.display = 'block';
    reviewGrid.style.display = 'none';
    batchGrid.style.display = 'none';

    setScanStep(1);
    statusText.textContent = `Analyzing ${fileName}...`;

    const t1 = setTimeout(() => {
      setScanStep(2);
      statusText.textContent = 'Parsing document contents and extracting fields...';
    }, 600);

    const t2 = setTimeout(() => {
      setScanStep(3);
      statusText.textContent = 'Structuring accounting items and financial ledger entries...';
    }, 1200);

    try {
      const res = await API.post('/ocr/scan', body);
      clearTimeout(t1);
      clearTimeout(t2);

      progressWrapper.style.display = 'none';

      // Check if Multi-Row Batch spreadsheet (Stock / Customers / Sales Sheet)
      if (res.isMultiRow) {
        batchGrid.style.display = 'block';
        reviewGrid.style.display = 'none';

        state.currentBatchData = {
          importType: res.importType || 'stock',
          items: res.items || [],
          fileName: res.fileName || fileName,
        };

        renderBatchTable(res.items || [], res.importType || 'stock', res.fileName || fileName);
        Toast.success(res.message || 'Spreadsheet rows extracted! Review and confirm import.');
        return;
      }

      // Single Bill / Invoice Document Verification
      reviewGrid.style.display = 'grid';
      batchGrid.style.display = 'none';

      const data = res.extractedData || {};
      state.currentOCRData = data;

      // Update Header Badges
      const docNameEl = document.getElementById('ocrDocumentName');
      const badgeEl = document.getElementById('ocrFileTypeBadge');
      if (docNameEl) docNameEl.textContent = res.fileName || fileName || 'Document Preview';
      if (badgeEl) {
        badgeEl.textContent = (res.fileType || 'Doc').toUpperCase();
      }

      // Populate Form Fields
      populateOCREditForm(data);

      // Add to Session Scan History
      addScanToHistory(data);

      Toast.success('Document parsed successfully! Please review and confirm the extracted details.');
    } catch (err) {
      clearTimeout(t1);
      clearTimeout(t2);
      progressWrapper.style.display = 'none';
      Toast.error('File reading failed: ' + err.message);
    }
  };

  const setScanStep = (stepNum) => {
    for (let i = 1; i <= 3; i++) {
      const el = document.getElementById(`scanStep${i}`);
      if (el) {
        if (i < stepNum) {
          el.className = 'scan-step done';
        } else if (i === stepNum) {
          el.className = 'scan-step active';
        } else {
          el.className = 'scan-step';
        }
      }
    }
  };

  /**
   * Populate single bill verification form
   */
  const populateOCREditForm = (data) => {
    // Use server-extracted invoice number first, then doc's own invoiceNumber — never random
    const displayInvNo = data.invoiceNumber || '';
    document.getElementById('ocrCustomerInput').value = data.customerName || data.vendorName || data.vendor || data.customer || 'Unknown Vendor';
    document.getElementById('ocrContactInput').value = data.contactInfo || (data.taxId ? `GSTIN: ${data.taxId}` : '');
    document.getElementById('ocrBillNumberInput').value = displayInvNo;
    document.getElementById('ocrCategorySelect').value = data.category || 'General Supplies';
    document.getElementById('ocrDateInput').value = data.invoiceDate || data.billDate || getTodayDateStr();
    document.getElementById('ocrDueDateInput').value = data.dueDate || getTodayDateStr();
    document.getElementById('ocrRawText').value = data.rawText || '';

    // If text fallback preview is active, show raw text
    const textPreview = document.getElementById('ocrTextFallbackPreview');
    if (textPreview && textPreview.style.display !== 'none' && data.rawText) {
      textPreview.textContent = `=== EXTRACTED TEXT FROM DOCUMENT ===\n\n${data.rawText}`;
    }

    // Confidence badge
    const badge = document.getElementById('ocrConfidenceBadge');
    if (data.confidence && data.confidence.overall === 'high') {
      badge.textContent = '✓ 98% High Accuracy';
      badge.style.color = '#10b981';
      badge.style.background = 'rgba(16, 185, 129, 0.15)';
    } else {
      badge.textContent = '⚠️ Review Recommended';
      badge.style.color = '#f59e0b';
      badge.style.background = 'rgba(245, 158, 11, 0.15)';
    }

    // Line items
    const lineItems = data.items && data.items.length > 0 ? data.items : [
      { description: 'Scanned Invoice Item', quantity: 1, unit_price: data.totalAmount || 0, total: data.totalAmount || 0 },
    ];
    renderOCRLineItems(lineItems);

    document.getElementById('ocrTaxRateInput').value = data.taxRate || 0;
    document.getElementById('ocrDiscountInput').value = data.discount || 0;

    recalculateTotals();

    // Payment Status & Mode
    document.getElementById('ocrPaymentStatusSelect').value = data.paymentStatus || 'pending';
    document.getElementById('ocrPaymentModeSelect').value = data.paymentMode || 'Bank Transfer';
    document.getElementById('ocrPaymentModeGroup').style.display = data.paymentStatus === 'paid' ? 'block' : 'none';
  };

  /**
   * Render dynamic line items table
   */
  const renderOCRLineItems = (items) => {
    const tbody = document.getElementById('ocrLineItemsBody');
    tbody.innerHTML = items.map((item, index) => `
      <tr data-item-index="${index}">
        <td>
          <input type="text" class="line-desc" value="${escapeHtml(item.description || item.name || '')}" placeholder="Item description" required>
        </td>
        <td>
          <input type="number" class="line-qty" value="${item.quantity || item.qty || 1}" min="1" required oninput="App.recalculateTotals();">
        </td>
        <td>
          <input type="number" class="line-rate" value="${(item.unit_price || item.rate || 0).toFixed(2)}" step="0.01" min="0" required oninput="App.recalculateTotals();">
        </td>
        <td style="font-weight: 700;" class="line-total-cell">
          ₹${(((item.quantity || item.qty || 1)) * (item.unit_price || item.rate || 0)).toFixed(2)}
        </td>
        <td style="text-align: center;">
          <button type="button" class="btn btn--icon btn--sm" style="color: var(--danger); border: none;" onclick="App.removeOCRLineItem(this);" title="Delete row">✕</button>
        </td>
      </tr>
    `).join('');
  };

  const addOCRLineItem = () => {
    const tbody = document.getElementById('ocrLineItemsBody');
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" class="line-desc" value="New Item" placeholder="Item description" required></td>
      <td><input type="number" class="line-qty" value="1" min="1" required oninput="App.recalculateTotals();"></td>
      <td><input type="number" class="line-rate" value="0.00" step="0.01" min="0" required oninput="App.recalculateTotals();"></td>
      <td style="font-weight: 700;" class="line-total-cell">₹0.00</td>
      <td style="text-align: center;">
        <button type="button" class="btn btn--icon btn--sm" style="color: var(--danger); border: none;" onclick="App.removeOCRLineItem(this);">✕</button>
      </td>
    `;
    tbody.appendChild(tr);
    recalculateTotals();
  };

  const removeOCRLineItem = (btn) => {
    const tbody = document.getElementById('ocrLineItemsBody');
    if (tbody.children.length > 1) {
      btn.closest('tr').remove();
      recalculateTotals();
    } else {
      Toast.warning('At least one line item is required.');
    }
  };

  const recalculateTotals = () => {
    let subtotal = 0;
    const rows = document.querySelectorAll('#ocrLineItemsBody tr');

    rows.forEach((row) => {
      const qtyInput = row.querySelector('.line-qty');
      const rateInput = row.querySelector('.line-rate');
      if (qtyInput && rateInput) {
        const qty = parseFloat(qtyInput.value) || 0;
        const rate = parseFloat(rateInput.value) || 0;
        const total = qty * rate;
        subtotal += total;
        const totalCell = row.querySelector('.line-total-cell');
        if (totalCell) totalCell.textContent = '₹' + total.toFixed(2);
      }
    });

    const taxRate = parseFloat(document.getElementById('ocrTaxRateInput').value) || 0;
    const discount = parseFloat(document.getElementById('ocrDiscountInput').value) || 0;

    const taxAmount = (subtotal * taxRate) / 100;
    const grandTotal = Math.max(0, subtotal + taxAmount - discount);

    document.getElementById('ocrSubtotalDisplay').textContent = '₹' + subtotal.toFixed(2);
    document.getElementById('ocrTaxAmountDisplay').textContent = '₹' + taxAmount.toFixed(2);
    document.getElementById('ocrDiscountDisplay').textContent = '-₹' + discount.toFixed(2);
    document.getElementById('ocrGrandTotalDisplay').textContent = '₹' + grandTotal.toFixed(2);

    return { subtotal, taxRate, taxAmount, discount, grandTotal };
  };

  const setQuickDueDate = (days) => {
    const issueDateStr = document.getElementById('ocrDateInput').value || getTodayDateStr();
    const d = new Date(issueDateStr);
    d.setDate(d.getDate() + days);
    document.getElementById('ocrDueDateInput').value = d.toISOString().split('T')[0];
  };

  const setScanDocType = (type) => {
    const saleBtn = document.getElementById('docTypeSaleBtn');
    const expBtn = document.getElementById('docTypeExpenseBtn');

    if (type === 'sale') {
      saleBtn.classList.add('active');
      expBtn.classList.remove('active');
    } else {
      expBtn.classList.add('active');
      saleBtn.classList.remove('active');
    }
  };

  /**
   * Handle Single Bill Confirmation Submit
   */
  const handleOCRConfirmationSubmit = async (e) => {
    e.preventDefault();
    const customerName = document.getElementById('ocrCustomerInput').value.trim();
    const contactInfo = document.getElementById('ocrContactInput').value.trim();
    const billDate = document.getElementById('ocrDateInput').value;
    const dueDate = document.getElementById('ocrDueDateInput').value;
    const category = document.getElementById('ocrCategorySelect').value;
    const paymentStatus = document.getElementById('ocrPaymentStatusSelect').value;
    const paymentMode = document.getElementById('ocrPaymentModeSelect').value;

    const { grandTotal } = recalculateTotals();

    if (!customerName || grandTotal <= 0) {
      Toast.error('Customer name and valid amount (> ₹0) are required.');
      return;
    }

    // Collect all line items
    const lineItemRows = document.querySelectorAll('#ocrLineItemsBody tr');
    const items = [];
    lineItemRows.forEach((row) => {
      const desc = row.querySelector('.line-desc').value.trim();
      const qty = parseInt(row.querySelector('.line-qty').value, 10) || 1;
      const rate = parseFloat(row.querySelector('.line-rate').value) || 0;
      if (desc) {
        items.push({ description: desc, quantity: qty, unit_price: rate });
      }
    });

    const confirmBtn = document.getElementById('ocrConfirmSaveBtn');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Saving to Accounting Ledger...';

    try {
      const res = await API.post('/ocr/confirm', {
        customer_name: customerName,
        contact_info: contactInfo,
        billing_terms: 30,
        items,
        total_amount: grandTotal,
        bill_date: billDate,
        due_date: dueDate,
        payment_status: paymentStatus,
        payment_mode: paymentMode,
        notes: `Universal Importer [Category: ${category}]`,
      });

      Toast.success(res.message || 'Document confirmed and recorded into database & live Excel!');
      await refreshAllData();
      navigateTo('invoices');
    } catch (err) {
      Toast.error('Confirmation failed: ' + err.message);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = `
        <svg style="width: 18px; height: 18px;" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
        <span>Confirm & Save to Accounting Ledger</span>
      `;
    }
  };

  // ==========================================
  // MULTI-ROW SPREADSHEET BATCH IMPORT METHODS
  // ==========================================
  const renderBatchTable = (items, importType, fileName) => {
    const thead = document.getElementById('batchTableHead');
    const tbody = document.getElementById('batchTableBody');
    const badge = document.getElementById('batchTypeBadge');
    const title = document.getElementById('batchTitle');
    const summary = document.getElementById('batchSummaryText');
    const countEl = document.getElementById('batchRowCount');

    badge.textContent = importType === 'stock' ? 'Stock Spreadsheet' : (importType === 'customers' ? 'Customer Directory' : 'Spreadsheet Batch');
    title.textContent = `Review & Confirm Import from "${fileName || 'Spreadsheet'}"`;
    summary.textContent = `Extracted ${items.length} records. Edit any cell before saving to accounting ledger.`;
    countEl.textContent = `${items.length} records ready to import`;

    if (importType === 'stock') {
      thead.innerHTML = `
        <tr>
          <th style="width: 45%;">Item / Product Name</th>
          <th style="width: 25%;">Available Quantity</th>
          <th style="width: 25%;">Unit Price (₹)</th>
          <th style="width: 5%;"></th>
        </tr>
      `;
      tbody.innerHTML = items.map((item, i) => `
        <tr data-batch-index="${i}">
          <td><input type="text" class="form-control batch-name" value="${escapeHtml(item.name || '')}" required></td>
          <td><input type="number" class="form-control batch-qty" value="${item.quantity_available || 100}" min="0" required></td>
          <td><input type="number" class="form-control batch-price" value="${(item.unit_price || 0).toFixed(2)}" step="0.01" min="0" required></td>
          <td style="text-align: center;"><button type="button" class="btn btn--icon btn--sm" style="color: var(--danger); border: none;" onclick="App.removeBatchRow(this);">✕</button></td>
        </tr>
      `).join('');
    } else if (importType === 'customers') {
      thead.innerHTML = `
        <tr>
          <th style="width: 40%;">Customer / Company Name</th>
          <th style="width: 35%;">Contact Info (Phone / Email)</th>
          <th style="width: 20%;">Billing Terms (Days)</th>
          <th style="width: 5%;"></th>
        </tr>
      `;
      tbody.innerHTML = items.map((cust, i) => `
        <tr data-batch-index="${i}">
          <td><input type="text" class="form-control batch-name" value="${escapeHtml(cust.name || '')}" required></td>
          <td><input type="text" class="form-control batch-contact" value="${escapeHtml(cust.contact_info || '')}" placeholder="Phone / Email"></td>
          <td><input type="number" class="form-control batch-terms" value="${cust.billing_terms || 30}" min="0" required></td>
          <td style="text-align: center;"><button type="button" class="btn btn--icon btn--sm" style="color: var(--danger); border: none;" onclick="App.removeBatchRow(this);">✕</button></td>
        </tr>
      `).join('');
    }
  };

  const addBatchRow = () => {
    const tbody = document.getElementById('batchTableBody');
    const importType = state.currentBatchData ? state.currentBatchData.importType : 'stock';
    const tr = document.createElement('tr');

    if (importType === 'stock') {
      tr.innerHTML = `
        <td><input type="text" class="form-control batch-name" value="New Stock Item" required></td>
        <td><input type="number" class="form-control batch-qty" value="100" min="0" required></td>
        <td><input type="number" class="form-control batch-price" value="0.00" step="0.01" min="0" required></td>
        <td style="text-align: center;"><button type="button" class="btn btn--icon btn--sm" style="color: var(--danger); border: none;" onclick="App.removeBatchRow(this);">✕</button></td>
      `;
    } else {
      tr.innerHTML = `
        <td><input type="text" class="form-control batch-name" value="New Customer" required></td>
        <td><input type="text" class="form-control batch-contact" value="" placeholder="Phone / Email"></td>
        <td><input type="number" class="form-control batch-terms" value="30" min="0" required></td>
        <td style="text-align: center;"><button type="button" class="btn btn--icon btn--sm" style="color: var(--danger); border: none;" onclick="App.removeBatchRow(this);">✕</button></td>
      `;
    }
    tbody.appendChild(tr);
    updateBatchCount();
  };

  const removeBatchRow = (btn) => {
    btn.closest('tr').remove();
    updateBatchCount();
  };

  const updateBatchCount = () => {
    const rows = document.querySelectorAll('#batchTableBody tr');
    const countEl = document.getElementById('batchRowCount');
    if (countEl) countEl.textContent = `${rows.length} records ready to import`;
  };

  const submitBatchImport = async () => {
    if (!state.currentBatchData) return;
    const importType = state.currentBatchData.importType || 'stock';
    const rows = document.querySelectorAll('#batchTableBody tr');
    const items = [];

    rows.forEach((row) => {
      const name = row.querySelector('.batch-name').value.trim();
      if (name) {
        if (importType === 'stock') {
          const qty = parseInt(row.querySelector('.batch-qty').value, 10) || 0;
          const price = parseFloat(row.querySelector('.batch-price').value) || 0;
          items.push({ name, quantity_available: qty, unit_price: price });
        } else {
          const contact = row.querySelector('.batch-contact').value.trim();
          const terms = parseInt(row.querySelector('.batch-terms').value, 10) || 30;
          items.push({ name, contact_info: contact, billing_terms: terms });
        }
      }
    });

    if (items.length === 0) {
      Toast.error('No valid rows found to import.');
      return;
    }

    const btn = document.getElementById('btnConfirmBatch');
    btn.disabled = true;
    btn.textContent = `Importing ${items.length} records...`;

    try {
      const res = await API.post('/ocr/confirm-batch', {
        importType,
        items,
      });

      Toast.success(res.message || `Successfully imported ${items.length} records!`);
      resetOCRView();
      await refreshAllData();
      navigateTo(importType === 'stock' ? 'stock' : 'customers');
    } catch (err) {
      Toast.error('Batch import failed: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = `
        <svg style="width: 18px; height: 18px;" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>
        <span>Confirm & Import All Rows into Accounting</span>
      `;
    }
  };

  const resetOCRView = () => {
    // Hide all review/batch panels
    document.getElementById('ocrReviewGrid').style.display = 'none';
    document.getElementById('ocrBatchGrid').style.display = 'none';
    document.getElementById('ocrProgressWrapper').style.display = 'none';

    // Reset image and text preview
    const imgPreview = document.getElementById('ocrImagePreview');
    if (imgPreview) { imgPreview.src = ''; imgPreview.style.transform = 'scale(1)'; }
    const textPreview = document.getElementById('ocrTextFallbackPreview');
    if (textPreview) { textPreview.style.display = 'none'; textPreview.textContent = ''; }

    // Reset zoom level
    state.ocrZoomLevel = 1;

    // Clear current state
    state.currentOCRData = null;
    state.currentBatchData = null;

    // Reset file input so same file can be re-uploaded
    const fileInput = document.getElementById('ocrFileInput');
    if (fileInput) fileInput.value = '';

    // Clear form fields
    const fieldsToReset = ['ocrCustomerInput', 'ocrContactInput', 'ocrBillNumberInput', 'ocrRawText'];
    fieldsToReset.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });

    // Reset totals display
    ['ocrSubtotalDisplay', 'ocrTaxAmountDisplay', 'ocrDiscountDisplay', 'ocrGrandTotalDisplay'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = '₹0.00';
    });
    const taxInput = document.getElementById('ocrTaxRateInput');
    if (taxInput) taxInput.value = '0';
    const discInput = document.getElementById('ocrDiscountInput');
    if (discInput) discInput.value = '0';

    // Clear line items table
    const tbody = document.getElementById('ocrLineItemsBody');
    if (tbody) tbody.innerHTML = '';

    Toast.info('Preview cleared. You can now upload a new document.');
  };

  // ==========================================
  // LIVE CAMERA SCANNER
  // ==========================================
  const openCameraModal = async () => {
    Modal.open('modalCamera');
    const video = document.getElementById('cameraVideo');

    try {
      if (state.cameraStream) {
        state.cameraStream.getTracks().forEach((t) => t.stop());
      }

      state.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: state.cameraFacingMode,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });

      video.srcObject = state.cameraStream;
    } catch (err) {
      Toast.error('Camera access denied or unavailable: ' + err.message);
      closeCameraModal();
    }
  };

  const switchCamera = async () => {
    state.cameraFacingMode = state.cameraFacingMode === 'environment' ? 'user' : 'environment';
    await openCameraModal();
  };

  const captureCameraPhoto = () => {
    const video = document.getElementById('cameraVideo');
    const canvas = document.getElementById('cameraCanvas');
    if (!video || !canvas) return;

    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const base64Image = canvas.toDataURL('image/png');
    document.getElementById('ocrImagePreview').src = base64Image;

    closeCameraModal();
    navigateTo('ocr');

    executeUniversalUpload({ imageBase64: base64Image }, 'Camera Capture.png');
  };

  const closeCameraModal = () => {
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach((t) => t.stop());
      state.cameraStream = null;
    }
    Modal.close('modalCamera');
  };

  // ==========================================
  // SAMPLE BILL & SPREADSHEET GENERATOR FOR INSTANT DEMONSTRATION
  // ==========================================
  const loadSampleBill = (type) => {
    navigateTo('ocr');

    if (type === 'stock_sheet') {
      // Simulate instant Excel Stock spreadsheet parsing
      const sampleItems = [
        { name: 'MacBook Pro M3 Max (16GB, 512GB)', quantity_available: 25, unit_price: 199900.00 },
        { name: 'Dell UltraSharp 4K Monitor 27"', quantity_available: 40, unit_price: 34500.00 },
        { name: 'Logitech MX Master 3S Wireless Mouse', quantity_available: 75, unit_price: 8495.00 },
        { name: 'Ergonomic Standing Desk Frame', quantity_available: 18, unit_price: 26000.00 },
        { name: 'Keychron Q1 Pro Mechanical Keyboard', quantity_available: 50, unit_price: 14500.00 },
      ];

      state.currentBatchData = {
        importType: 'stock',
        items: sampleItems,
        fileName: 'Inventory_Stock_Master_2026.xlsx',
      };

      document.getElementById('ocrBatchGrid').style.display = 'block';
      document.getElementById('ocrReviewGrid').style.display = 'none';
      renderBatchTable(sampleItems, 'stock', 'Inventory_Stock_Master_2026.xlsx');
      Toast.info('Sample Excel Stock Spreadsheet parsed! Review table and click Confirm.');
      return;
    }

    if (type === 'cust_sheet') {
      // Simulate instant CSV Customer Directory parsing
      const sampleCusts = [
        { name: 'Tata Consultancy Services', contact_info: '+91 22 6778 9999 | billing@tcs.com', billing_terms: 45 },
        { name: 'Infosys Enterprise Solutions', contact_info: '+91 80 2852 0261 | accounts@infosys.com', billing_terms: 30 },
        { name: 'Wipro Digital Services', contact_info: '+91 80 4672 6000 | finance@wipro.com', billing_terms: 30 },
        { name: 'HCL Technologies Ltd', contact_info: '+91 120 401 3000 | vendor@hcl.com', billing_terms: 60 },
      ];

      state.currentBatchData = {
        importType: 'customers',
        items: sampleCusts,
        fileName: 'Customer_Directory_Q3.csv',
      };

      document.getElementById('ocrBatchGrid').style.display = 'block';
      document.getElementById('ocrReviewGrid').style.display = 'none';
      renderBatchTable(sampleCusts, 'customers', 'Customer_Directory_Q3.csv');
      Toast.info('Sample CSV Customer Directory parsed! Review table and click Confirm.');
      return;
    }

    // Single Invoices
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 1000;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 800, 1000);

    ctx.fillStyle = '#1e293b';
    ctx.font = 'bold 28px sans-serif';

    let vendor = 'Apex Cloud Systems';
    let invNo = `INV-2026-${Math.floor(100 + Math.random() * 900)}`;
    let item1 = 'Cloud Server Hosting (Pro Plan)';
    let item2 = 'SSL Security & Backup Bundle';
    let rate1 = 12000.00;
    let rate2 = 3000.00;

    if (type === 'supplies') {
      vendor = 'Metro Office Supplies Ltd';
      invNo = `BILL-${Math.floor(5000 + Math.random() * 9000)}`;
      item1 = 'Thermal Paper Rolls (Box of 50)';
      item2 = 'Laser Printer Cartridge (Black)';
      rate1 = 4500.00;
      rate2 = 2800.00;
    }

    ctx.fillText(vendor, 50, 80);
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#64748b';
    ctx.fillText('104 Business Avenue, Tech Park, Bangalore', 50, 105);
    ctx.fillText('GSTIN: 29AABCU9603R1Z2 | Ph: +91 9876543210', 50, 125);

    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText(`TAX INVOICE: ${invNo}`, 50, 180);
    ctx.fillText(`Date: ${getTodayDateStr()}`, 500, 180);
    ctx.fillText(`Due Date: ${getTodayDateStr()}`, 500, 205);

    // Line items header
    ctx.fillStyle = '#f1f5f9';
    ctx.fillRect(50, 240, 700, 35);
    ctx.fillStyle = '#1e293b';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('Item Description', 60, 262);
    ctx.fillText('Qty', 450, 262);
    ctx.fillText('Unit Rate', 530, 262);
    ctx.fillText('Total', 660, 262);

    // Rows
    ctx.font = '14px sans-serif';
    ctx.fillText(item1, 60, 310);
    ctx.fillText('1', 455, 310);
    ctx.fillText(`₹${rate1.toFixed(2)}`, 530, 310);
    ctx.fillText(`₹${rate1.toFixed(2)}`, 660, 310);

    ctx.fillText(item2, 60, 350);
    ctx.fillText('1', 455, 350);
    ctx.fillText(`₹${rate2.toFixed(2)}`, 530, 350);
    ctx.fillText(`₹${rate2.toFixed(2)}`, 660, 350);

    const total = rate1 + rate2;
    ctx.fillRect(50, 400, 700, 2);
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('Subtotal:', 530, 440);
    ctx.fillText(`₹${total.toFixed(2)}`, 660, 440);

    ctx.fillText('Grand Total:', 530, 480);
    ctx.fillText(`₹${total.toFixed(2)}`, 660, 480);

    const base64Data = canvas.toDataURL('image/png');
    document.getElementById('ocrImagePreview').src = base64Data;
    executeUniversalUpload({ imageBase64: base64Data }, `${vendor}_Invoice.png`);
  };

  // ==========================================
  // SESSION SCAN HISTORY & EXPORTS
  // ==========================================
  const addScanToHistory = (data) => {
    state.scanHistory.unshift({
      time: new Date().toLocaleTimeString(),
      vendor: data.vendor || 'Scanned Entity',
      invNo: data.invoiceNumber || 'INV-Auto',
      date: data.billDate || getTodayDateStr(),
      total: data.totalAmount || 0,
      data,
    });
    renderScanHistory();
  };

  const renderScanHistory = () => {
    const tbody = document.getElementById('ocrHistoryTableBody');
    if (state.scanHistory.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No documents scanned in this session yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = state.scanHistory.map((h, i) => `
      <tr>
        <td>${h.time}</td>
        <td>📄 Bill Image</td>
        <td><strong>${escapeHtml(h.vendor)}</strong></td>
        <td>${escapeHtml(h.invNo)}</td>
        <td>${formatDate(h.date)}</td>
        <td style="font-weight: 700;">${formatCurrency(h.total)}</td>
        <td><span class="badge badge--paid">Parsed</span></td>
        <td>
          <button class="btn btn--secondary btn--sm" onclick="App.reopenScanHistory(${i});">Re-open</button>
        </td>
      </tr>
    `).join('');
  };

  const reopenScanHistory = (index) => {
    const item = state.scanHistory[index];
    if (item && item.data) {
      state.currentOCRData = item.data;
      document.getElementById('ocrReviewGrid').style.display = 'grid';
      populateOCREditForm(item.data);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const clearScanHistory = () => {
    state.scanHistory = [];
    renderScanHistory();
  };

  const exportScanJSON = () => {
    if (!state.currentOCRData) {
      Toast.warning('No active scan data to export.');
      return;
    }
    const blob = new Blob([JSON.stringify(state.currentOCRData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Scanned_Invoice_${state.currentOCRData.invoiceNumber || 'Export'}.json`;
    a.click();
    URL.revokeObjectURL(url);
    Toast.success('Extracted invoice JSON downloaded.');
  };

  const openPrintSlipModal = () => {
    if (!state.currentOCRData) return;
    const { grandTotal } = recalculateTotals();
    const customer = document.getElementById('ocrCustomerInput').value;
    const invNo = document.getElementById('ocrBillNumberInput').value;
    const billDate = document.getElementById('ocrDateInput').value;

    const modalBody = document.getElementById('modalInvoiceDetailBody');
    modalBody.innerHTML = `
      <div class="invoice-print-view" id="printableInvoiceView">
        <div class="invoice-print-header">
          <div>
            <h2 style="font-size: 1.5rem; font-weight: 800; color: #1e3a8a; margin: 0;">ACCOUNTING BILL VOUCHER</h2>
            <p style="margin: 0.25rem 0 0; font-size: 0.85rem; color: #4b5563;">Verified OCR Scanned Transaction Slip</p>
          </div>
          <div style="text-align: right;">
            <h3 style="margin: 0; font-size: 1.25rem; font-weight: 700;">${escapeHtml(invNo)}</h3>
            <p style="margin: 0.25rem 0 0; font-size: 0.85rem; color: #4b5563;">Date: ${formatDate(billDate)}</p>
          </div>
        </div>

        <div style="margin-bottom: 1.5rem;">
          <h4 style="font-size: 0.8rem; text-transform: uppercase; color: #6b7280; margin-bottom: 0.25rem;">Entity Name:</h4>
          <div style="font-weight: 700; font-size: 1.1rem; color: #111827;">${escapeHtml(customer)}</div>
        </div>

        <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 1.25rem; border-radius: 8px; margin-bottom: 1.5rem; display: flex; justify-content: space-between; align-items: center;">
          <span style="font-size: 1.1rem; font-weight: 700;">Verified Grand Total:</span>
          <span style="font-size: 1.4rem; font-weight: 800; color: #2563eb;">${formatCurrency(grandTotal)}</span>
        </div>

        <div style="border-top: 1px dashed #d1d5db; padding-top: 1rem; text-align: center; font-size: 0.75rem; color: #9ca3af;">
          Verified and Processed with AI OCR Scanner • Accounting Portal
        </div>
      </div>
    `;

    Modal.open('modalInvoiceDetail');
  };

  // ==========================================
  // REPORTS & EXCEL
  // ==========================================
  const syncExcel = async () => {
    const btn = document.getElementById('syncExcelBtn');
    const topBtn = document.getElementById('syncExcelTopBtn');
    if (btn) btn.disabled = true;
    if (topBtn) topBtn.disabled = true;

    try {
      const res = await API.post('/reports/excel/sync', {});
      Toast.success(res.message || 'All Excel reports synchronized with database!');
    } catch (err) {
      Toast.error('Excel sync failed: ' + err.message);
    } finally {
      if (btn) btn.disabled = false;
      if (topBtn) topBtn.disabled = false;
    }
  };

  const downloadLifetimeExcel = async () => {
    try {
      const blob = await API.get('/reports/excel/lifetime');
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'Accounting_Master_Report.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      Toast.success('Master Accounting Excel report downloaded!');
    } catch (err) {
      Toast.error('Download failed: ' + err.message);
    }
  };

  const downloadMonthlyExcel = async () => {
    try {
      const blob = await API.get('/reports/excel/monthly');
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'Accounting_Monthly_Report.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      Toast.success('Monthly Accounting Excel report downloaded!');
    } catch (err) {
      Toast.error('Download failed: ' + err.message);
    }
  };

  // ==========================================
  // USER MANAGEMENT (ADMIN ONLY)
  // ==========================================
  const loadUsers = async () => {
    try {
      const res = await API.get('/auth/me');
      // If admin, load user list
      const tbody = document.getElementById('userTableBody');
      if (state.user) {
        tbody.innerHTML = `
          <tr>
            <td><strong>${escapeHtml(state.user.username)}</strong></td>
            <td><span class="badge badge--paid">${escapeHtml(state.user.role)}</span></td>
            <td>Current Active User</td>
          </tr>
        `;
      }
    } catch (e) {
      console.warn('User load:', e);
    }
  };

  const openUserModal = () => {
    document.getElementById('userForm').reset();
    Modal.open('modalUser');
  };

  // ==========================================
  // EVENT LISTENERS INITIALIZATION
  // ==========================================
  const init = async () => {
    // 1. Auth & Session Check
    const token = API.getToken();
    if (!token) {
      window.location.href = '/login.html';
      return;
    }

    state.user = API.getUser();
    if (state.user) {
      document.querySelectorAll('.js-user-name').forEach((el) => el.textContent = state.user.username);
      document.querySelectorAll('.js-user-role').forEach((el) => el.textContent = state.user.role === 'admin' ? 'Administrator' : 'Accountant');
      document.querySelectorAll('.js-user-avatar').forEach((el) => el.textContent = (state.user.username[0] || 'A').toUpperCase());

      if (state.user.role === 'admin') {
        document.querySelectorAll('.admin-only').forEach((el) => el.style.display = '');
      }
    }

    // 2. Navigation Link Clicks
    document.querySelectorAll('.sidebar__nav .nav-link').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const target = link.getAttribute('data-nav');
        window.location.hash = target;
        navigateTo(target);
      });
    });

    // Handle Hash Routing
    window.addEventListener('hashchange', () => {
      const hash = window.location.hash.replace('#', '') || 'dashboard';
      navigateTo(hash);
    });

    // 3. Logout
    document.querySelectorAll('.js-logout-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        API.removeToken();
        API.removeUser();
        window.location.href = '/login.html';
      });
    });

    // 4. Excel Sync Buttons
    const syncTop = document.getElementById('syncExcelTopBtn');
    if (syncTop) syncTop.addEventListener('click', syncExcel);
    const syncMain = document.getElementById('syncExcelBtn');
    if (syncMain) syncMain.addEventListener('click', syncExcel);

    // 5. Customer Form Submit
    document.getElementById('customerForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('customerIdInput').value;
      const name = document.getElementById('customerNameInput').value.trim();
      const contact = document.getElementById('customerContactInput').value.trim();
      const terms = document.getElementById('customerTermsInput').value;

      try {
        if (id) {
          await API.put(`/customers/${id}`, { name, contact_info: contact, billing_terms: terms });
          Toast.success('Customer updated successfully!');
        } else {
          await API.post('/customers', { name, contact_info: contact, billing_terms: terms });
          Toast.success('Customer created successfully!');
        }
        Modal.close('modalCustomer');
        await refreshAllData();
      } catch (err) {
        Toast.error(err.message);
      }
    });

    // Customer search filter
    const custSearch = document.getElementById('customerSearchInput');
    if (custSearch) {
      custSearch.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const filtered = state.customers.filter((c) =>
          c.name.toLowerCase().includes(query) || (c.contact_info && c.contact_info.toLowerCase().includes(query))
        );
        renderCustomersTable(filtered);
      });
    }

    // 6. Stock Form Submit
    document.getElementById('stockForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('stockIdInput').value;
      const name = document.getElementById('stockNameInput').value.trim();
      const qty = document.getElementById('stockQtyInput').value;
      const price = document.getElementById('stockPriceInput').value;

      try {
        if (id) {
          await API.put(`/stock/${id}`, { name, quantity_available: qty, unit_price: price });
          Toast.success('Stock item updated successfully!');
        } else {
          await API.post('/stock', { name, quantity_available: qty, unit_price: price });
          Toast.success('Stock item created successfully!');
        }
        Modal.close('modalStock');
        await refreshAllData();
      } catch (err) {
        Toast.error(err.message);
      }
    });

    const stockSearch = document.getElementById('stockSearchInput');
    if (stockSearch) {
      stockSearch.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const filtered = state.stock.filter((s) => s.name.toLowerCase().includes(query));
        renderStockTable(filtered);
      });
    }

    // 7. Sales Entry Form Submit & Real-Time Calculations
    const saleItemSelect = document.getElementById('saleItemSelect');
    const saleUnitsInput = document.getElementById('saleUnitsInput');
    const saleRateInput = document.getElementById('saleRateInput');
    const saleTotalEl = document.getElementById('saleCalculatedTotal');

    const updateSaleCalc = () => {
      const units = parseFloat(saleUnitsInput.value) || 0;
      const rate = parseFloat(saleRateInput.value) || 0;
      saleTotalEl.textContent = formatCurrency(units * rate);
    };

    saleItemSelect.addEventListener('change', () => {
      const opt = saleItemSelect.selectedOptions[0];
      if (opt && opt.dataset.price) {
        saleRateInput.value = parseFloat(opt.dataset.price).toFixed(2);
        const avail = opt.dataset.qty || '0';
        document.getElementById('saleStockAvailableHint').textContent = `In stock: ${avail} units`;
      } else {
        document.getElementById('saleStockAvailableHint').textContent = '';
      }
      updateSaleCalc();
    });

    saleUnitsInput.addEventListener('input', updateSaleCalc);
    saleRateInput.addEventListener('input', updateSaleCalc);

    document.getElementById('saleDateInput').value = getTodayDateStr();

    document.getElementById('newSaleForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const customer_id = document.getElementById('saleCustomerSelect').value;
      const item_id = document.getElementById('saleItemSelect').value;
      const units_sold = document.getElementById('saleUnitsInput').value;
      const rate = document.getElementById('saleRateInput').value;
      const sale_date = document.getElementById('saleDateInput').value;

      try {
        const res = await API.post('/sales', { customer_id, item_id, units_sold, rate, sale_date });
        Toast.success('Sale created and Invoice generated successfully!');
        document.getElementById('newSaleForm').reset();
        document.getElementById('saleDateInput').value = getTodayDateStr();
        updateSaleCalc();
        await refreshAllData();
      } catch (err) {
        Toast.error(err.message);
      }
    });

    // 8. Invoices Filter Tabs
    document.querySelectorAll('.filter-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.filter-tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        state.invoiceFilter = tab.getAttribute('data-invoice-filter');
        renderInvoicesTable();
      });
    });

    // 3-Day Notice cron check trigger
    const cronBtn = document.getElementById('runCronCheckBtn');
    if (cronBtn) {
      cronBtn.addEventListener('click', async () => {
        try {
          const res = await API.post('/cron/run-check', {});
          Toast.success(`Notice check completed! ${res.noticesSent || 0} notices generated.`);
          await loadInvoices();
          await loadReminders();
        } catch (err) {
          Toast.error('Cron check failed: ' + err.message);
        }
      });
    }

    // 9. Payment Form Submit
    document.getElementById('paymentForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const invoice_id = document.getElementById('paymentInvoiceSelect').value;
      const amount_paid = document.getElementById('paymentAmountInput').value;
      const payment_date = document.getElementById('paymentDateInput').value;
      const mode = document.getElementById('paymentModeSelect').value;
      const notes = document.getElementById('paymentNotesInput').value.trim();

      try {
        await API.post('/payments', { invoice_id, amount_paid, payment_date, mode, notes });
        Toast.success('Payment recorded and invoice status updated!');
        Modal.close('modalPayment');
        await refreshAllData();
      } catch (err) {
        Toast.error(err.message);
      }
    });

    // Invoice selection in Payment Form auto-populates amount
    const payInvSelect = document.getElementById('paymentInvoiceSelect');
    if (payInvSelect) {
      payInvSelect.addEventListener('change', () => {
        const opt = payInvSelect.selectedOptions[0];
        if (opt && opt.dataset.amount) {
          document.getElementById('paymentAmountInput').value = parseFloat(opt.dataset.amount).toFixed(2);
        }
      });
    }

    // 10. User Form Submit (Admin Only)
    const userForm = document.getElementById('userForm');
    if (userForm) {
      userForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('userUsernameInput').value.trim();
        const password = document.getElementById('userPasswordInput').value;
        const role = document.getElementById('userRoleSelect').value;

        try {
          await API.post('/auth/register-user', { username, password, role });
          Toast.success(`User "${username}" created successfully!`);
          Modal.close('modalUser');
          await loadUsers();
        } catch (err) {
          Toast.error(err.message);
        }
      });
    }

    // 11. Theme Toggle
    const themeBtn = document.getElementById('themeToggleBtn');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => {
        const html = document.documentElement;
        const current = html.getAttribute('data-theme') || 'dark';
        const next = current === 'dark' ? 'light' : 'dark';
        html.setAttribute('data-theme', next);
        localStorage.setItem('accounting_theme', next);
      });
    }

    const savedTheme = localStorage.getItem('accounting_theme');
    if (savedTheme) {
      document.documentElement.setAttribute('data-theme', savedTheme);
    }

    // 12. Initialize AI OCR Scanner
    initOCR();

    // 13. Initial Load
    const initialHash = window.location.hash.replace('#', '') || 'dashboard';
    navigateTo(initialHash);
    await refreshAllData();
  };

  // Public Interface
  return {
    init,
    navigateTo,
    openCustomerModal,
    deleteCustomer,
    openStockModal,
    deleteStock,
    deleteSale,
    deleteInvoice,
    viewInvoice,
    printCurrentModal,
    openPaymentModal,
    openPaymentForInvoice,
    deletePayment,
    openUserModal,
    openCameraModal,
    closeCameraModal,
    switchCamera,
    captureCameraPhoto,
    loadSampleBill,
    reopenScanHistory,
    clearScanHistory,
    exportScanJSON,
    openPrintSlipModal,
    addOCRLineItem,
    removeOCRLineItem,
    recalculateTotals,
    setQuickDueDate,
    setScanDocType,
    resetOCRView,
    syncExcel,
    downloadLifetimeExcel,
    downloadMonthlyExcel,
  };
})();

// Bootstrap application on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
