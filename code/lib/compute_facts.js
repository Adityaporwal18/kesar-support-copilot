// Date maths and policy verdicts, computed in code so the LLM never does
// arithmetic or decides eligibility. Dates come from the email's received_at,
// never from the clock. Pure: no I/O, no clock.

// --- BEGIN PURE ---
// "2026-11-20..." -> whole days since 1970 (UTC). Timezone-proof: only the date part is used.
function dayNumber(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s == null ? '' : s));
  if (!m) return null;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
}

function computeFacts(input) {
  const email = (input && input.email) || {};
  const c = (input && input.classification) || {};
  const lookup = (input && input.lookup) || {};
  const cfg = (input && input.config) || {};
  const returnWindow = typeof cfg.RETURN_WINDOW_DAYS === 'number' ? cfg.RETURN_WINDOW_DAYS : 7;
  const damageWindow = typeof cfg.DAMAGE_WINDOW_DAYS === 'number' ? cfg.DAMAGE_WINDOW_DAYS : 2;

  const order = lookup.found && lookup.authorized && lookup.order ? lookup.order : null;
  const attachments = Array.isArray(email.attachments) ? email.attachments : [];

  const facts = {
    has_order: !!order,
    order_status: order ? order.status : null,
    payment_method: order ? order.payment_method : null,
    delivered: !!(order && order.delivered_date),
    days_since_delivery: null,
    order_cancelled: !!(order && order.status === 'cancelled'),
    has_attachments: attachments.length > 0,
    attachment_count: attachments.length,
    product_condition: c.product_condition || 'unknown',
    issue_type: c.issue_type || 'none',
    return_eligibility: 'NO_ORDER',
    return_reason: '',
    refundable_amount: null,
    damage_window_ok: null,
  };

  if (!order) return facts;

  if (order.delivered_date) {
    const received = dayNumber(email.received_at);
    const delivered = dayNumber(order.delivered_date);
    if (received !== null && delivered !== null) facts.days_since_delivery = received - delivered;
  }

  // Return eligibility (FAQ section 4): within 7 days of delivery AND unused/unopened.
  if (!order.delivered_date || facts.days_since_delivery === null) {
    facts.return_eligibility = 'NOT_DELIVERED';
    facts.return_reason = 'The order has not been delivered, so the returns policy does not apply yet.';
  } else {
    const late = facts.days_since_delivery > returnWindow;
    const used = facts.product_condition === 'opened_or_used';
    if (late && used) {
      facts.return_eligibility = 'INELIGIBLE_BOTH';
      facts.return_reason = facts.days_since_delivery + ' days since delivery (limit ' + returnWindow + ') and the product has been opened or used.';
    } else if (late) {
      facts.return_eligibility = 'INELIGIBLE_WINDOW';
      facts.return_reason = facts.days_since_delivery + ' days since delivery (limit ' + returnWindow + ').';
    } else if (used) {
      facts.return_eligibility = 'INELIGIBLE_USED';
      facts.return_reason = 'The product has been opened or used; only unused, unopened, sealed items can be returned.';
    } else if (facts.product_condition === 'unknown') {
      facts.return_eligibility = 'UNKNOWN_CONDITION';
      facts.return_reason = 'Within ' + returnWindow + ' days, but the email does not say whether the product is unopened.';
    } else {
      facts.return_eligibility = 'ELIGIBLE';
      facts.return_reason = facts.days_since_delivery + ' days since delivery and the product is unopened.';
      // FAQ section 6: shipping and COD fees are non-refundable on ordinary returns.
      facts.refundable_amount = order.subtotal;
    }
    // FAQ section 5 says "within 48 hours of delivery". delivered_date has no time,
    // so 2 calendar days stands in for 48 hours (stated in the README).
    facts.damage_window_ok = facts.days_since_delivery <= damageWindow;
  }

  return facts;
}
// --- END PURE ---

if (typeof module !== 'undefined') module.exports = { computeFacts, dayNumber };
