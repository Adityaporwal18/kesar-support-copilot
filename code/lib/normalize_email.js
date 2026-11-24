// Turns the raw webhook body (one email from test_emails.json) into the flat
// shape the rest of the workflow uses. Pure: no I/O, no clock.

// --- BEGIN PURE ---
function normalizeEmail(body) {
  const b = body || {};
  const from = b.from || {};
  if (!b.id) return { error: 'bad_input: id' };
  if (!from.email) return { error: 'bad_input: from.email' };
  if (!b.received_at) return { error: 'bad_input: received_at' };

  const subject = String(b.subject || '');
  const text = String(b.body || '');
  const fromName = String(from.name || '').trim();
  const haystack = subject + '\n' + text;

  // Order IDs that literally appear in the email. Used to cross-check the LLM.
  const ids = [];
  const re = /\bKC-\d{4}\b/gi;
  let m;
  while ((m = re.exec(haystack)) !== null) {
    const id = m[0].toUpperCase();
    if (ids.indexOf(id) === -1) ids.push(id);
  }

  return {
    email_id: String(b.id),
    received_at: String(b.received_at),
    received_date: String(b.received_at).slice(0, 10),
    from_name: fromName,
    from_first_name: fromName.split(/\s+/)[0] || '',
    from_email: String(from.email).trim().toLowerCase(),
    subject: subject,
    body: text,
    attachments: Array.isArray(b.attachments) ? b.attachments : [],
    text: haystack,
    order_ids_in_text: ids,
  };
}
// --- END PURE ---

if (typeof module !== 'undefined') module.exports = { normalizeEmail };
