// Decides whether an email creates a ticket, updates an open one, or changes
// nothing. One open ticket per order: a follow-up email adds a note and its
// ID to the existing row instead of creating a duplicate. Pure: `now` is injected.

// --- BEGIN PURE ---
function ticketDecision(input) {
  const rows = (input && input.rows) || [];
  const email = (input && input.email) || {};
  const c = (input && input.classification) || {};
  const lookup = (input && input.lookup) || {};
  const route = (input && input.route) || {};
  const now = (input && input.now) || '';

  if (!route.ticket_needed) return { action: 'none', row: null };

  const orderId = lookup.order_id || c.order_id || '';
  const customerEmail = email.from_email || '';
  const attachments = Array.isArray(email.attachments) ? email.attachments.length : 0;
  const noteLine = '[' + (email.received_at || '') + '] ' + (email.email_id || '') + ': ' + (c.summary || '') +
    (attachments > 0 ? ' (attachments: ' + attachments + ')' : '');

  const open = rows.filter(function (r) {
    if (String(r.status || '').trim().toLowerCase() === 'closed') return false;
    if (orderId) return String(r.order_id || '').trim().toUpperCase() === String(orderId).toUpperCase();
    // No order ID: fall back to the same customer and the same kind of issue.
    return !String(r.order_id || '').trim() && String(r.customer_email || '').trim().toLowerCase() === customerEmail && String(r.intent || '') === String(route.route || c.intent || '');
  });

  if (open.length > 0) {
    const t = Object.assign({}, open[0]);
    const ids = String(t.email_ids || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (ids.indexOf(email.email_id) !== -1) return { action: 'unchanged', row: t }; // re-sent email: idempotent
    ids.push(email.email_id);
    t.email_ids = ids.join(', ');
    t.notes = (String(t.notes || '').trim() ? String(t.notes).trim() + '\n' : '') + noteLine;
    t.updated_at = now;
    if (route.priority === 'High') t.priority = 'High'; // priority can rise, never fall
    return { action: 'update', row: t };
  }

  // The ticket ID is derived from the order (TKT-1052), not from a counter. Two emails about
  // different orders can then never be given the same ID, even if they are processed at the
  // same moment (a counter read from the Sheet collided in a test run when two runs overlapped).
  const base = orderId ? 'TKT-' + String(orderId).toUpperCase().replace(/^KC-/, '') : 'TKT-' + String(email.email_id || 'X');
  const taken = rows.map(function (r) { return String(r.ticket_id || '').trim(); });
  let ticketId = base;
  for (let n = 2; taken.indexOf(ticketId) !== -1; n++) ticketId = base + '-' + n; // a closed ticket already used this ID

  return {
    action: 'create',
    row: {
      ticket_id: ticketId,
      created_at: now,
      updated_at: now,
      order_id: orderId,
      customer_email: customerEmail,
      email_ids: email.email_id || '',
      intent: route.route || c.intent || '',
      priority: route.priority || 'Medium',
      status: 'Open',
      summary: c.summary || '',
      notes: noteLine,
    },
  };
}
// --- END PURE ---

if (typeof module !== 'undefined') module.exports = { ticketDecision };
