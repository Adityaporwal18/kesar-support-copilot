// Routing, priority and the needs-human decision. Everything here is a hard
// rule in code: nothing written in an email can change priority, skip a
// ticket, or clear the needs-human flag. Pure: no I/O, no clock.

// --- BEGIN PURE ---
const DR_MEDICAL = /\b(eczema|psoriasis|dermatitis|rosacea|allerg(y|ic|ies)|rash(es)?|infection|pregnan(t|cy)|skin (disease|condition)|medical|cure[sd]?|itch(y|ing)?|swelling|swollen|burning)\b/i;
const DR_INSTRUCTIONS = /(ignore (all |any )?(the )?(previous|prior|above) (instructions|rules)|system (note|prompt|message)|\bAI assistant\b|as an ai\b|disregard (the |all )?(polic(y|ies)|rules|instructions))/i;

function decideRoute(input) {
  const c = (input && input.classification) || {};
  const lookup = (input && input.lookup) || {};
  const facts = (input && input.facts) || {};
  const cfg = (input && input.config) || {};
  const email = (input && input.email) || {};
  const threshold = typeof cfg.CONFIDENCE_THRESHOLD === 'number' ? cfg.CONFIDENCE_THRESHOLD : 0.75;

  const llmIntent = c.intent || 'other';
  const text = String(email.text || '');
  const flags = (Array.isArray(c.risk_flags) ? c.risk_flags : []).slice();

  // Deterministic backstops (added in v2 after v1 missed these). They do not rely on the model.
  // 1. Medical or skin-reaction words: FAQ section 8 says a human must handle these.
  if (DR_MEDICAL.test(text) && flags.indexOf('medical') === -1) flags.push('medical');
  // 2. Text that addresses an AI or tries to override rules is flagged; it never changes routing.
  if (DR_INSTRUCTIONS.test(text) && flags.indexOf('embedded_instructions') === -1) flags.push('embedded_instructions');
  // 3. A damaged, leaking, wrong or missing item is a complaint (High priority, human verifies)
  //    even when the model filed it under return_refund because the customer asked for money back.
  const itemProblem = ['damaged', 'leaking', 'wrong_item', 'missing_item'].indexOf(c.issue_type) !== -1;
  const intent = (llmIntent === 'return_refund' && itemProblem) ? 'complaint' : llmIntent;
  const reroutedAsComplaint = intent !== llmIntent;

  const orderIntents = ['order_status', 'return_refund', 'complaint'];
  const isOrderIntent = orderIntents.indexOf(intent) !== -1;
  const privacyBlock = !!(lookup.found && lookup.authorized === false);
  const reasons = [];

  if (c.fallback_used) reasons.push('classification_fallback');
  if (typeof c.confidence !== 'number' || c.confidence < threshold) reasons.push('low_confidence');
  if (isOrderIntent && !lookup.found) reasons.push('order_not_found');
  if (privacyBlock) reasons.push('sender_not_owner');
  if (c.sentiment === 'angry') reasons.push('angry_customer');
  if (flags.indexOf('medical') !== -1) reasons.push('medical');
  if (flags.indexOf('threat_public') !== -1) reasons.push('public_threat');
  if (flags.indexOf('embedded_instructions') !== -1) reasons.push('embedded_instructions');
  if (intent === 'return_refund' && facts.has_order && facts.return_eligibility !== 'ELIGIBLE') reasons.push('refund_declined');
  if (intent === 'complaint') reasons.push('complaint_needs_verification');
  if (intent === 'order_status' && facts.order_cancelled) reasons.push('order_cancelled');
  if (intent === 'other' && (c.other_category === 'business_request' || c.other_category === 'unclear')) reasons.push('out_of_scope_request');

  const ticketNeeded = intent === 'return_refund' || intent === 'complaint';
  // Priority is fixed by intent (README: complaints are High). Never taken from the email.
  const priority = intent === 'complaint' ? 'High' : (intent === 'return_refund' ? 'Medium' : null);

  const languageNames = { en: 'English', hi: 'Hindi (Devanagari script)', hinglish: 'Hinglish (Hindi written in Latin script, mixed with English)' };

  // What the agent is told. Verdicts only: no order fields, no policy text.
  // It must call get_order / search_faq to get anything it wants to state.
  const brief = [];
  brief.push('intent: ' + intent + (c.secondary_intent ? ' (also: ' + c.secondary_intent + ')' : ''));
  brief.push('reply_language: ' + (languageNames[c.language] || 'English'));
  brief.push('customer_first_name: ' + (email.from_first_name || 'unknown'));
  if (privacyBlock) {
    brief.push('order_lookup: NOT_AUTHORISED. The sender is not the customer on this order. Do not share or confirm any order detail (status, dates, tracking, address, items, amounts). Ask that the customer who placed the order writes from the email address used for the order.');
  } else if (lookup.found) {
    brief.push('order_lookup: FOUND for order ' + lookup.order_id + (lookup.match_method === 'sender_email' ? ' (matched by the sender email; the customer gave no order ID)' : '') + '. Call get_order with this ID for the details.');
    if (facts.order_cancelled) brief.push('order_state: CANCELLED. The customer may not know. Explain using only what get_order returns.');
    if (facts.days_since_delivery !== null && facts.days_since_delivery !== undefined) brief.push('days_since_delivery: ' + facts.days_since_delivery);
  } else if (isOrderIntent) {
    brief.push('order_lookup: NOT_FOUND. ' + (lookup.reason || '') + ' Do not state any order status. Ask the customer to check the order ID and the email address used for the order.');
  } else {
    brief.push('order_lookup: NOT_APPLICABLE');
  }
  if (intent === 'return_refund' && facts.has_order) {
    brief.push('return_eligibility: ' + facts.return_eligibility + '. ' + (facts.return_reason || '') + ' This verdict is final.');
    if (facts.return_eligibility === 'ELIGIBLE' && facts.refundable_amount !== null) {
      brief.push('refundable_amount_inr: ' + facts.refundable_amount + ' (item value; shipping and COD fees are not refundable on ordinary returns). Payment method: ' + facts.payment_method + '.');
    } else {
      brief.push('Do not promise or approve a refund. Explain the policy kindly and say a team member will review.');
    }
  }
  if (intent === 'complaint') {
    brief.push('issue_type: ' + (facts.issue_type || 'none'));
    brief.push('photos_attached: ' + (facts.has_attachments ? 'yes (' + facts.attachment_count + ')' : 'no'));
    if (facts.damage_window_ok !== null && facts.damage_window_ok !== undefined) brief.push('reported_within_policy_window: ' + (facts.damage_window_ok ? 'yes' : 'no'));
    brief.push('A team member must verify before any refund or replacement. Do not say either is approved.');
  }
  if (flags.indexOf('medical') !== -1) brief.push('The email raises a medical or skin-condition question. Give no medical advice and make no cure or treatment claim.');

  return {
    route: intent,
    llm_intent: llmIntent,
    rerouted_as_complaint: reroutedAsComplaint,
    risk_flags: flags,
    draft_needed: intent !== 'other',
    ticket_needed: ticketNeeded,
    priority: priority,
    needs_human: reasons.length > 0,
    needs_human_reasons: reasons,
    privacy_block: privacyBlock,
    agent_brief: brief.join('\n'),
  };
}
// --- END PURE ---

if (typeof module !== 'undefined') module.exports = { decideRoute };
