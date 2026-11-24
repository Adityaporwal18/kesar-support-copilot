// Section-level search over faq.md: the logic behind the `search_faq` tool.
// The FAQ is ~80 lines, so splitting by heading and returning the matching
// section verbatim is more reliable than a vector store. Pure: no I/O.

// --- BEGIN PURE ---
const SF_STOPWORDS = ['the', 'a', 'an', 'is', 'are', 'was', 'be', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'my', 'me', 'i', 'it', 'its',
  'this', 'that', 'with', 'can', 'do', 'does', 'how', 'what', 'when', 'will', 'your', 'you', 'we', 'our', 'product', 'products',
  'order', 'orders', 'item', 'please', 'kesar', 'about', 'if', 'from', 'at', 'by', 'as', 'have', 'has', 'get', 'any', 'policy'];

// Query word -> extra words to look for in the FAQ text.
const SF_SYNONYMS = {
  cod: ['cash', 'cod'], cash: ['cod'],
  shipping: ['delivery', 'dispatch'], ship: ['delivery', 'dispatch', 'shipping'], deliver: ['delivery'],
  northeast: ['north'], guwahati: ['north'], assam: ['north'],
  broken: ['damaged'], cracked: ['damaged'], damage: ['damaged'], leak: ['leaking'], leaked: ['leaking'], spilled: ['leaking', 'damaged'],
  wrong: ['wrong'], incorrect: ['wrong'], missing: ['missing'],
  money: ['refund'], refunds: ['refund'], returns: ['return'], exchange: ['return', 'replacement'],
  cancel: ['cancellation', 'cancelled'], cancelled: ['cancellation'],
  heal: ['cure'], treat: ['cure', 'treat'], medical: ['medical', 'doctor'], allergy: ['allergies'], allergic: ['allergies'], rash: ['reaction'],
  influencer: ['influencers', 'partnership'], collab: ['partnership'], collaboration: ['partnership'], wholesale: ['wholesale', 'partnership'],
  hours: ['hours'], contact: ['contact', 'email'],
};

function sfStem(w) {
  return w.length > 3 && w.charAt(w.length - 1) === 's' ? w.slice(0, -1) : w;
}

function sfTokens(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w.length >= 2 && SF_STOPWORDS.indexOf(w) === -1; });
}

function splitFaqSections(faqMarkdown) {
  const lines = String(faqMarkdown || '').split(/\r?\n/);
  const sections = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^## (\d+)\.\s+(.*)$/.exec(lines[i]);
    if (m) {
      current = { section: Number(m[1]), title: m[2].trim(), lines: [lines[i]] };
      sections.push(current);
    } else if (current) {
      current.lines.push(lines[i]);
    }
  }
  return sections.map(function (s) { return { section: s.section, title: s.title, text: s.lines.join('\n').trim() }; });
}

function searchFaq(faqMarkdown, query) {
  const none = { matches: [], note: 'No FAQ section covers this. Do not answer; escalate.' };
  const base = sfTokens(query);
  if (base.length === 0) return none;

  // Expand the query with synonyms, then stem.
  const words = [];
  for (let i = 0; i < base.length; i++) {
    const extra = [base[i]].concat(SF_SYNONYMS[base[i]] || []);
    for (let j = 0; j < extra.length; j++) {
      const st = sfStem(extra[j]);
      if (words.indexOf(st) === -1) words.push(st);
    }
  }

  const scored = splitFaqSections(faqMarkdown).map(function (s) {
    const titleWords = sfTokens(s.title).map(sfStem);
    const bodyWords = sfTokens(s.text).map(sfStem);
    let score = 0;
    for (let i = 0; i < words.length; i++) {
      if (titleWords.indexOf(words[i]) !== -1) score += 3;        // a heading match is strong evidence
      else if (bodyWords.indexOf(words[i]) !== -1) score += 1;
    }
    return { section: s.section, title: s.title, text: s.text, score: score };
  }).filter(function (s) { return s.score > 0; });

  if (scored.length === 0) return none;
  scored.sort(function (a, b) { return b.score - a.score || a.section - b.section; });
  return { matches: scored.slice(0, 2).map(function (s) { return { section: s.section, title: s.title, text: s.text }; }) };
}
// --- END PURE ---

if (typeof module !== 'undefined') module.exports = { searchFaq, splitFaqSections };
