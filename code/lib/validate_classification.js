// Validates the classifier's raw text against the required schema
// (assignment/schemas/llm_output.schema.json), fixes trivial problems in code,
// and builds the deterministic fallback. Pure: no I/O, no clock.

// --- BEGIN PURE ---
const VC_INTENTS = ['order_status', 'product_query', 'return_refund', 'complaint', 'other'];
const VC_SENTIMENTS = ['positive', 'neutral', 'negative', 'angry'];
const VC_LANGUAGES = ['en', 'hi', 'hinglish'];
const VC_CONDITIONS = ['unopened', 'opened_or_used', 'unknown'];
const VC_ISSUES = ['damaged', 'leaking', 'wrong_item', 'missing_item', 'none'];
const VC_OTHER = ['spam', 'partnership', 'feedback', 'business_request', 'unclear'];
const VC_RISKS = ['medical', 'threat_public', 'embedded_instructions', 'abusive'];

// Pull the first {...} block out of the model's text (handles code fences and chatter).
function extractJsonObject(rawText) {
  const s = String(rawText == null ? '' : rawText);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(s.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

// Strict check of the seven required fields. Returns a list of error strings.
function strictErrors(c) {
  const errors = [];
  if (!c || typeof c !== 'object') return ['not_an_object'];
  if (VC_INTENTS.indexOf(c.intent) === -1) errors.push('intent: not one of ' + VC_INTENTS.join('|'));
  if (!('secondary_intent' in c)) errors.push('secondary_intent: missing');
  else if (c.secondary_intent !== null && VC_INTENTS.indexOf(c.secondary_intent) === -1) errors.push('secondary_intent: not an intent or null');
  if (!('order_id' in c)) errors.push('order_id: missing');
  else if (c.order_id !== null && !(typeof c.order_id === 'string' && /^KC-[0-9]{4}$/.test(c.order_id))) errors.push('order_id: must match KC-#### or be null');
  if (VC_SENTIMENTS.indexOf(c.sentiment) === -1) errors.push('sentiment: not one of ' + VC_SENTIMENTS.join('|'));
  if (VC_LANGUAGES.indexOf(c.language) === -1) errors.push('language: not one of ' + VC_LANGUAGES.join('|'));
  if (typeof c.confidence !== 'number' || !(c.confidence >= 0 && c.confidence <= 1)) errors.push('confidence: must be a number from 0 to 1');
  if (typeof c.summary !== 'string' || c.summary.length === 0) errors.push('summary: must be a non-empty string');
  else if (c.summary.length > 200) errors.push('summary: longer than 200 characters');
  return errors;
}

// Fixes that need no model call: long summary, numeric-string confidence, lower-case order id.
function applyCodeFixes(obj) {
  const c = Object.assign({}, obj);
  const notes = [];
  if (typeof c.summary === 'string' && c.summary.length > 200) {
    c.summary = c.summary.slice(0, 197) + '...';
    notes.push('summary_truncated');
  }
  if (typeof c.confidence === 'string' && c.confidence.trim() !== '' && !isNaN(Number(c.confidence))) {
    c.confidence = Number(c.confidence);
    notes.push('confidence_coerced');
  }
  if (typeof c.order_id === 'string' && /^kc-[0-9]{4}$/i.test(c.order_id) && c.order_id !== c.order_id.toUpperCase()) {
    c.order_id = c.order_id.toUpperCase();
    notes.push('order_id_uppercased');
  }
  return { classification: c, notes: notes };
}

// Optional extra fields get safe defaults so later code never sees undefined.
function withOptionalDefaults(c) {
  const out = Object.assign({}, c);
  if (VC_CONDITIONS.indexOf(out.product_condition) === -1) out.product_condition = 'unknown';
  if (VC_ISSUES.indexOf(out.issue_type) === -1) out.issue_type = 'none';
  if (VC_OTHER.indexOf(out.other_category) === -1) out.other_category = 'unclear';
  out.risk_flags = Array.isArray(out.risk_flags) ? out.risk_flags.filter(function (f) { return VC_RISKS.indexOf(f) !== -1; }) : [];
  if (typeof out.needs_reply !== 'boolean') out.needs_reply = true;
  return out;
}

function fallbackClassification() {
  return withOptionalDefaults({
    intent: 'other',
    secondary_intent: null,
    order_id: null,
    sentiment: 'neutral',
    language: 'en',
    confidence: 0,
    summary: 'Classification failed; needs human review.',
    fallback_used: true,
  });
}

// rawText = the model's reply; emailText = subject + body (to confirm the order id is real).
function validateClassification(rawText, emailText) {
  const notes = [];
  const obj = extractJsonObject(rawText);
  if (!obj) {
    return { valid_strict: false, errors: ['not_json: no parseable JSON object in the output'], classification: null, code_fixable: false, notes: notes };
  }

  const errors = strictErrors(obj);
  const validStrict = errors.length === 0;
  let c = obj;
  let codeFixable = false;

  if (!validStrict) {
    const fixed = applyCodeFixes(obj);
    if (strictErrors(fixed.classification).length === 0) {
      codeFixable = true;
      c = fixed.classification;
      for (let i = 0; i < fixed.notes.length; i++) notes.push(fixed.notes[i]);
    } else {
      return { valid_strict: false, errors: errors, classification: null, code_fixable: false, notes: notes };
    }
  }

  c = withOptionalDefaults(c);

  // Semantic normalisation. These do not change valid_strict.
  if (c.secondary_intent !== null && c.secondary_intent === c.intent) {
    c.secondary_intent = null;
    notes.push('secondary_intent_same_as_intent_nulled');
  }
  // Language backstop (v2): by the schema, "hi" means Devanagari script. The script is a fact
  // we can check, so the model's label is corrected when it contradicts the text.
  const letters = String(emailText || '').replace(/[^A-Za-z\u0900-\u097F]/g, '');
  const devanagari = letters.replace(/[^\u0900-\u097F]/g, '').length;
  if (letters.length > 0) {
    if (c.language === 'hi' && devanagari === 0) { c.language = 'hinglish'; notes.push('language_corrected_no_devanagari'); }
    else if (c.language !== 'hi' && devanagari / letters.length > 0.5) { c.language = 'hi'; notes.push('language_corrected_devanagari'); }
  }
  if (c.order_id !== null) {
    const hay = String(emailText || '').toUpperCase();
    if (hay.indexOf(c.order_id.toUpperCase()) === -1) {
      c.order_id = null; // the model produced an ID the customer never wrote: never guess
      notes.push('order_id_dropped_not_in_email');
    }
  }

  return { valid_strict: validStrict, errors: errors, classification: c, code_fixable: codeFixable, notes: notes };
}
// --- END PURE ---

if (typeof module !== 'undefined') module.exports = { validateClassification, applyCodeFixes, fallbackClassification, strictErrors, extractJsonObject };
