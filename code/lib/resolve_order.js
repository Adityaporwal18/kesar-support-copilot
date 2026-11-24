// Guarded order lookup. This is the logic behind the `get_order` tool and the
// workflow's own lookup step. It returns at most ONE order, and only to the
// customer who placed it. Pure: no I/O, no clock.

// --- BEGIN PURE ---
function trimOrder(o) {
  return {
    order_id: o.order_id,
    customer_first_name: String(o.customer_name || '').split(/\s+/)[0] || '',
    order_date: o.order_date,
    items: (o.items || []).map(function (i) { return { name: i.name, qty: i.qty, unit_price: i.unit_price }; }),
    subtotal: o.subtotal,
    shipping_fee: o.shipping_fee,
    cod_fee: o.cod_fee,
    total: o.total,
    payment_method: o.payment_method,
    status: o.status,
    courier: o.courier,
    tracking_url: o.tracking_url,
    shipped_date: o.shipped_date,
    estimated_delivery: o.estimated_delivery,
    delivered_date: o.delivered_date,
    cancelled_date: o.cancelled_date,
    cancellation_reason: o.cancellation_reason,
    refund_status: o.refund_status,
    shipping_address: o.shipping_address,
  };
}

// Values the reply must never contain when the sender is not the owner.
// Only returned when include_withheld is true (the workflow's own call).
// The agent's tool call never sets it, so the model cannot see these.
function withheldValues(o) {
  const a = o.shipping_address || {};
  const vals = [o.tracking_url, o.courier, a.line1, a.city, a.pincode, o.shipped_date, o.estimated_delivery, o.delivered_date];
  if (o.tracking_url) vals.push(String(o.tracking_url).split('/').pop());
  return vals.filter(function (v) { return v !== null && v !== undefined && String(v) !== ''; }).map(String);
}

function resolveOrder(input) {
  const orders = (input && input.orders) || [];
  const requester = String((input && input.requester_email) || '').trim().toLowerCase();
  const rawId = input && input.order_id ? String(input.order_id).trim().toUpperCase() : '';
  const allowEmail = !(input && input.allow_email_fallback === false);
  const includeWithheld = !!(input && input.include_withheld);

  const base = { found: false, authorized: false, match_method: 'none', order_id: rawId || null, order: null, reason: '' };

  if (rawId) {
    const hit = orders.filter(function (o) { return String(o.order_id).toUpperCase() === rawId; })[0];
    if (!hit) {
      // Never substitute another order for an ID the customer wrote.
      base.reason = 'No order exists with ID ' + rawId + '.';
      return base;
    }
    const owner = String(hit.customer_email || '').trim().toLowerCase();
    if (owner !== requester) {
      const out = { found: true, authorized: false, match_method: 'order_id', order_id: rawId, order: null, reason: 'The requester is not the customer on this order. Share and confirm no order detail.' };
      if (includeWithheld) out.withheld = withheldValues(hit);
      return out;
    }
    return { found: true, authorized: true, match_method: 'order_id', order_id: rawId, order: trimOrder(hit), reason: '' };
  }

  if (!allowEmail || !requester) {
    base.reason = 'No order ID was given.';
    return base;
  }

  const mine = orders.filter(function (o) { return String(o.customer_email || '').trim().toLowerCase() === requester; });
  if (mine.length === 1) {
    return { found: true, authorized: true, match_method: 'sender_email', order_id: mine[0].order_id, order: trimOrder(mine[0]), reason: '' };
  }
  if (mine.length > 1) {
    base.reason = 'Multiple orders exist for this email (' + mine.map(function (o) { return o.order_id; }).join(', ') + '). Ask which order.';
    return base;
  }
  base.reason = 'No order ID was given and no order exists for the sender email.';
  return base;
}
// --- END PURE ---

if (typeof module !== 'undefined') module.exports = { resolveOrder, trimOrder };
