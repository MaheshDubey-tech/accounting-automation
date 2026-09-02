const cron = require('node-cron');
const { query, withTransaction } = require('../config/db');

/**
 * Check all pending invoices:
 * 1. If due_date < today -> update status to 'overdue'
 * 2. If due_date is exactly 3 days away -> log a reminder in reminders_log
 */
const runInvoiceStatusCheck = async () => {
  console.log(`[Invoice Cron] Running daily invoice status & reminder check at ${new Date().toISOString()}...`);
  
  return await withTransaction(async (client) => {
    // 1. Find and update overdue invoices
    const overdueResult = await client.query(`
      UPDATE invoices
      SET status = 'overdue', updated_at = CURRENT_TIMESTAMP
      WHERE status = 'pending' AND due_date < CURRENT_DATE
      RETURNING id, customer_id, amount, due_date;
    `);

    const overdueCount = overdueResult.rowCount;
    if (overdueCount > 0) {
      console.log(`[Invoice Cron] Marked ${overdueCount} invoice(s) as OVERDUE:`, overdueResult.rows.map(r => r.id));
    }

    // 2. Find pending invoices due in exactly 3 days (CURRENT_DATE + interval '3 days')
    // and log reminders if not already logged today
    const upcomingResult = await client.query(`
      SELECT inv.id, inv.amount, inv.due_date, c.name AS customer_name, c.contact_info
      FROM invoices inv
      JOIN customers c ON inv.customer_id = c.id
      WHERE inv.status = 'pending'
        AND inv.due_date = CURRENT_DATE + INTERVAL '3 days'
        AND NOT EXISTS (
          SELECT 1 FROM reminders_log r 
          WHERE r.invoice_id = inv.id 
            AND r.reminder_date = CURRENT_DATE
        );
    `);

    let reminderCount = 0;
    for (const inv of upcomingResult.rows) {
      const message = `Reminder: Invoice #${inv.id} for ${inv.customer_name} ($${parseFloat(inv.amount).toFixed(2)}) is due in 3 days on ${new Date(inv.due_date).toISOString().split('T')[0]}. Contact: ${inv.contact_info || 'N/A'}`;
      
      await client.query(`
        INSERT INTO reminders_log (invoice_id, reminder_date, message)
        VALUES ($1, CURRENT_DATE, $2);
      `, [inv.id, message]);

      reminderCount++;
      console.log(`[Invoice Cron] Logged 3-day reminder for Invoice #${inv.id}`);
    }

    return {
      success: true,
      timestamp: new Date().toISOString(),
      overdueUpdated: overdueCount,
      overdueInvoices: overdueResult.rows,
      remindersLogged: reminderCount,
      upcomingInvoices: upcomingResult.rows,
    };
  });
};

/**
 * Initialize node-cron schedule (Runs every day at midnight 00:05)
 */
const initInvoiceCron = () => {
  // '5 0 * * *' = at 00:05 every day
  const task = cron.schedule('5 0 * * *', async () => {
    try {
      await runInvoiceStatusCheck();
    } catch (error) {
      console.error('[Invoice Cron] Error during scheduled execution:', error);
    }
  });

  console.log('[Invoice Cron] Daily invoice evaluation job scheduled (00:05 everyday)');
  return task;
};

module.exports = {
  runInvoiceStatusCheck,
  initInvoiceCron,
};
