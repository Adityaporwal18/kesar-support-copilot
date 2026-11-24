// Generates the n8n workflow JSON files from the single sources of truth:
//   code/lib/*.js  (rule code, unit-tested offline)   prompts/*.md  (LLM prompts)
// Usage: node build/build_workflow.mjs --env practice|main --prompt-version v1|v2 --out build/out
// Reads build/out/context.json (credential ids, sub-workflow ids, sheet ids, models) written by tools/deploy.py.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : def; };
const ENV = arg('env');
const PV = arg('prompt-version', 'v1');
const OUT = path.join(ROOT, arg('out', 'build/out'));
if (!['practice', 'main'].includes(ENV)) { console.error('--env must be practice or main'); process.exit(2); }
if (!['v1', 'v2'].includes(PV)) { console.error('--prompt-version must be v1 or v2'); process.exit(2); }

const ctx = JSON.parse(fs.readFileSync(path.join(OUT, 'context.json'), 'utf8'));
const RAW = 'https://raw.githubusercontent.com/abhishek-patel-cadient/kesar-ai-copilot-assignment/refs/heads/main/data/';
const SUFFIX = ENV === 'practice' ? ' (practice)' : '';
const WEBHOOK_PATH = ENV === 'practice' ? 'kesar-support-practice' : 'kesar-support';
const SHEET_ID = ctx.sheets[ENV];

// ---------- helpers ----------
const pure = (file) => {
  const src = fs.readFileSync(path.join(ROOT, 'code', 'lib', file), 'utf8');
  const m = /\/\/ --- BEGIN PURE ---\n([\s\S]*?)\/\/ --- END PURE ---/.exec(src);
  if (!m) throw new Error('No PURE region in ' + file);
  return `// ---- from code/lib/${file} (unit-tested in code/test) ----\n` + m[1].trim() + '\n';
};
const prompt = (file) => fs.readFileSync(path.join(ROOT, 'prompts', file), 'utf8').trim();
const uid = (s) => { const h = crypto.createHash('sha1').update(s).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const cred = (type) => ({ [type]: { id: ctx.credentials[type].id, name: ctx.credentials[type].name } });

function builder(workflowName) {
  const nodes = []; const connections = {};
  let x = 0;
  const add = (name, type, typeVersion, parameters, extra = {}, pos) => {
    const position = pos || [x += 240, 300];
    nodes.push({ parameters, type, typeVersion, position, id: uid(workflowName + '|' + name), name, ...extra });
    return name;
  };
  const link = (from, to, outIndex = 0, kind = 'main', inIndex = 0) => {
    connections[from] = connections[from] || {};
    connections[from][kind] = connections[from][kind] || [];
    while (connections[from][kind].length <= outIndex) connections[from][kind].push([]);
    connections[from][kind][outIndex].push({ node: to, type: kind, index: inIndex });
  };
  const chain = (...names) => { for (let i = 0; i < names.length - 1; i++) link(names[i], names[i + 1]); };
  const done = () => ({ name: workflowName, nodes, connections, settings: { executionOrder: 'v1' } });
  return { add, link, chain, done, at: (v) => { x = v; } };
}
const codeNode = (b, name, js, extra, pos) => b.add(name, 'n8n-nodes-base.code', 2, { jsCode: js }, extra, pos);
const ifNode = (b, name, expr, pos) => b.add(name, 'n8n-nodes-base.if', 2.2, {
  conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{ id: uid(name), leftValue: expr, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' },
  looseTypeValidation: true, options: {} }, {}, pos);
const httpText = (b, name, urlExpr, pos) => b.add(name, 'n8n-nodes-base.httpRequest', 4.2,
  { url: urlExpr, options: { response: { response: { responseFormat: 'text' } } } }, { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 }, pos);
const sheet = (tab) => ({ documentId: { __rl: true, value: '={{ $(\'Config\').first().json.SHEET_ID }}', mode: 'id' }, sheetName: { __rl: true, value: tab, mode: 'name' } });
const sheetsNode = (b, name, params, extra, pos) => b.add(name, 'n8n-nodes-base.googleSheets', 4.5,
  { authentication: 'serviceAccount', resource: 'sheet', ...params }, { credentials: cred('googleApi'), ...extra }, pos);
const upsert = (tab, matchCol) => ({ operation: 'appendOrUpdate', ...sheet(tab),
  columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [matchCol], schema: [] }, options: { cellFormat: 'RAW' } });
const groqModel = (b, name, model, temperature, pos) => b.add(name, '@n8n/n8n-nodes-langchain.lmChatGroq', 1,
  { model, options: { temperature, maxTokensToSample: 900 } }, { credentials: cred('groqApi') }, pos);
const geminiModel = (b, name, model, temperature, pos) => b.add(name, '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', 1,
  { modelName: model.startsWith('models/') ? model : 'models/' + model, options: { temperature } }, { credentials: cred('googlePalmApi') }, pos);
const chatModel = (b, name, spec, temperature, pos) => (spec.provider === 'groq' ? groqModel : geminiModel)(b, name, spec.model, temperature, pos);
const triggerInputs = (b, names) => b.add('When Called', 'n8n-nodes-base.executeWorkflowTrigger', 1.1,
  { inputSource: 'workflowInputs', workflowInputs: { values: names.map((n) => ({ name: n, type: 'string' })) } });

// ---------- sub-workflow: get_order ----------
function buildGetOrder() {
  const b = builder('Kesar tool: get_order');
  triggerInputs(b, ['order_id', 'requester_email']);
  httpText(b, 'HTTP: Orders', RAW + 'orders.json');
  codeNode(b, 'Lookup', pure('resolve_order.js') + `
// The tool returns at most one order, and only to the customer who placed it.
const args = $('When Called').first().json;
const raw = $('HTTP: Orders').first().json.data;
const orders = (typeof raw === 'string' ? JSON.parse(raw) : raw).orders;
const id = args.order_id && String(args.order_id).trim() && String(args.order_id).toLowerCase() !== 'null' ? args.order_id : null;
return [{ json: resolveOrder({ orders, order_id: id, requester_email: args.requester_email, allow_email_fallback: true, include_withheld: false }) }];`);
  b.chain('When Called', 'HTTP: Orders', 'Lookup');
  return b.done();
}

// ---------- sub-workflow: search_faq ----------
function buildSearchFaq() {
  const b = builder('Kesar tool: search_faq');
  triggerInputs(b, ['query']);
  httpText(b, 'HTTP: FAQ', RAW + 'faq.md');
  codeNode(b, 'Search', pure('search_faq.js') + `
// Returns the matching FAQ section(s) verbatim, or an explicit "not covered" note.
const q = $('When Called').first().json.query;
return [{ json: searchFaq(String($('HTTP: FAQ').first().json.data || ''), q) }];`);
  b.chain('When Called', 'HTTP: FAQ', 'Search');
  return b.done();
}

// ---------- admin: reset sheet (clears data rows, keeps headers) ----------
function buildAdmin() {
  const b = builder('Kesar admin: reset sheet');
  b.add('Webhook: Reset', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: 'kesar-admin-reset', responseMode: 'responseNode', options: {} }, { webhookId: uid('admin-reset') });
  codeNode(b, 'Config', `
// Safety check: only runs with an explicit confirm word and a known environment.
const body = $('Webhook: Reset').first().json.body || {};
const sheets = ${JSON.stringify(ctx.sheets)};
const ok = body.confirm === 'RESET' && Object.prototype.hasOwnProperty.call(sheets, body.env);
return [{ json: { ok, env: body.env || null, SHEET_ID: ok ? sheets[body.env] : null } }];`);
  ifNode(b, 'IF: Confirmed', '={{ $json.ok }}');
  sheetsNode(b, 'Sheets: Clear Audit Log', { operation: 'clear', ...sheet('Audit Log'), clear: 'wholeSheet', keepFirstRow: true }, { alwaysOutputData: true });
  sheetsNode(b, 'Sheets: Clear Tickets', { operation: 'clear', ...sheet('Tickets'), clear: 'wholeSheet', keepFirstRow: true }, { alwaysOutputData: true });
  b.add('Respond: Done', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'json', responseBody: '={{ JSON.stringify({ ok: true, env: $(\'Config\').first().json.env, cleared: [\'Audit Log\', \'Tickets\'] }) }}', options: {} });
  b.add('Respond: Refused', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'json', responseBody: '={{ JSON.stringify({ ok: false, error: \'Send {"env":"practice|main","confirm":"RESET"}\' }) }}', options: { responseCode: 400 } }, {}, [960, 520]);
  b.chain('Webhook: Reset', 'Config', 'IF: Confirmed');
  b.link('IF: Confirmed', 'Sheets: Clear Audit Log', 0);
  b.link('IF: Confirmed', 'Respond: Refused', 1);
  b.chain('Sheets: Clear Audit Log', 'Sheets: Clear Tickets', 'Respond: Done');
  return b.done();
}


// ---------- admin: one-time sheet setup (creates the two tabs with their header rows) ----------
function buildSetup() {
  const b = builder('Kesar admin: setup sheet');
  const header = (f) => fs.readFileSync(path.join(ROOT, 'setup', f), 'utf8').trim().split(',');
  b.add('Webhook: Setup', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: 'kesar-admin-setup', responseMode: 'responseNode', options: {} }, { webhookId: uid('admin-setup') });
  codeNode(b, 'Config', `
const body = $('Webhook: Setup').first().json.body || {};
const sheets = ${JSON.stringify(ctx.sheets)};
const ok = body.confirm === 'SETUP' && Object.prototype.hasOwnProperty.call(sheets, body.env) && !!sheets[body.env];
return [{ json: { ok, env: body.env || null, SHEET_ID: ok ? sheets[body.env] : null } }];`);
  ifNode(b, 'IF: Confirmed', '={{ $json.ok }}');
  const soft = { onError: 'continueRegularOutput', alwaysOutputData: true };
  const doc = { documentId: { __rl: true, value: `={{ $('Config').first().json.SHEET_ID }}`, mode: 'id' } };
  const tab = (label, title, file) => {
    sheetsNode(b, `Sheets: Create ${label}`, { operation: 'create', ...doc, title, options: {} }, soft);
    codeNode(b, `${label} Header Row`, `return [{ json: ${JSON.stringify(Object.fromEntries(header(file).map((h) => [h, 'x'])))} }];`);
    sheetsNode(b, `Sheets: Write ${label} Header`, { operation: 'append', ...sheet(title), columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] },
      options: { cellFormat: 'RAW', handlingExtraData: 'insertInNewColumn' } }, soft);
    sheetsNode(b, `Sheets: Clear ${label} Rows`, { operation: 'clear', ...sheet(title), clear: 'wholeSheet', keepFirstRow: true }, soft);
    return [`Sheets: Create ${label}`, `${label} Header Row`, `Sheets: Write ${label} Header`, `Sheets: Clear ${label} Rows`];
  };
  const a = tab('Audit', 'Audit Log', 'audit_log_header.csv');
  const t = tab('Tickets', 'Tickets', 'tickets_header.csv');
  sheetsNode(b, 'Sheets: Remove Sheet1', { operation: 'remove', ...sheet('Sheet1') }, soft);
  b.add('Respond: Done', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'json', responseBody: `={{ JSON.stringify({ ok: true, env: $('Config').first().json.env }) }}`, options: {} });
  b.add('Respond: Refused', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'json', responseBody: `={{ JSON.stringify({ ok: false, error: 'bad request or sheet url missing' }) }}`, options: { responseCode: 400 } }, {}, [960, 520]);
  b.chain('Webhook: Setup', 'Config', 'IF: Confirmed');
  b.link('IF: Confirmed', a[0], 0);
  b.link('IF: Confirmed', 'Respond: Refused', 1);
  b.chain(...a, ...t, 'Sheets: Remove Sheet1', 'Respond: Done');
  return b.done();
}

// ---------- main workflow ----------
function buildMain() {
  const b = builder('Kesar Support Copilot' + SUFFIX);
  const E = `$('Normalize Email').first().json`;
  const M = ctx.models;
  const useClassifyFallback = !!M.classify_fallback;
  const useAgentFallback = !!M.agent_fallback;
  const toolIds = ctx.workflows;

  b.add('Webhook: New Email', 'n8n-nodes-base.webhook', 2, { httpMethod: 'POST', path: WEBHOOK_PATH, responseMode: 'responseNode', options: {} }, { webhookId: uid('webhook-' + ENV) });

  // Every tunable setting lives here so it can be changed in one place.
  const P = ctx.prices || {};
  const cfg = { ENV, PROMPT_VERSION: PV, SHEET_ID, RETURN_WINDOW_DAYS: 7, DAMAGE_WINDOW_DAYS: 2, CONFIDENCE_THRESHOLD: 0.75,
    ORDERS_URL: RAW + 'orders.json', FAQ_URL: RAW + 'faq.md', CLASSIFY_MODEL: M.classify.model, AGENT_MODEL: M.agent.model,
    PRICE_CLASSIFY_IN_USD_PER_M: P.classify_in || 0, PRICE_CLASSIFY_OUT_USD_PER_M: P.classify_out || 0,
    PRICE_AGENT_IN_USD_PER_M: P.agent_in || 0, PRICE_AGENT_OUT_USD_PER_M: P.agent_out || 0 };
  b.add('Config', 'n8n-nodes-base.set', 3.4, { mode: 'manual', includeOtherFields: false, options: {},
    assignments: { assignments: Object.entries(cfg).map(([name, value]) => ({ id: uid('cfg-' + name), name, value, type: typeof value === 'number' ? 'number' : 'string' })) } });

  codeNode(b, 'Normalize Email', pure('normalize_email.js') + `
const body = $('Webhook: New Email').first().json.body;
const e = normalizeEmail(body);
if (!e.error) {
  // The email is always handed to the LLM inside <email> tags and treated as data.
  e.email_block = '<email>\\nFrom: ' + e.from_name + ' <' + e.from_email + '>\\nSubject: ' + e.subject +
    '\\nAttachments: ' + e.attachments.length + '\\nBody:\\n' + e.body + '\\n</email>';
}
return [{ json: e }];`);
  ifNode(b, 'IF: Bad Input', '={{ !!$json.error }}');
  b.add('Respond: Bad Input', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'json', responseBody: `={{ JSON.stringify({ error: ${E}.error }) }}`, options: { responseCode: 400 } }, {}, [1200, 520]);
  httpText(b, 'HTTP: Orders', `={{ $('Config').first().json.ORDERS_URL }}`);
  httpText(b, 'HTTP: FAQ', `={{ $('Config').first().json.FAQ_URL }}`);

  // --- classify ---
  const llmRetry = { onError: 'continueRegularOutput', retryOnFail: true, maxTries: 2, waitBetweenTries: 5000 };
  b.add('LLM: Classify', '@n8n/n8n-nodes-langchain.chainLlm', 1.7, { promptType: 'define', text: `={{ ${E}.email_block }}`, needsFallback: useClassifyFallback,
    messages: { messageValues: [{ type: 'SystemMessagePromptTemplate', message: prompt(`classify_${PV}.md`) }] } }, llmRetry);
  const xClassify = 240 * 7;
  chatModel(b, 'Classify Model', M.classify, 0, [xClassify - 60, 520]);
  b.link('Classify Model', 'LLM: Classify', 0, 'ai_languageModel', 0);
  if (useClassifyFallback) { chatModel(b, 'Classify Fallback Model', M.classify_fallback, 0, [xClassify + 120, 520]); b.link('Classify Fallback Model', 'LLM: Classify', 0, 'ai_languageModel', 1); }

  const validateGlue = (label) => `
const email = ${E};
const j = $input.first().json || {};
const raw = typeof j.text === 'string' ? j.text : (j.response && typeof j.response.text === 'string' ? j.response.text : (typeof j.output === 'string' ? j.output : ''));
const llmError = j.error ? String(j.error.message || j.error.description || JSON.stringify(j.error)).slice(0, 300) : '';
const r = validateClassification(raw, email.text);
return [{ json: { stage: '${label}', raw_output: String(raw).slice(0, 2000), llm_error: llmError, valid_strict: r.valid_strict, errors: r.errors,
  code_fixable: r.code_fixable, notes: r.notes, classification: r.classification, needs_llm_repair: !r.classification } }];`;
  codeNode(b, 'Validate Classification', pure('validate_classification.js') + validateGlue('first_try'));
  ifNode(b, 'IF: Needs Repair', '={{ $json.needs_llm_repair }}');
  b.add('LLM: Repair JSON', '@n8n/n8n-nodes-langchain.chainLlm', 1.7, { promptType: 'define', needsFallback: false,
    text: `={{ 'ERRORS:\\n' + $('Validate Classification').first().json.errors.join('\\n') + '\\n\\nPREVIOUS OUTPUT:\\n' + $('Validate Classification').first().json.raw_output + '\\n\\n' + ${E}.email_block }}`,
    messages: { messageValues: [{ type: 'SystemMessagePromptTemplate', message: prompt('classify_repair.md') }] } }, llmRetry, [240 * 10, 520]);
  chatModel(b, 'Repair Model', M.classify, 0, [240 * 10, 740]);
  b.link('Repair Model', 'LLM: Repair JSON', 0, 'ai_languageModel', 0);
  codeNode(b, 'Validate Repair', pure('validate_classification.js') + validateGlue('repair'), {}, [240 * 11, 520]);
  b.at(240 * 11);
  codeNode(b, 'Finalize Classification', pure('validate_classification.js') + `
// Pick the classification: first try, code-fixed, LLM-repaired, or the deterministic fallback.
const first = $('Validate Classification').first().json;
let c = first.classification;
let method = first.valid_strict ? 'none' : (first.code_fixable ? 'code' : null);
let notes = (first.notes || []).slice();
let llmError = first.llm_error || '';
if (!c) {
  let rep = null;
  try { rep = $('Validate Repair').first().json; } catch (e) { rep = null; }
  if (rep && rep.classification) { c = rep.classification; method = 'llm'; notes = notes.concat(rep.notes || []); }
  else { c = fallbackClassification(); method = 'fallback'; if (rep && rep.llm_error) llmError = llmError || rep.llm_error; }
}
const email = ${E};
// Never guess an order ID: use the model's only if it is literally in the email (checked in validation);
// if the model missed a single ID that is plainly there, use that one.
let lookupId = c.order_id; let source = c.order_id ? 'llm' : 'none';
if (!lookupId && email.order_ids_in_text.length === 1) { lookupId = email.order_ids_in_text[0]; source = 'regex'; }
return [{ json: { classification: c, json_valid_first_try: !!first.valid_strict, repair_method: method, notes, llm_order_id: c.order_id,
  lookup_order_id: lookupId, order_id_source: source, llm_error: llmError, classify_raw_chars: (first.raw_output || '').length } }];`);

  // --- order, facts, route (all deterministic) ---
  codeNode(b, 'Resolve Order', pure('resolve_order.js') + `
const email = ${E};
const fin = $('Finalize Classification').first().json;
const raw = $('HTTP: Orders').first().json.data;
const orders = (typeof raw === 'string' ? JSON.parse(raw) : raw).orders;
const orderIntents = ['order_status', 'return_refund', 'complaint'];
let lookup = { found: false, authorized: false, match_method: 'none', order_id: null, order: null, reason: 'Lookup not needed for this intent.' };
if (fin.lookup_order_id || orderIntents.indexOf(fin.classification.intent) !== -1) {
  lookup = resolveOrder({ orders, order_id: fin.lookup_order_id, requester_email: email.from_email, allow_email_fallback: true, include_withheld: true });
}
return [{ json: lookup }];`);
  codeNode(b, 'Compute Facts', pure('compute_facts.js') + `
return [{ json: computeFacts({ email: ${E}, classification: $('Finalize Classification').first().json.classification,
  lookup: $('Resolve Order').first().json, config: $('Config').first().json }) }];`);
  codeNode(b, 'Decide Route', pure('decide_route.js') + `
return [{ json: decideRoute({ email: ${E}, classification: $('Finalize Classification').first().json.classification,
  lookup: $('Resolve Order').first().json, facts: $('Compute Facts').first().json, config: $('Config').first().json }) }];`);
  ifNode(b, 'IF: Draft Needed', '={{ $json.draft_needed }}');

  // --- AI agent with two tools ---
  const xAgent = 240 * 17;
  b.add('AI Agent: Draft Reply', '@n8n/n8n-nodes-langchain.agent', 3.1, { promptType: 'define', needsFallback: useAgentFallback,
    text: `={{ 'FACTS\\n' + $('Decide Route').first().json.agent_brief + '\\n\\n' + ${E}.email_block }}`,
    options: { systemMessage: prompt(`agent_system_${PV}.md`), maxIterations: 5, returnIntermediateSteps: true } },
    { onError: 'continueRegularOutput', retryOnFail: true, maxTries: 2, waitBetweenTries: 5000 }, [xAgent, 300]);
  chatModel(b, 'Agent Model', M.agent, 0.2, [xAgent - 200, 540]);
  b.link('Agent Model', 'AI Agent: Draft Reply', 0, 'ai_languageModel', 0);
  if (useAgentFallback) { chatModel(b, 'Agent Fallback Model', M.agent_fallback, 0.2, [xAgent - 40, 540]); b.link('Agent Fallback Model', 'AI Agent: Draft Reply', 0, 'ai_languageModel', 1); }
  const col = (id) => ({ id, displayName: id, required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string', removed: false });
  const tool = (name, description, wfId, value, cols, pos) => b.add(name, '@n8n/n8n-nodes-langchain.toolWorkflow', 2.2, { description, workflowId: { __rl: true, value: wfId, mode: 'id' },
    workflowInputs: { mappingMode: 'defineBelow', value, matchingColumns: [], schema: cols.map(col), attemptToConvertTypes: false, convertFieldsToString: false } }, {}, pos);
  tool('get_order', 'Look up one order by its ID (format KC-1234). Returns status, dates, courier, tracking link, items and amounts, but only if the person writing is the customer who placed the order. If it returns found=false or authorized=false, do not state any order detail.',
    toolIds['Kesar tool: get_order'], { order_id: `={{ $fromAI('order_id', 'The order ID in the form KC-1234', 'string') }}`, requester_email: `={{ ${E}.from_email }}` }, ['order_id', 'requester_email'], [xAgent + 140, 540]);
  tool('search_faq', 'Search the Kesar & Co. FAQ and policies (shipping, cash on delivery, cancellation, returns, damaged or wrong or missing items, refunds, products, medical safety, contact). Pass a few English keywords. Returns the matching sections word for word. If it returns no matches, the FAQ does not cover the topic: do not answer it.',
    toolIds['Kesar tool: search_faq'], { query: `={{ $fromAI('query', 'A few English keywords describing the policy or product question', 'string') }}` }, ['query'], [xAgent + 320, 540]);
  b.link('get_order', 'AI Agent: Draft Reply', 0, 'ai_tool', 0);
  b.link('search_faq', 'AI Agent: Draft Reply', 0, 'ai_tool', 0);

  b.at(xAgent);
  codeNode(b, 'Postcheck Reply', pure('postcheck_reply.js') + `
// Parse the agent's output and run the safety checks. A failed critical check
// replaces the draft with a neutral holding reply and flags the email for a human.
const email = ${E};
const route = $('Decide Route').first().json;
const lookup = $('Resolve Order').first().json;
const facts = $('Compute Facts').first().json;
let out = { reply_draft: '', critical: [], soft: [], replaced: false, escalate: false, escalate_reason: '', faq_sections: [], tools_called: [], tool_calls: 0, agent_error: '', format_error: false, agent_chars: 0 };
if (route.draft_needed) {
  let a = null;
  try { a = $('AI Agent: Draft Reply').first().json; } catch (e) { out.agent_error = String(e.message || e).slice(0, 300); }
  if (a && a.error) out.agent_error = String(a.error.message || a.error.description || JSON.stringify(a.error)).slice(0, 300);
  if (a && typeof a.output === 'string' && a.output.trim()) {
    const parsed = parseAgentOutput(a.output);
    const steps = Array.isArray(a.intermediateSteps) ? a.intermediateSteps : [];
    const tools = steps.map(function (s) { return s && s.action && s.action.tool; }).filter(Boolean);
    const pc = postcheckReply({ draft: parsed.reply, lookup, facts, route, faqText: String($('HTTP: FAQ').first().json.data || ''), first_name: email.from_first_name, tools_called: tools });
    out = Object.assign(out, pc, { escalate: parsed.escalate, escalate_reason: parsed.escalate_reason, faq_sections: parsed.faq_sections,
      tools_called: tools.filter(function (t, i) { return tools.indexOf(t) === i; }), tool_calls: tools.length, format_error: parsed.format_error, agent_chars: a.output.length });
  } else {
    out.agent_error = out.agent_error || 'agent returned no output';
    out.reply_draft = holdingReply(email.from_first_name);
    out.replaced = true;
  }
}
return [{ json: out }];`);

  // --- tickets: one open ticket per order ---
  ifNode(b, 'IF: Ticket Needed', `={{ $('Decide Route').first().json.ticket_needed }}`);
  const xT = 240 * 20;
  sheetsNode(b, 'Sheets: Read Tickets', { operation: 'read', ...sheet('Tickets'), options: {} }, { alwaysOutputData: true, onError: 'continueRegularOutput', retryOnFail: true, maxTries: 3, waitBetweenTries: 3000 }, [xT, 120]);
  codeNode(b, 'Ticket Decision', pure('ticket_upsert.js') + `
// Existing ticket rows come from the Sheet; decide create / update / unchanged.
const rows = $input.all().map(function (i) { return i.json; }).filter(function (r) { return r && r.ticket_id; });
const readError = $input.first() && $input.first().json && $input.first().json.error ? String($input.first().json.error.message || $input.first().json.error) : '';
const d = ticketDecision({ rows, email: ${E}, classification: $('Finalize Classification').first().json.classification,
  lookup: $('Resolve Order').first().json, route: $('Decide Route').first().json, now: new Date().toISOString() });
return [{ json: { action: readError ? 'error' : d.action, ticket_id: d.row ? d.row.ticket_id : '', row: d.row, write: !readError && (d.action === 'create' || d.action === 'update'), error: readError } }];`, {}, [xT + 240, 120]);
  ifNode(b, 'IF: Write Ticket', '={{ $json.write }}', [xT + 480, 120]);
  codeNode(b, 'Ticket Row', `return [{ json: $('Ticket Decision').first().json.row }];`, {}, [xT + 720, 20]);
  sheetsNode(b, 'Sheets: Upsert Ticket', upsert('Tickets', 'ticket_id'), { onError: 'continueRegularOutput', retryOnFail: true, maxTries: 3, waitBetweenTries: 3000 }, [xT + 960, 20]);

  // --- audit: one row per email, always ---
  b.at(xT + 960);
  codeNode(b, 'Build Audit Row', pure('audit_row.js') + `
const email = ${E};
const cfg = $('Config').first().json;
const fin = $('Finalize Classification').first().json;
const lookup = $('Resolve Order').first().json;
const route = $('Decide Route').first().json;
const pc = $('Postcheck Reply').first().json;
let td = null; try { td = $('Ticket Decision').first().json; } catch (e) { td = null; }
let ticketWriteError = '';
try { const w = $('Sheets: Upsert Ticket').first().json; if (w && w.error) ticketWriteError = String(w.error.message || w.error); } catch (e) {}

const reasons = (route.needs_human_reasons || []).slice();
(pc.critical || []).forEach(function (c) { reasons.push('postcheck:' + c); });
if (pc.escalate) reasons.push('faq_gap');
if (pc.agent_error) reasons.push('agent_error');
if (fin.llm_error && fin.repair_method === 'fallback') reasons.push('classifier_error');
const ticketError = (td && td.error) || ticketWriteError;
if (ticketError) reasons.push('ticket_error');

const errors = [];
if (fin.llm_error) errors.push('classify: ' + fin.llm_error);
if (pc.agent_error) errors.push('agent: ' + pc.agent_error);
if (ticketError) errors.push('ticket: ' + ticketError);

let action = 'log_only';
if (route.draft_needed) {
  action = pc.agent_error ? 'error_fallback' : 'draft_reply';
  if (td && td.action === 'create') action += '+ticket_created';
  if (td && (td.action === 'update' || td.action === 'unchanged')) action += '+ticket_updated';
}

const notes = ['order_match=' + (lookup.match_method || 'none'), 'order_id_source=' + fin.order_id_source, 'repair=' + fin.repair_method];
if ((fin.notes || []).length) notes.push('classify_notes=' + fin.notes.join(','));
if (route.draft_needed) notes.push('tools=' + ((pc.tools_called || []).join(',') || 'none'), 'faq=' + ((pc.faq_sections || []).join(',') || 'none'));
if ((pc.soft || []).length) notes.push('voice=' + pc.soft.join(','));
if (pc.replaced) notes.push('draft_replaced_by_holding_reply');
if (pc.escalate_reason) notes.push('agent_escalated=' + pc.escalate_reason);
if (lookup.reason) notes.push('lookup=' + lookup.reason);
if (fin.classification.intent === 'other' && fin.classification.other_category === 'partnership') notes.push('partnership enquiry; FAQ section 9 contact partnerships@kesarandco.example');
if (td && td.action) notes.push('ticket=' + td.action);
if (route.rerouted_as_complaint) notes.push('routed_as=complaint (item problem reported; model intent was ' + route.llm_intent + ')');

// Token and cost ESTIMATE (characters / 4). Labelled as an estimate everywhere it is reported.
const classifyIn = (${JSON.stringify(prompt(`classify_${PV}.md`).length)} + email.email_block.length) / 4;
const classifyOut = (fin.classify_raw_chars || 0) / 4;
let agentIn = 0, agentOut = 0;
if (route.draft_needed && !pc.agent_error) {
  const turns = 1 + (pc.tool_calls || 0);
  const base = (${JSON.stringify(prompt(`agent_system_${PV}.md`).length)} + route.agent_brief.length + email.email_block.length) / 4 + 250;
  agentIn = base * turns + 350 * (pc.tool_calls || 0) * (turns / 2);
  agentOut = (pc.agent_chars || 0) / 4 + 40 * (pc.tool_calls || 0);
}
const tokensIn = Math.round(classifyIn + agentIn), tokensOut = Math.round(classifyOut + agentOut);
const cost = (classifyIn * cfg.PRICE_CLASSIFY_IN_USD_PER_M + classifyOut * cfg.PRICE_CLASSIFY_OUT_USD_PER_M + agentIn * cfg.PRICE_AGENT_IN_USD_PER_M + agentOut * cfg.PRICE_AGENT_OUT_USD_PER_M) / 1e6;

const row = buildAuditRow({ email, classification: fin.classification, lookup, route, prompt_version: cfg.PROMPT_VERSION, action_taken: action,
  needs_human: reasons.length > 0, needs_human_reasons: reasons, ticket_id: td ? td.ticket_id : '', reply_draft: pc.reply_draft || '',
  processed_at: new Date().toISOString(), error: errors.join(' | '), notes, json_valid_first_try: fin.json_valid_first_try,
  tokens_est: tokensIn + tokensOut, cost_usd_est: Math.round(cost * 1e6) / 1e6 });
return [{ json: row }];`);
  sheetsNode(b, 'Sheets: Upsert Audit Row', upsert('Audit Log', 'audit_key'), { retryOnFail: true, maxTries: 3, waitBetweenTries: 3000 });
  codeNode(b, 'Build Response', `
// What the caller gets back: the audit row plus a few debugging fields.
const row = $('Build Audit Row').first().json;
const fin = $('Finalize Classification').first().json;
const lookup = $('Resolve Order').first().json;
const pc = $('Postcheck Reply').first().json;
let td = null; try { td = $('Ticket Decision').first().json; } catch (e) { td = null; }
return [{ json: Object.assign({}, row, { needs_human: row.needs_human === 'TRUE', order_found: row.order_found === 'TRUE', json_valid_first_try: row.json_valid_first_try === 'TRUE',
  llm_order_id: fin.llm_order_id, order_match: lookup.match_method, repair_method: fin.repair_method, ticket_action: td ? td.action : 'none',
  tools_called: pc.tools_called || [], postcheck_failures: pc.critical || [] }) }];`);
  b.add('Respond to Webhook', 'n8n-nodes-base.respondToWebhook', 1.1, { respondWith: 'firstIncomingItem', options: {} });

  // wiring
  b.chain('Webhook: New Email', 'Config', 'Normalize Email', 'IF: Bad Input');
  b.link('IF: Bad Input', 'Respond: Bad Input', 0);
  b.link('IF: Bad Input', 'HTTP: Orders', 1);
  b.chain('HTTP: Orders', 'HTTP: FAQ', 'LLM: Classify', 'Validate Classification', 'IF: Needs Repair');
  b.link('IF: Needs Repair', 'LLM: Repair JSON', 0);
  b.link('IF: Needs Repair', 'Finalize Classification', 1);
  b.chain('LLM: Repair JSON', 'Validate Repair', 'Finalize Classification');
  b.chain('Finalize Classification', 'Resolve Order', 'Compute Facts', 'Decide Route', 'IF: Draft Needed');
  b.link('IF: Draft Needed', 'AI Agent: Draft Reply', 0);
  b.link('IF: Draft Needed', 'Postcheck Reply', 1);
  b.chain('AI Agent: Draft Reply', 'Postcheck Reply', 'IF: Ticket Needed');
  b.link('IF: Ticket Needed', 'Sheets: Read Tickets', 0);
  b.link('IF: Ticket Needed', 'Build Audit Row', 1);
  b.chain('Sheets: Read Tickets', 'Ticket Decision', 'IF: Write Ticket');
  b.link('IF: Write Ticket', 'Ticket Row', 0);
  b.link('IF: Write Ticket', 'Build Audit Row', 1);
  b.chain('Ticket Row', 'Sheets: Upsert Ticket', 'Build Audit Row');
  b.chain('Build Audit Row', 'Sheets: Upsert Audit Row', 'Build Response', 'Respond to Webhook');
  return b.done();
}

fs.mkdirSync(OUT, { recursive: true });
const which = arg('only', 'all');
const outputs = {};
if (which === 'all' || which === 'tools') {
  outputs['kesar_tool_get_order.json'] = buildGetOrder();
  outputs['kesar_tool_search_faq.json'] = buildSearchFaq();
  outputs['kesar_admin_reset_sheet.json'] = buildAdmin();
  outputs['kesar_admin_setup_sheet.json'] = buildSetup();
}
if (which === 'all' || which === 'main') outputs[`kesar_support_copilot_${ENV}.json`] = buildMain();
for (const [file, wf] of Object.entries(outputs)) {
  fs.writeFileSync(path.join(OUT, file), JSON.stringify(wf, null, 2));
  console.log(`built ${file}: ${wf.nodes.length} nodes`);
}
