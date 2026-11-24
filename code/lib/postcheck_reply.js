// Safety checks on the agent's draft before it is stored. A model can be
// talked out of a rule; these checks cannot. Critical failures replace the
// draft with a neutral holding reply and flag the email for a human.
// Pure: no I/O, no clock.

// --- BEGIN PURE ---
const PC_SIGNOFF = 'Warm regards,\nTeam Kesar';
const PC_CAPS_ALLOW = ['COD', 'UPI', 'IFSC', 'FAQ', 'INR', 'OTP', 'PIN', 'CVV', 'GST', 'KC'];

function holdingReply(firstName) {
  return 'Hi ' + (firstName || 'there') + ',\n\nThank you for writing to us. A member of our team is looking into this and will follow up within 24 business hours.\n\n' + PC_SIGNOFF;
}

// Agent output format: line 1 "STATUS: OK" or "STATUS: ESCALATE - <reason>",
// line 2 "FAQ: <section numbers or NONE>", then the reply.
function parseAgentOutput(text) {
  const raw = String(text == null ? '' : text).replace(/\r/g, '').trim();
  const lines = raw.split('\n');
  const statusMatch = /^\s*STATUS:\s*(OK|ESCALATE)\b\s*(?:[-:]\s*(.*))?$/i.exec(lines[0] || '');
  if (!statusMatch) {
    return { status: 'OK', escalate: false, escalate_reason: '', faq_sections: [], reply: raw, format_error: true };
  }
  let idx = 1;
  let faq = [];
  const faqMatch = /^\s*FAQ:\s*(.*)$/i.exec(lines[idx] || '');
  if (faqMatch) {
    faq = (faqMatch[1].match(/\d+/g) || []).map(Number);
    idx += 1;
  }
  const escalate = statusMatch[1].toUpperCase() === 'ESCALATE';
  return {
    status: escalate ? 'ESCALATE' : 'OK',
    escalate: escalate,
    escalate_reason: (statusMatch[2] || '').trim(),
    faq_sections: faq,
    reply: lines.slice(idx).join('\n').trim(),
    format_error: false,
  };
}

function pcAmounts(text) {
  const out = [];
  const re = /(?:₹|Rs\.?|INR)\s?([\d,]+(?:\.\d+)?)/gi;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const n = Number(m[1].replace(/,/g, ''));
    if (!isNaN(n)) out.push(n);
  }
  return out;
}

function pcDateForms(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return [];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = String(Number(m[3]));
  const mon = months[Number(m[2]) - 1];
  return [iso, d + ' ' + mon, mon + ' ' + d, d + 'th ' + mon, d + 'st ' + mon, d + 'nd ' + mon, d + 'rd ' + mon];
}

function postcheckReply(input) {
  const lookup = (input && input.lookup) || {};
  const facts = (input && input.facts) || {};
  const route = (input && input.route) || {};
  const firstName = (input && input.first_name) || '';
  const toolsCalled = (input && input.tools_called) || [];
  let draft = String((input && input.draft) || '').trim();
  const lower = draft.toLowerCase();
  const order = lookup.found && lookup.authorized && lookup.order ? lookup.order : null;
  const critical = [];
  const soft = [];

  // 1. privacy_leak: sender is not the owner, yet the draft contains order details.
  if (route.privacy_block) {
    const withheld = Array.isArray(lookup.withheld) ? lookup.withheld : [];
    let leaked = /track\.example\.com/i.test(draft);
    for (let i = 0; i < withheld.length && !leaked; i++) {
      const forms = /^\d{4}-\d{2}-\d{2}$/.test(withheld[i]) ? pcDateForms(withheld[i]) : [withheld[i]];
      for (let j = 0; j < forms.length; j++) {
        if (forms[j] && lower.indexOf(String(forms[j]).toLowerCase()) !== -1) { leaked = true; break; }
      }
    }
    if (leaked) critical.push('privacy_leak');
  }

  // 2. invented_url: only the authorised order's tracking link or our own domain may appear.
  const urls = draft.match(/(?:https?:\/\/|www\.|track\.example\.com)[^\s)>\]"']*/gi) || [];
  const allowedTracking = order && order.tracking_url ? String(order.tracking_url).replace(/^https?:\/\//i, '').toLowerCase() : null;
  for (let i = 0; i < urls.length; i++) {
    const u = urls[i].replace(/[.,;:!?]+$/, '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').toLowerCase();
    const host = u.split('/')[0];
    const ok = (allowedTracking && u === allowedTracking) || /(^|\.)kesarandco\.example$/.test(host);
    if (!ok) { critical.push('invented_url'); break; }
  }

  // 3. unbacked_amount: every rupee amount must exist in the order or the FAQ.
  const allowed = pcAmounts(input && input.faqText);
  if (order) {
    [order.subtotal, order.shipping_fee, order.cod_fee, order.total].forEach(function (n) { if (typeof n === 'number') allowed.push(n); });
    (order.items || []).forEach(function (it) { if (typeof it.unit_price === 'number') { allowed.push(it.unit_price); allowed.push(it.unit_price * (it.qty || 1)); } });
    pcAmounts(order.refund_status).forEach(function (n) { allowed.push(n); });
  }
  if (typeof facts.refundable_amount === 'number') allowed.push(facts.refundable_amount);
  const stated = pcAmounts(draft);
  for (let i = 0; i < stated.length; i++) {
    if (allowed.indexOf(stated[i]) === -1) { critical.push('unbacked_amount'); break; }
  }

  // 4. medical_claim: cure/treat words without a negation in the same sentence.
  const sentences = draft.split(/[.!?\n।]+/);
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (/\b(cure[sd]?|curing|heal(s|ed|ing)?|treat(s|ed|ing|ment)?|remed(y|ies))\b/i.test(s) &&
        !/\b(not|cannot|can't|can not|won't|don't|doesn't|isn't|aren't|never|no|unable|neither|nor)\b/i.test(s)) {
      critical.push('medical_claim');
      break;
    }
  }

  // 5. refund_promise: completed-state claims about a refund or replacement.
  const promise = /\b(refund|replacement)\b[^.!?\n]{0,60}\b(has been|have been|is|was|are)\s+(now\s+)?(approved|processed|credited|initiated|issued|confirmed)\b/i.test(draft) ||
                  /\b(approved|processed|initiated|issued|confirmed)\s+(your|the|a)\s+(full\s+)?(refund|replacement)\b/i.test(draft);
  const backedByOrder = !!(order && order.refund_status);
  const ineligible = typeof facts.return_eligibility === 'string' && facts.return_eligibility.indexOf('INELIGIBLE') === 0;
  if ((promise && !backedByOrder) || (ineligible && /\bapproved\b/i.test(draft))) critical.push('refund_promise');

  // Soft checks (noted, never block).
  if (draft.replace(/\s+/g, ' ').indexOf(PC_SIGNOFF.replace(/\s+/g, ' ')) === -1) {
    draft = draft.replace(/\s+$/, '') + '\n\n' + PC_SIGNOFF;
    soft.push('signoff_appended');
  }
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(draft)) soft.push('emoji');
  const caps = (draft.match(/\b[A-Z]{4,}\b/g) || []).filter(function (w) { return PC_CAPS_ALLOW.indexOf(w) === -1; });
  if (caps.length > 0) soft.push('all_caps');
  if ((draft.match(/!/g) || []).length > 1) soft.push('exclamations');
  const body = draft.replace(PC_SIGNOFF, '');
  if (body.split(/[.!?।]+\s/).filter(function (x) { return x.trim().length > 0; }).length > 8) soft.push('long_reply');
  if (route.route === 'order_status' && order && toolsCalled.indexOf('get_order') === -1) soft.push('no_get_order_call');

  if (critical.length > 0) {
    return { reply_draft: holdingReply(firstName), critical: critical, soft: soft, replaced: true };
  }
  return { reply_draft: draft, critical: critical, soft: soft, replaced: false };
}
// --- END PURE ---

if (typeof module !== 'undefined') module.exports = { parseAgentOutput, postcheckReply, holdingReply };
