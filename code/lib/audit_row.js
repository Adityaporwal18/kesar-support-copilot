// Builds the one audit-log row written for every email. Keys are exactly the
// columns of setup/audit_log_header.csv, in order. Pure: no I/O, no clock.

// --- BEGIN PURE ---
function buildAuditRow(ctx) {
  const x = ctx || {};
  const email = x.email || {};
  const c = x.classification || {};
  const lookup = x.lookup || {};
  const route = x.route || {};
  const yesNo = function (v) { return v ? 'TRUE' : 'FALSE'; };
  const version = x.prompt_version || '';

  // The resolved order, or the ID the customer wrote even if it does not exist (e.g. KC-1099).
  const orderId = lookup.order_id || c.order_id || '';

  return {
    email_id: email.email_id || '',
    received_at: email.received_at || '',
    from_email: email.from_email || '',
    intent: c.intent || '',
    secondary_intent: c.secondary_intent || '',
    order_id: orderId,
    language: c.language || '',
    sentiment: c.sentiment || '',
    confidence: typeof c.confidence === 'number' ? c.confidence : '',
    order_found: yesNo(lookup.found),
    action_taken: x.action_taken || '',
    needs_human: yesNo(x.needs_human),
    ticket_id: x.ticket_id || '',
    reply_draft: x.reply_draft || '',
    prompt_version: version,
    processed_at: x.processed_at || '',
    error: x.error || '',
    notes: Array.isArray(x.notes) ? x.notes.join('; ') : (x.notes || ''),
    audit_key: (email.email_id || '') + '|' + version,
    json_valid_first_try: yesNo(x.json_valid_first_try),
    needs_human_reasons: Array.isArray(x.needs_human_reasons) ? x.needs_human_reasons.join('; ') : (x.needs_human_reasons || ''),
    tokens_est: typeof x.tokens_est === 'number' ? x.tokens_est : '',
    cost_usd_est: typeof x.cost_usd_est === 'number' ? x.cost_usd_est : '',
  };
}
// --- END PURE ---

if (typeof module !== 'undefined') module.exports = { buildAuditRow };
