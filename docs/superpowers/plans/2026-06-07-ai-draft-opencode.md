# AI Draft via opencode headless — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-section, codebase-grounded AI drafting in Fill mode via a local `opencode serve` HTTP API.

**Architecture:** All app code stays inside the single `design-template-generator.html` (no build step). A new `// ── AI draft (opencode) ──` script block adds a small HTTP client, a FIFO request queue, pure prompt/validation helpers, and UI wiring into the existing Fill-mode render functions. A standalone Node mock server (`test/mock-opencode.js`) enables manual E2E without a real opencode install.

**Tech Stack:** Vanilla JS (browser `fetch`), opencode server HTTP API (`POST /session`, `POST /session/:id/message`, `GET /doc`, default `http://127.0.0.1:4096`), Node `http` for the mock.

**Spec:** `docs/superpowers/specs/2026-06-07-ai-draft-opencode-design.md`

**Testing note:** Project is a buildless single HTML file with no test framework (deviation accepted in spec §5). "Tests" here are: curl checks for the mock server, DevTools-console assertion snippets for pure functions, and a manual E2E checklist against the mock. Run console snippets in the browser DevTools console with the page open.

**Existing functions you will reuse (already in the file — do NOT redefine):** `val(id)`, `escHtml(s)`, `buildCtx()`, `buildTechStackLines()`, `serializeBlocks(blocks)`, `parseMarkdownBlocks(md)`, `tableSig(headers)`, `guideMarkdown(n)`, `normSecName(s)`, `ensureFillData(s)`, `sectionEdited(n)`, `sectionPlaceholderCount(n)`, `rerenderSection(n)`, `scheduleSave()`, `SECTIONS`, `fillData`, `checked`, `CFG`.

---

### Task 1: Mock opencode server

**Files:**
- Create: `test/mock-opencode.js`

- [ ] **Step 1: Write the mock server**

```js
// test/mock-opencode.js — mimics `opencode serve` for manual E2E of the AI draft feature.
// Usage:
//   node test/mock-opencode.js             # happy path
//   node test/mock-opencode.js --fail500   # every request returns HTTP 500
//   node test/mock-opencode.js --bad-md    # message response is not valid section markdown
const http = require('http');
const FAIL = process.argv.includes('--fail500');
const BAD  = process.argv.includes('--bad-md');
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
function json(res, code, obj){
  res.writeHead(code, {...CORS, 'Content-Type': 'application/json'});
  res.end(JSON.stringify(obj));
}
http.createServer((req, res) => {
  if(req.method === 'OPTIONS'){ res.writeHead(204, CORS); return res.end(); }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    if(FAIL) return json(res, 500, {error: 'mock failure'});
    if(req.url === '/doc' && req.method === 'GET') return json(res, 200, {openapi: '3.1.0'});
    if(req.url === '/session' && req.method === 'POST') return json(res, 200, {id: 'mock-session-1'});
    if(/^\/session\/[^/]+\/message$/.test(req.url) && req.method === 'POST'){
      const prompt = (JSON.parse(body).parts || []).map(p => p.text || '').join('\n');
      // Echo back the "Current section markdown" part of the prompt with placeholders filled.
      const m = prompt.match(/## Current section markdown[^\n]*\n([\s\S]*?)\n## Output contract/);
      const section = m ? m[1].trim() : '## Unknown';
      const filled = BAD
        ? 'this is not the requested section markdown'
        : section.replace(/_[^_\n|]+_/g, 'Mock value').replace(/YYYY-MM-DD/g, '2026-12-31');
      return json(res, 200, {info: {id: 'msg-1'}, parts: [{type: 'text', text: filled}]});
    }
    json(res, 404, {error: 'not found'});
  });
}).listen(4096, () => console.log(
  'mock opencode on http://127.0.0.1:4096' + (FAIL ? ' (fail500)' : '') + (BAD ? ' (bad-md)' : '')
));
```

- [ ] **Step 2: Verify with curl**

Run (in one terminal): `node test/mock-opencode.js`
Run (in another):

```bash
curl -s http://127.0.0.1:4096/doc
# Expected: {"openapi":"3.1.0"}
curl -s -X POST http://127.0.0.1:4096/session -H 'Content-Type: application/json' -d '{"title":"t"}'
# Expected: {"id":"mock-session-1"}
curl -s -X POST http://127.0.0.1:4096/session/mock-session-1/message -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"## Current section markdown (fill the placeholders)\n## Trade-off\n| A | B |\n|---|---|\n| _fill me_ | x |\n## Output contract"}]}'
# Expected: parts[0].text contains "| Mock value | x |"
```

- [ ] **Step 3: Commit**

```bash
git add test/mock-opencode.js
git commit -m "test: add mock opencode server for AI draft E2E"
```

---

### Task 2: AI settings + pure helpers (prompt build, response validation)

**Files:**
- Modify: `design-template-generator.html` — `DEFAULT_SETTINGS` (~line 2104) and new script block inserted immediately BEFORE the line `const GUIDES={` (~line 1602)

- [ ] **Step 1: Add AI fields to DEFAULT_SETTINGS**

Replace:

```js
const DEFAULT_SETTINGS = {
  owner:      '',
  repoPrefix: 'github.com/org/',
  runbookBase:'',
  separator:  '---',
  techLine:   'on',
};
```

with:

```js
const DEFAULT_SETTINGS = {
  owner:      '',
  repoPrefix: 'github.com/org/',
  runbookBase:'',
  separator:  '---',
  techLine:   'on',
  aiUrl:      'http://127.0.0.1:4096',
  aiModel:    '',   // blank = server default; format "provider/model"
  aiAgent:    '',   // blank = default agent
};
```

(`loadSettings()` already spreads stored JSON over defaults — no other change needed.)

- [ ] **Step 2: Insert the pure-helper block**

Insert immediately before `const GUIDES={`:

```js
// ── AI draft (opencode) — pure helpers ─────────────────────────────────────────
function aiCfg(){
  return { url: (CFG.aiUrl || 'http://127.0.0.1:4096').replace(/\/+$/, ''),
           model: CFG.aiModel || '', agent: CFG.aiAgent || '' };
}

function extractResponseText(parts){
  return (parts || []).filter(p => p && p.type === 'text' && p.text)
    .map(p => p.text).join('\n').trim();
}

function stripWrappingFence(t){
  const s = String(t || '').trim();
  const m = s.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  return m ? m[1] : s;
}

// Guide content up to (excluding) the worked-example heading — same heading
// detection idea as extractExampleTables. Capped to keep prompts bounded.
function guideRulesExcerpt(n){
  const md = guideMarkdown(n); if(!md) return '';
  const lines = md.split('\n');
  for(let i = 0; i < lines.length; i++){
    if(/^#{2,4}\s+.*worked example/i.test(lines[i])) return lines.slice(0, i).join('\n').slice(0, 4000);
  }
  return md.slice(0, 4000);
}

function buildSectionPrompt(n){
  const s = SECTIONS.find(x => x.n === n); ensureFillData(s);
  const ctx = buildCtx();
  return [
    "You are filling one section of a system-design doc for the codebase in your working directory. Inspect the code; state facts, don't invent.",
    '',
    '## Service context',
    'Name: ' + ctx.name,
    'Description: ' + ctx.desc,
    'Owner: ' + ctx.owner,
    'Tech stack:',
    ctx.techStackLines,
    '',
    '## Section rules',
    s.hint || '',
    guideRulesExcerpt(n),
    '',
    '## Current section markdown (fill the placeholders)',
    serializeBlocks(fillData[n]),
    '',
    '## Output contract',
    'Return ONLY the completed section markdown, same headings, same table columns. Keep _placeholder_ style for anything you cannot verify from code.'
  ].join('\n');
}

// Validate + reconcile an agent response against the section's current blocks.
// Returns {ok:true, blocks} or {ok:false, error}.
// Tables are reconciled in order: a response table is accepted only if its
// header signature matches the original table at the same position; otherwise
// the original table is kept. Extra response tables are dropped; missing
// originals are appended.
function validateSectionResponse(n, text){
  const s = SECTIONS.find(x => x.n === n);
  const blocks = parseMarkdownBlocks(stripWrappingFence(text));
  if(!blocks.length || !blocks.some(b => (b.value || b.rows))) return {ok:false, error:'Empty response'};
  const firstText = blocks.find(b => b.type === 'text');
  const hm = firstText && firstText.value.match(/^##\s+(.+)$/m);
  if(!hm || normSecName(hm[1]) !== normSecName(s.name))
    return {ok:false, error:'Response heading does not match section'};
  const origTables = (fillData[n] || []).filter(b => b.type === 'table');
  const merged = []; let ti = 0;
  blocks.forEach(b => {
    if(b.type !== 'table'){ merged.push(b); return; }
    const orig = origTables[ti++];
    if(orig && tableSig(b.headers) === tableSig(orig.headers)) merged.push(b);
    else if(orig) merged.push(orig);
    // extra table beyond the original count: dropped
  });
  while(ti < origTables.length) merged.push(origTables[ti++]);
  return {ok:true, blocks: merged};
}
```

- [ ] **Step 3: Verify pure helpers in DevTools console**

Open `design-template-generator.html` in a browser, fill a service name, pick scenario "Fullstack feature", go to step 5, switch to Fill mode. Paste into console:

```js
(function(){
  const ok = (c, m) => console.log((c ? 'PASS' : 'FAIL') + ' — ' + m);
  ok(stripWrappingFence('```md\n## X\n```') === '## X', 'stripWrappingFence strips fence');
  ok(stripWrappingFence('## X') === '## X', 'stripWrappingFence passthrough');
  ok(extractResponseText([{type:'text',text:'a'},{type:'tool'},{type:'text',text:'b'}]) === 'a\nb', 'extractResponseText joins text parts');
  const p = buildSectionPrompt('17');
  ok(p.includes('## Current section markdown') && p.includes('## Output contract'), 'buildSectionPrompt has frame');
  ok(p.includes('Trade-off'), 'buildSectionPrompt includes section content');
  const tpl = serializeBlocks(fillData['17']);
  const good = validateSectionResponse('17', tpl.replace(/_[^_\n|]+_/g, 'Filled'));
  ok(good.ok === true, 'validateSectionResponse accepts same-shape response');
  const bad = validateSectionResponse('17', '## Wrong heading\n\ntext');
  ok(bad.ok === false, 'validateSectionResponse rejects wrong heading');
  const mangled = validateSectionResponse('17', tpl.replace(/^\|.*\|$/m, '| Only | Two |'));
  ok(mangled.ok === true, 'mangled table falls back to original');
})();
```

Expected: all lines `PASS`. (Section 17 "Trade-off" is in every scenario's SR set, so `fillData['17']` exists after Fill mode renders.)

- [ ] **Step 4: Commit**

```bash
git add design-template-generator.html
git commit -m "feat: AI draft settings and pure prompt/validation helpers"
```

---

### Task 3: HTTP client, FIFO queue, banner plumbing

**Files:**
- Modify: `design-template-generator.html` — append to the AI block from Task 2 (still before `const GUIDES={`); CSS before `</style>` (~line 299)

- [ ] **Step 1: Add CSS**

Insert before `</style>`:

```css
/* AI DRAFT */
.fill-draft{font-size:11px;padding:3px 8px;border:0.5px solid var(--blue-border);border-radius:6px;background:var(--blue-bg);color:var(--blue-text);cursor:pointer;font-family:var(--font);white-space:nowrap}
.fill-draft:hover{opacity:.85}
.fill-draft:disabled{opacity:.5;cursor:wait}
.ai-err{font-size:11px;color:var(--red-text)}
.ai-banner{padding:10px 12px;margin-bottom:14px;background:var(--amber-bg);border:0.5px solid var(--amber-border);border-radius:var(--r);font-size:12px;color:var(--amber-text);line-height:1.6}
.ai-banner code{font-family:var(--mono);font-size:11px;background:var(--bg);padding:1px 5px;border-radius:3px}
.ai-panel{padding:12px;margin-bottom:14px;border:0.5px solid var(--border2);border-radius:var(--rl);background:var(--bg2);display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.ai-panel label{margin:0 0 3px;font-size:9px}
.ai-panel input{padding:5px 8px;font-size:12px;border:0.5px solid var(--border2);border-radius:6px;background:var(--bg);color:var(--text);font-family:var(--font)}
```

- [ ] **Step 2: Add client + queue + banner code**

Append to the AI block:

```js
// ── AI draft (opencode) — HTTP client + queue ──────────────────────────────────
let aiSession = null;        // session id, memory only (stale after reload is worthless)
let aiQueue = [];            // section numbers waiting (FIFO — one in-flight message per session)
let aiActive = null;         // section number currently drafting
let aiBatch = null;          // {total} while "Draft unfilled" batch runs
let aiUndo = {};             // sectionN -> previous blocks (one level, memory only)
let _aiTimers = {};          // sectionN -> elapsed-seconds interval

function launchCmd(){
  const origin = (location.protocol === 'file:' || location.origin === 'null') ? 'null' : location.origin;
  return 'opencode serve --port 4096 --cors ' + origin;
}
function connectHelpHtml(){
  return 'Cannot reach opencode at <code>' + escHtml(aiCfg().url) + '</code>. ' +
    'From your service repo root run: <code>' + escHtml(launchCmd()) + '</code> ' +
    '<button class="mini-btn" onclick="hideAiBanner()" style="float:right">✕</button>';
}
function showAiBanner(html){ const el = document.getElementById('ai-banner'); if(el){ el.innerHTML = html; el.style.display = 'block'; } }
function hideAiBanner(){ const el = document.getElementById('ai-banner'); if(el) el.style.display = 'none'; }

function friendlyAiError(e){
  if(e instanceof TypeError) return 'Server unreachable or CORS blocked — see banner';
  return ((e && e.message) || 'Unknown error').slice(0, 160);
}

async function aiFetch(path, opts){
  const r = await fetch(aiCfg().url + path, opts);
  if(!r.ok) throw new Error('Server error (' + r.status + '): ' + (await r.text()).slice(0, 200));
  return r.json();
}

async function aiEnsureSession(){
  if(aiSession) return aiSession;
  await aiFetch('/doc', {method: 'GET'});   // cheap connectivity ping (spec §1)
  const s = await aiFetch('/session', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({title: (val('svc-name') || 'design') + ' design doc'})
  });
  aiSession = s.id;
  return aiSession;
}

async function aiSendMessage(prompt){
  const id = await aiEnsureSession();
  const cfg = aiCfg();
  const body = {parts: [{type: 'text', text: prompt}]};
  if(cfg.model){
    const i = cfg.model.indexOf('/');
    body.model = i > 0 ? {providerID: cfg.model.slice(0, i), modelID: cfg.model.slice(i + 1)} : cfg.model;
  }
  if(cfg.agent) body.agent = cfg.agent;
  const data = await aiFetch('/session/' + id + '/message', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
  });
  return extractResponseText(data.parts || []);
}

function setDraftBtn(n, state){
  const b = document.getElementById('ai-draft-btn-' + n); if(!b) return;
  if(state === 'idle'){ b.disabled = false; b.textContent = '✨ Draft'; }
  else if(state === 'queued'){ b.disabled = true; b.textContent = 'Queued'; }
  else { b.disabled = true; b.textContent = 'Drafting…'; }
  const sec = document.getElementById('fill-sec-' + n);
  if(sec) sec.style.opacity = state === 'busy' ? '.6' : '';   // dim while drafting (spec §3)
}
function setAiErr(n, msg){ const el = document.getElementById('ai-err-' + n); if(el) el.textContent = msg || ''; }
function startElapsed(n){
  const t0 = Date.now();
  _aiTimers[n] = setInterval(() => {
    const b = document.getElementById('ai-draft-btn-' + n);
    if(b) b.textContent = 'Drafting… ' + Math.round((Date.now() - t0) / 1000) + 's';
  }, 1000);
}
function stopElapsed(n){ clearInterval(_aiTimers[n]); delete _aiTimers[n]; }

function enqueueDraft(n){
  if(aiActive === n || aiQueue.includes(n)) return;
  const s = SECTIONS.find(x => x.n === n); if(!s) return;
  ensureFillData(s);
  if(sectionEdited(n) && !confirm('Draft over section ' + n + '? Current content will be replaced (one-level Undo available).')) return;
  aiQueue.push(n); setDraftBtn(n, 'queued'); setAiErr(n, '');
  processQueue();
}

async function processQueue(){
  if(aiActive || !aiQueue.length) return;
  const n = aiQueue.shift(); aiActive = n;
  setDraftBtn(n, 'busy'); startElapsed(n); updateBatchProgress();
  try{
    const text = await aiSendMessage(buildSectionPrompt(n));
    const v = validateSectionResponse(n, text);
    if(!v.ok) throw new Error("Response didn't match section format: " + v.error);
    aiUndo[n] = fillData[n];
    fillData[n] = v.blocks;
    rerenderSection(n); scheduleSave();
    hideAiBanner();
  }catch(e){
    if(e instanceof TypeError) showAiBanner(connectHelpHtml());
    setAiErr(n, friendlyAiError(e));
    if(aiBatch){
      aiQueue.forEach(q => setDraftBtn(q, 'idle'));
      aiQueue.length = 0; aiBatch = null;
      showAiBanner('Batch stopped at section ' + n + ': ' + escHtml(friendlyAiError(e)) +
        ' <button class="mini-btn" onclick="hideAiBanner()" style="float:right">✕</button>');
    }
  }finally{
    stopElapsed(n); aiActive = null; setDraftBtn(n, 'idle'); updateBatchProgress();
    processQueue();
  }
}

function undoDraft(n){
  if(!aiUndo[n]) return;
  fillData[n] = aiUndo[n]; delete aiUndo[n];
  rerenderSection(n); scheduleSave();
}
```

(`updateBatchProgress` is defined in Task 5; until then add a temporary stub right after this block: `function updateBatchProgress(){}` — Task 5 replaces it.)

- [ ] **Step 3: Verify client against mock in console**

Start `node test/mock-opencode.js`. Reload the page, open console:

```js
aiSendMessage('## Current section markdown (fill the placeholders)\n## Trade-off\n\n| Decision | Gave up |\n|---|---|\n| _x_ | _y_ |\n## Output contract').then(t => console.log(t.includes('Mock value') ? 'PASS' : 'FAIL', t));
```

Expected: `PASS` and markdown with `Mock value` cells. Then stop the mock and run again — expected: rejected promise with TypeError (check `friendlyAiError` returns the unreachable message).

- [ ] **Step 4: Commit**

```bash
git add design-template-generator.html
git commit -m "feat: opencode HTTP client, FIFO draft queue, error banner plumbing"
```

---

### Task 4: Per-section Draft/Undo buttons in Fill mode

**Files:**
- Modify: `design-template-generator.html` — `renderFillSectionHtml` (~line 1417)

- [ ] **Step 1: Add buttons to the section header**

In `renderFillSectionHtml(s)`, replace:

```js
function renderFillSectionHtml(s){
  const body=fillData[s.n].map((b,bi)=>renderBlockHtml(s.n,bi,b)).join('');
  const guide=GUIDES[s.n]?`<button class="fill-guide" onclick="openGuide('${s.n}')">Guide ↗</button>`:'';
  const example=GUIDES[s.n]?`<button class="fill-example" onclick="loadExample('${s.n}')" title="Fill this section's tables with the worked example from the guide">Load example</button>`:'';
  const ph=sectionPlaceholderCount(s.n);
  const badge=`<span class="fill-badge ${ph>0?'needs':'done'}" id="fill-badge-${s.n}">${ph>0?ph+' to fill':'✓ ready'}</span>`;
  const collapsed=collapsedSecs.has(s.n)?' collapsed':'';
  const hidden=(onlyUnfilled&&ph===0)?' style="display:none"':'';
  return `<div class="fill-sec${collapsed}" id="fill-sec-${s.n}"${hidden}>
    <div class="fill-sec-hd"><span class="fill-sec-toggle" onclick="toggleCollapse('${s.n}')"><span class="fill-chevron">▾</span><span class="fill-sec-num">${s.n}</span><span class="fill-sec-name">${escHtml(s.name)}</span></span>${badge}${example}${guide}<button class="fill-reset" onclick="resetFillSection('${s.n}')">Reset</button></div>
    <div class="fill-sec-body">${body}</div></div>`;
}
```

with:

```js
function renderFillSectionHtml(s){
  const body=fillData[s.n].map((b,bi)=>renderBlockHtml(s.n,bi,b)).join('');
  const guide=GUIDES[s.n]?`<button class="fill-guide" onclick="openGuide('${s.n}')">Guide ↗</button>`:'';
  const example=GUIDES[s.n]?`<button class="fill-example" onclick="loadExample('${s.n}')" title="Fill this section's tables with the worked example from the guide">Load example</button>`:'';
  const draft=`<button class="fill-draft" id="ai-draft-btn-${s.n}" onclick="enqueueDraft('${s.n}')" title="Draft this section from the codebase via opencode">✨ Draft</button>`;
  const undo=aiUndo[s.n]?`<button class="fill-draft" onclick="undoDraft('${s.n}')" title="Revert the last AI draft">↩ Undo</button>`:'';
  const err=`<span class="ai-err" id="ai-err-${s.n}"></span>`;
  const ph=sectionPlaceholderCount(s.n);
  const badge=`<span class="fill-badge ${ph>0?'needs':'done'}" id="fill-badge-${s.n}">${ph>0?ph+' to fill':'✓ ready'}</span>`;
  const collapsed=collapsedSecs.has(s.n)?' collapsed':'';
  const hidden=(onlyUnfilled&&ph===0)?' style="display:none"':'';
  return `<div class="fill-sec${collapsed}" id="fill-sec-${s.n}"${hidden}>
    <div class="fill-sec-hd"><span class="fill-sec-toggle" onclick="toggleCollapse('${s.n}')"><span class="fill-chevron">▾</span><span class="fill-sec-num">${s.n}</span><span class="fill-sec-name">${escHtml(s.name)}</span></span>${badge}${err}${draft}${undo}${example}${guide}<button class="fill-reset" onclick="resetFillSection('${s.n}')">Reset</button></div>
    <div class="fill-sec-body">${body}</div></div>`;
}
```

(Note: spec §3 says the button "shows Undo" after success; rendering Draft + Undo side by side is a deliberate minor refinement — re-draft stays one click. Undo button appears because `rerenderSection` runs after `aiUndo[n]` is set.)

- [ ] **Step 2: Manual verify against mock**

Start `node test/mock-opencode.js`. Open page → service name "Order Service" → scenario "Fullstack feature" → step 5 → Fill mode → expand section 17:
1. Click `✨ Draft` → button shows `Drafting… Ns` → section fills with `Mock value`, badge flips to `✓ ready`, `↩ Undo` appears.
2. Click `↩ Undo` → original placeholders restored, badge back to `N to fill`, Undo button gone.
3. Click `✨ Draft` again, then edit a cell, click `✨ Draft` → confirm dialog appears.
4. Click `✨ Draft` on two sections quickly → second shows `Queued`, runs after first.
5. Reload page → drafted content persisted (localStorage), Undo gone (memory-only) — expected.

- [ ] **Step 3: Commit**

```bash
git add design-template-generator.html
git commit -m "feat: per-section AI Draft and Undo buttons in Fill mode"
```

---

### Task 5: Fill-nav batch button, banner host, AI settings panel

**Files:**
- Modify: `design-template-generator.html` — `renderFillNav` (~line 1386); replace the `updateBatchProgress` stub from Task 3

- [ ] **Step 1: Extend renderFillNav**

Replace:

```js
function renderFillNav(){
  return `<div class="fill-nav">
    <button class="fill-nav-btn" id="fill-collapse-btn" onclick="toggleAllCollapsed()">Expand all</button>
    <button class="fill-nav-btn" id="fill-unfilled-btn" onclick="toggleOnlyUnfilled()">Only unfilled</button>
    <span class="fill-progress" id="fill-progress"></span>
  </div>`;
}
```

with:

```js
function renderFillNav(){
  return `<div class="fill-nav">
    <button class="fill-nav-btn" id="fill-collapse-btn" onclick="toggleAllCollapsed()">Expand all</button>
    <button class="fill-nav-btn" id="fill-unfilled-btn" onclick="toggleOnlyUnfilled()">Only unfilled</button>
    <button class="fill-nav-btn" id="ai-batch-btn" onclick="toggleBatch()">✨ Draft unfilled</button>
    <button class="fill-nav-btn" onclick="toggleAiPanel()">AI settings</button>
    <span class="fill-progress" id="ai-batch-progress"></span>
    <span class="fill-progress" id="fill-progress"></span>
  </div>
  <div class="ai-banner" id="ai-banner" style="display:none"></div>
  <div class="ai-panel" id="ai-panel" style="display:none">
    <div><label>Server URL</label><br><input id="ai-url" style="width:210px" placeholder="http://127.0.0.1:4096"></div>
    <div><label>Model (optional, provider/model)</label><br><input id="ai-model" style="width:180px" placeholder="server default"></div>
    <div><label>Agent (optional)</label><br><input id="ai-agent" style="width:110px" placeholder="default"></div>
    <button class="fill-nav-btn" onclick="saveAiSettings()">Save</button>
  </div>`;
}
```

- [ ] **Step 2: Add panel + batch functions; replace the updateBatchProgress stub**

Delete the temporary `function updateBatchProgress(){}` stub and append to the AI block:

```js
function toggleAiPanel(){
  const el = document.getElementById('ai-panel'); if(!el) return;
  const show = el.style.display === 'none';
  if(show){
    document.getElementById('ai-url').value = CFG.aiUrl || '';
    document.getElementById('ai-model').value = CFG.aiModel || '';
    document.getElementById('ai-agent').value = CFG.aiAgent || '';
  }
  el.style.display = show ? 'flex' : 'none';
}
function saveAiSettings(){
  CFG.aiUrl = document.getElementById('ai-url').value.trim() || DEFAULT_SETTINGS.aiUrl;
  CFG.aiModel = document.getElementById('ai-model').value.trim();
  CFG.aiAgent = document.getElementById('ai-agent').value.trim();
  try{ localStorage.setItem(SETTINGS_KEY, JSON.stringify(CFG)); }catch(e){}
  aiSession = null;   // URL/model may have changed — next draft opens a fresh session
  document.getElementById('ai-panel').style.display = 'none';
}

function toggleBatch(){
  if(aiBatch){   // acts as Cancel: stop after current section (spec §3)
    aiQueue.forEach(q => setDraftBtn(q, 'idle'));
    aiQueue.length = 0; aiBatch = null;
    updateBatchProgress(); return;
  }
  const targets = SECTIONS
    .filter(s => checked.has(s.n) && (ensureFillData(s), sectionPlaceholderCount(s.n) > 0))
    .map(s => s.n).filter(n => aiActive !== n && !aiQueue.includes(n));
  if(!targets.length){
    showAiBanner('No unfilled sections to draft. <button class="mini-btn" onclick="hideAiBanner()" style="float:right">✕</button>');
    return;
  }
  if(targets.some(n => sectionEdited(n)) &&
     !confirm('Some target sections have edits. Drafting replaces their content (one-level Undo per section). Continue?')) return;
  aiBatch = {total: targets.length};
  targets.forEach(n => { aiQueue.push(n); setDraftBtn(n, 'queued'); setAiErr(n, ''); });
  updateBatchProgress();
  processQueue();
}

function updateBatchProgress(){
  const btn = document.getElementById('ai-batch-btn');
  const el = document.getElementById('ai-batch-progress');
  if(!aiBatch){
    if(btn) btn.textContent = '✨ Draft unfilled';
    if(el) el.textContent = '';
    return;
  }
  const remaining = aiQueue.length + (aiActive ? 1 : 0);
  if(remaining === 0){
    aiBatch = null;
    if(btn) btn.textContent = '✨ Draft unfilled';
    if(el){ el.textContent = 'Batch done ✓'; el.className = 'fill-progress done'; }
    return;
  }
  if(btn) btn.textContent = '✕ Cancel batch';
  const done = aiBatch.total - remaining;
  const sec = aiActive ? SECTIONS.find(s => s.n === aiActive) : null;
  if(el){
    el.className = 'fill-progress';
    el.textContent = sec ? 'Drafting ' + sec.n + ' ' + sec.name + '… (' + (done + 1) + '/' + aiBatch.total + ')' : '';
  }
}
```

- [ ] **Step 3: Manual verify**

Mock running. Fill mode:
1. `AI settings` → panel opens with `http://127.0.0.1:4096` prefilled. Change URL to `http://127.0.0.1:5999`, Save. Click a `✨ Draft` → error + banner with launch command. Reopen panel, restore `:4096`, Save → Draft works (settings survive reload — check via reload + reopen panel).
2. Verify banner shows `--cors null` in the command when the page is opened via `file://`.

- [ ] **Step 4: Verify batch flow**

1. `Start over` → service name → scenario "Fullstack feature" → step 5 → Fill mode.
2. Click `✨ Draft unfilled` → button becomes `✕ Cancel batch`, progress shows `Drafting 01 … (1/N)`, sections fill one by one, ends with `Batch done ✓`.
3. Reset two sections, start batch, click `✕ Cancel batch` during first → queue cleared, current section finishes, drafts kept.
4. Restart mock as `node test/mock-opencode.js --fail500`, reset a section, start batch → banner `Batch stopped at section …: Server error (500)…`, queue cleared.

- [ ] **Step 5: Commit**

```bash
git add design-template-generator.html
git commit -m "feat: AI batch draft, cancel, settings panel, connection banner"
```

---

### Task 6: Full E2E checklist + real-server smoke test

**Files:**
- Modify (fixes only, if checklist fails): `design-template-generator.html`

- [ ] **Step 1: Run the full checklist against the mock** (spec §5)

| # | Check | Expected |
|---|---|---|
| 1 | Mock down, click Draft | Inline error + banner with exact `opencode serve --cors …` command |
| 2 | Mock up, Draft one section | Placeholders filled, badge `✓ ready`, output preview updates |
| 3 | Undo | Section reverts, badge restored |
| 4 | Draft over edited section | `confirm()` appears; Cancel leaves content untouched |
| 5 | Draft unfilled batch | Sequential, only placeholder-bearing sections, progress text correct |
| 6 | Cancel mid-batch | Stops after current; completed drafts kept |
| 7 | `--fail500` mock | Per-section error `Server error (500)…`; batch stops with banner |
| 8 | `--bad-md` mock | Error `Response didn't match section format…`; `fillData` untouched |
| 9 | Settings persist | Custom URL/model/agent survive reload |
| 10 | Export | Download .md contains drafted content; placeholders kept where mock left them |

- [ ] **Step 2: Smoke test against real opencode (if installed)**

```bash
cd /path/to/some/real/service/repo
opencode serve --port 4096 --cors null   # 'null' when opening the HTML via file://
```

Draft section 04 (System context) — verify content references real code, unverifiable cells stay `_placeholder_`. If the message endpoint rejects the request shape, check `http://127.0.0.1:4096/doc` for the exact `model`/`parts` schema and adjust `aiSendMessage` only.

- [ ] **Step 3: Commit any fixes**

```bash
git add design-template-generator.html
git commit -m "fix: AI draft E2E findings"
```
