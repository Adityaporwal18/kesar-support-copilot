// Offline tests for every deterministic rule. No LLM, no network, no n8n.
// Run: node --test code/test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const lib = (name) => require(path.join(root, 'code', 'lib', name));
const { normalizeEmail } = lib('normalize_email.js');
const { validateClassification, fallbackClassification, strictErrors } = lib('validate_classification.js');
const { resolveOrder } = lib('resolve_order.js');
const { computeFacts } = lib('compute_facts.js');
const { decideRoute } = lib('decide_route.js');
const { searchFaq } = lib('search_faq.js');
const { parseAgentOutput, postcheckReply } = lib('postcheck_reply.js');
const { ticketDecision } = lib('ticket_upsert.js');
const { buildAuditRow } = lib('audit_row.js');

const data = (f) => fs.readFileSync(path.join(root, 'assignment', 'data', f), 'utf8');
const emails = JSON.parse(data('test_emails.json')).emails;
const orders = JSON.parse(data('orders.json')).orders;
const faq = data('faq.md');
const key = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'answer_key.json'), 'utf8')).emails;
const config = { RETURN_WINDOW_DAYS: 7, DAMAGE_WINDOW_DAYS: 2, CONFIDENCE_THRESHOLD: 0.75 };
const E = (id) => normalizeEmail(emails.find((e) => e.id === id));
const lookupFor = (id, orderId) => resolveOrder({ orders, order_id: orderId, requester_email: E(id).from_email, allow_email_fallback: true, include_withheld: true });

// What a correct classifier would extract for each email (used to test the rules, not the LLM).
const extra = {
  E03: { product_condition: 'unopened' }, E11: { product_condition: 'unopened' }, E19: { product_condition: 'unopened' },
  E12: { product_condition: 'opened_or_used', risk_flags: ['embedded_instructions'] }, E16: { product_condition: 'opened_or_used' },
  E04: { issue_type: 'damaged' }, E21: { issue_type: 'damaged' }, E08: { issue_type: 'leaking', sentiment: 'angry', risk_flags: ['threat_public'] },
  E14: { issue_type: 'wrong_item' }, E23: { issue_type: 'missing_item' },
  E06: { other_category: 'spam', needs_reply: false }, E13: { other_category: 'business_request' },
  E17: { other_category: 'partnership' }, E25: { other_category: 'feedback', sentiment: 'positive', needs_reply: false },
  E20: { risk_flags: ['medical'] }, E18: { confidence: 0.6, sentiment: 'negative' },
};
function classificationFor(id) {
  const e = E(id);
  const k = key[id];
  const idInText = e.order_ids_in_text[0] || null;
  return Object.assign({
    intent: k.intent[0], secondary_intent: null, order_id: idInText, sentiment: 'neutral', language: k.language,
    confidence: 0.9, summary: 'Test summary for ' + id, product_condition: 'unknown', issue_type: 'none',
    other_category: 'unclear', risk_flags: [], needs_reply: true,
  }, extra[id] || {});
}
function pipeline(id) {
  const email = E(id);
  const classification = classificationFor(id);
  const needsLookup = ['order_status', 'return_refund', 'complaint'].includes(classification.intent) || !!classification.order_id;
  const lookup = needsLookup ? lookupFor(id, classification.order_id) : { found: false, authorized: false, match_method: 'none', order_id: null, order: null };
  const facts = computeFacts({ email, classification, lookup, config });
  const route = decideRoute({ email, classification, lookup, facts, config });
  return { email, classification, lookup, facts, route };
}

test('normalizeEmail: fields and order ids', () => {
  assert.deepStrictEqual(E('E01').order_ids_in_text, ['KC-1041']);
  assert.deepStrictEqual(E('E10').order_ids_in_text, []);
  assert.deepStrictEqual(E('E22').order_ids_in_text, ['KC-1099']);
  assert.strictEqual(E('E01').received_date, '2026-11-20');
  assert.strictEqual(E('E01').from_first_name, 'Ananya');
  assert.match(normalizeEmail({}).error, /bad_input/);
  assert.match(normalizeEmail({ id: 'X', from: {} }).error, /from\.email/);
});

test('validateClassification: schema example and fenced JSON are valid', () => {
  const ok = '{"intent":"order_status","secondary_intent":null,"order_id":"KC-1000","sentiment":"neutral","language":"en","confidence":0.94,"summary":"Customer asking for delivery date of order KC-1000."}';
  const r = validateClassification(ok, 'my order KC-1000');
  assert.strictEqual(r.valid_strict, true);
  assert.strictEqual(r.classification.order_id, 'KC-1000');
  assert.strictEqual(r.classification.product_condition, 'unknown');
  const fenced = validateClassification('Here you go:\n```json\n' + ok + '\n```', 'KC-1000');
  assert.strictEqual(fenced.valid_strict, true);
});

test('validateClassification: invalid outputs', () => {
  const base = { intent: 'order_status', secondary_intent: null, order_id: null, sentiment: 'neutral', language: 'en', confidence: 0.9, summary: 's' };
  const missing = Object.assign({}, base); delete missing.sentiment;
  assert.strictEqual(validateClassification(JSON.stringify(missing), '').valid_strict, false);
  assert.strictEqual(validateClassification(JSON.stringify(missing), '').classification, null);
  const badIntent = validateClassification(JSON.stringify(Object.assign({}, base, { intent: 'refund' })), '');
  assert.strictEqual(badIntent.valid_strict, false);
  assert.strictEqual(badIntent.code_fixable, false);
  assert.strictEqual(validateClassification('I think this is an order question.', '').valid_strict, false);
});

test('validateClassification: code fixes and semantic normalisation', () => {
  const base = { intent: 'order_status', secondary_intent: null, order_id: null, sentiment: 'neutral', language: 'en', confidence: 0.9, summary: 's' };
  const long = validateClassification(JSON.stringify(Object.assign({}, base, { summary: 'x'.repeat(250) })), '');
  assert.strictEqual(long.valid_strict, false);
  assert.strictEqual(long.code_fixable, true);
  assert.strictEqual(long.classification.summary.length, 200);
  const ghost = validateClassification(JSON.stringify(Object.assign({}, base, { order_id: 'KC-9999' })), 'no id in this email');
  assert.strictEqual(ghost.valid_strict, true);
  assert.strictEqual(ghost.classification.order_id, null);
  assert.ok(ghost.notes.includes('order_id_dropped_not_in_email'));
  const same = validateClassification(JSON.stringify(Object.assign({}, base, { secondary_intent: 'order_status' })), '');
  assert.strictEqual(same.classification.secondary_intent, null);
  assert.deepStrictEqual(strictErrors(fallbackClassification()), []);
  assert.strictEqual(fallbackClassification().intent, 'other');
});

test('resolveOrder: owner, non-owner, email fallback, missing', () => {
  const e01 = lookupFor('E01', 'KC-1041');
  assert.ok(e01.found && e01.authorized);
  assert.match(e01.order.tracking_url, /SS7781041$/);
  const e07 = resolveOrder({ orders, order_id: 'KC-1046', requester_email: 'arjun.nair@example.com' });
  assert.strictEqual(e07.found, true);
  assert.strictEqual(e07.authorized, false);
  assert.strictEqual(e07.order, null);
  assert.doesNotMatch(JSON.stringify(e07), /Adyar|track\.example\.com|600020/); // tool output leaks nothing
  const e10 = lookupFor('E10', null);
  assert.strictEqual(e10.order_id, 'KC-1044');
  assert.strictEqual(e10.match_method, 'sender_email');
  assert.strictEqual(lookupFor('E22', 'KC-1099').found, false);
  assert.strictEqual(lookupFor('E22', 'KC-1099').order_id, 'KC-1099');
  assert.strictEqual(lookupFor('E18', null).found, false);
  assert.ok(resolveOrder({ orders, order_id: 'kc-1041', requester_email: ' Ananya.Rao@Example.com ' }).authorized);
});

test('computeFacts: days and eligibility come from received_at', () => {
  const days = { E03: 4, E11: 5, E12: 8, E16: 15, E19: 3 };
  for (const id of Object.keys(days)) assert.strictEqual(pipeline(id).facts.days_since_delivery, days[id], id);
  assert.strictEqual(pipeline('E03').facts.return_eligibility, 'ELIGIBLE');
  assert.strictEqual(pipeline('E03').facts.refundable_amount, 899);
  assert.strictEqual(pipeline('E11').facts.refundable_amount, 3499);
  assert.strictEqual(pipeline('E19').facts.refundable_amount, 1648);
  assert.strictEqual(pipeline('E12').facts.return_eligibility, 'INELIGIBLE_BOTH');
  assert.strictEqual(pipeline('E16').facts.return_eligibility, 'INELIGIBLE_BOTH');
  assert.strictEqual(pipeline('E24').facts.order_cancelled, true);
  assert.strictEqual(pipeline('E04').facts.damage_window_ok, true);
  const src = fs.readFileSync(path.join(root, 'code', 'lib', 'compute_facts.js'), 'utf8');
  assert.doesNotMatch(src, /Date\.now|new Date\(\)/); // no wall clock in policy code
});

test('decideRoute: all 25 emails match the answer key', () => {
  for (const e of emails) {
    const k = key[e.id];
    const p = pipeline(e.id);
    assert.strictEqual(p.route.needs_human, k.needs_human, e.id + ' needs_human ' + JSON.stringify(p.route.needs_human_reasons));
    assert.strictEqual(p.route.ticket_needed, k.ticket !== 'none', e.id + ' ticket_needed');
    if (k.ticket_priority) assert.strictEqual(p.route.priority, k.ticket_priority, e.id + ' priority');
    assert.strictEqual(p.lookup.found, k.order_found, e.id + ' order_found');
  }
});

test('decideRoute: privacy brief carries no order detail; low confidence flags', () => {
  const p = pipeline('E07');
  assert.strictEqual(p.route.privacy_block, true);
  assert.doesNotMatch(p.route.agent_brief, /Adyar|Chennai|track\.example\.com|SwiftShip|2026-11-22|3499/);
  const email = E('E01');
  const c = Object.assign(classificationFor('E01'), { confidence: 0.5 });
  const lookup = lookupFor('E01', 'KC-1041');
  const r = decideRoute({ email, classification: c, lookup, facts: computeFacts({ email, classification: c, lookup, config }), config });
  assert.ok(r.needs_human && r.needs_human_reasons.includes('low_confidence'));
});

test('searchFaq: right sections, and nothing for uncovered topics', () => {
  const first = (q) => searchFaq(faq, q).matches.map((m) => m.section);
  assert.deepStrictEqual(first('return unopened product refund').sort(), [4, 6]);
  assert.strictEqual(first('cash on delivery fee')[0], 2);
  assert.strictEqual(first('delivery time north east')[0], 1);
  assert.strictEqual(first('saffron serum oily skin vegan')[0], 7);
  assert.strictEqual(first('eczema cure')[0], 8);
  assert.strictEqual(first('damaged leaking wrong missing')[0], 5);
  assert.strictEqual(first('partnership influencer')[0], 9);
  const none = searchFaq(faq, 'GST invoice');
  assert.deepStrictEqual(none.matches, []);
  assert.match(none.note, /escalate/);
  assert.deepStrictEqual(searchFaq(faq, '').matches, []);
  assert.ok(searchFaq(faq, 'cash on delivery fee').matches[0].text.includes('49'));
});

test('parseAgentOutput: header lines and fallback', () => {
  const p = parseAgentOutput('STATUS: OK\nFAQ: 1, 2\nHi Ananya,\n\nBody.\n\nWarm regards,\nTeam Kesar');
  assert.strictEqual(p.escalate, false);
  assert.deepStrictEqual(p.faq_sections, [1, 2]);
  assert.match(p.reply, /^Hi Ananya/);
  const esc = parseAgentOutput('STATUS: ESCALATE - not in FAQ\nFAQ: NONE\nHi,\nA team member will follow up.');
  assert.strictEqual(esc.escalate, true);
  assert.strictEqual(esc.escalate_reason, 'not in FAQ');
  assert.strictEqual(parseAgentOutput('Hi there, no header').format_error, true);
});

test('postcheckReply: critical failures replace the draft', () => {
  const sign = '\n\nWarm regards,\nTeam Kesar';
  const p1 = pipeline('E01');
  const good = 'Hi Ananya,\n\nYour order has shipped with SwiftShip and is expected by 21 Nov. Track it here: https://track.example.com/SS7781041.' + sign;
  const ok = postcheckReply({ draft: good, lookup: p1.lookup, facts: p1.facts, route: p1.route, faqText: faq, first_name: 'Ananya', tools_called: ['get_order'] });
  assert.deepStrictEqual(ok.critical, []);
  assert.strictEqual(ok.replaced, false);
  const fake = postcheckReply({ draft: 'Hi,\nTrack: https://track.example.com/FAKE123' + sign, lookup: p1.lookup, facts: p1.facts, route: p1.route, faqText: faq, first_name: 'Ananya' });
  assert.ok(fake.critical.includes('invented_url'));
  assert.ok(fake.replaced && /24 business hours/.test(fake.reply_draft));

  const p7 = pipeline('E07');
  const leak = postcheckReply({ draft: 'Hi Arjun,\nIt is going to Adyar, Chennai.' + sign, lookup: p7.lookup, facts: p7.facts, route: p7.route, faqText: faq, first_name: 'Arjun' });
  assert.ok(leak.critical.includes('privacy_leak'));
  assert.doesNotMatch(leak.reply_draft, /Adyar/);
  const safe = postcheckReply({ draft: 'Hi Arjun,\nFor privacy we can only share order details with the customer who placed the order. Please ask Meera to write to us from the email address used for the order.' + sign, lookup: p7.lookup, facts: p7.facts, route: p7.route, faqText: faq, first_name: 'Arjun' });
  assert.deepStrictEqual(safe.critical, []);

  const p20 = pipeline('E20');
  const cure = postcheckReply({ draft: 'Hi Lakshmi,\nThis oil will cure your eczema in two weeks.' + sign, lookup: p20.lookup, facts: p20.facts, route: p20.route, faqText: faq, first_name: 'Lakshmi' });
  assert.ok(cure.critical.includes('medical_claim'));
  const noCure = postcheckReply({ draft: 'Hi Lakshmi,\nOur products are cosmetics and are not intended to treat or cure any condition. Please consult a dermatologist before use.' + sign, lookup: p20.lookup, facts: p20.facts, route: p20.route, faqText: faq, first_name: 'Lakshmi' });
  assert.deepStrictEqual(noCure.critical, []);

  const p12 = pipeline('E12');
  const approved = postcheckReply({ draft: 'Hi Manish,\nYour refund of Rs 2,448 has been approved.' + sign, lookup: p12.lookup, facts: p12.facts, route: p12.route, faqText: faq, first_name: 'Manish' });
  assert.ok(approved.critical.includes('refund_promise'));

  const p24 = pipeline('E24');
  const cancelled = postcheckReply({ draft: 'Hi Deepak,\nYour order was cancelled on 16 Nov because the item was out of stock. A refund of INR 828 was initiated to your original payment method on 16 Nov.' + sign, lookup: p24.lookup, facts: p24.facts, route: p24.route, faqText: faq, first_name: 'Deepak', tools_called: ['get_order'] });
  assert.deepStrictEqual(cancelled.critical, []);

  const amount = postcheckReply({ draft: 'Hi Ananya,\nWe will refund Rs 5,555.' + sign, lookup: p1.lookup, facts: p1.facts, route: p1.route, faqText: faq, first_name: 'Ananya' });
  assert.ok(amount.critical.includes('unbacked_amount'));
  const noSign = postcheckReply({ draft: 'Hi Ananya,\nYour order is on its way.', lookup: p1.lookup, facts: p1.facts, route: p1.route, faqText: faq, first_name: 'Ananya', tools_called: ['get_order'] });
  assert.ok(noSign.soft.includes('signoff_appended'));
  assert.match(noSign.reply_draft, /Warm regards,\nTeam Kesar$/);
});

test('ticketDecision: create, update, unchanged, closed, sequence', () => {
  const now = '2026-11-20T10:00:00+05:30';
  const p4 = pipeline('E04');
  const created = ticketDecision({ rows: [], email: p4.email, classification: p4.classification, lookup: p4.lookup, route: p4.route, now });
  assert.strictEqual(created.action, 'create');
  assert.strictEqual(created.row.ticket_id, 'TKT-001');
  assert.strictEqual(created.row.priority, 'High');
  assert.strictEqual(created.row.order_id, 'KC-1052');
  const p21 = pipeline('E21');
  const updated = ticketDecision({ rows: [created.row], email: p21.email, classification: p21.classification, lookup: p21.lookup, route: p21.route, now });
  assert.strictEqual(updated.action, 'update');
  assert.strictEqual(updated.row.ticket_id, 'TKT-001');
  assert.strictEqual(updated.row.email_ids, 'E04, E21');
  assert.strictEqual(updated.row.notes.split('\n').length, 2);
  assert.match(updated.row.notes, /attachments: 2/);
  const again = ticketDecision({ rows: [updated.row], email: p4.email, classification: p4.classification, lookup: p4.lookup, route: p4.route, now });
  assert.strictEqual(again.action, 'unchanged');
  const closed = Object.assign({}, created.row, { status: 'Closed' });
  const reopened = ticketDecision({ rows: [closed, { ticket_id: 'TKT-007' }], email: p4.email, classification: p4.classification, lookup: p4.lookup, route: p4.route, now });
  assert.strictEqual(reopened.action, 'create');
  assert.strictEqual(reopened.row.ticket_id, 'TKT-008');
  const p1 = pipeline('E01');
  assert.strictEqual(ticketDecision({ rows: [], email: p1.email, classification: p1.classification, lookup: p1.lookup, route: p1.route, now }).action, 'none');
  const p12 = pipeline('E12'); // priority comes from intent, never from the email text
  assert.strictEqual(ticketDecision({ rows: [], email: p12.email, classification: p12.classification, lookup: p12.lookup, route: p12.route, now }).row.priority, 'Medium');
});

test('ticket simulation over all 25 emails gives 9 tickets and no duplicate order', () => {
  let rows = [];
  for (const e of emails) {
    const p = pipeline(e.id);
    const d = ticketDecision({ rows, email: p.email, classification: p.classification, lookup: p.lookup, route: p.route, now: 'now' });
    assert.strictEqual(d.action === 'none' ? 'none' : d.action, key[e.id].ticket, e.id + ' ticket action');
    if (d.action === 'create') rows.push(d.row);
    if (d.action === 'update') rows = rows.map((r) => (r.ticket_id === d.row.ticket_id ? d.row : r));
  }
  assert.strictEqual(rows.length, 9);
  assert.strictEqual(new Set(rows.map((r) => r.order_id)).size, 9);
  assert.strictEqual(rows.find((r) => r.order_id === 'KC-1052').email_ids, 'E04, E21');
});

test('buildAuditRow: keys equal the sheet header', () => {
  const header = fs.readFileSync(path.join(root, 'setup', 'audit_log_header.csv'), 'utf8').trim().split(',');
  const p = pipeline('E22');
  const row = buildAuditRow({ email: p.email, classification: p.classification, lookup: p.lookup, route: p.route, prompt_version: 'v2', needs_human: true, needs_human_reasons: p.route.needs_human_reasons, action_taken: 'draft_reply', json_valid_first_try: true });
  assert.deepStrictEqual(Object.keys(row), header);
  assert.strictEqual(row.order_id, 'KC-1099');
  assert.strictEqual(row.order_found, 'FALSE');
  assert.strictEqual(row.audit_key, 'E22|v2');
});
