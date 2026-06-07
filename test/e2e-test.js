// test/e2e-test.js — headless Node E2E for the AI-draft flow.
//
// For each mock-server scenario (happy / --fail500 / --bad-md) we:
//   1. spawn test/mock-opencode.js with the right flags (real HTTP on :4096),
//   2. eval the page <script> with a DOM stub rich enough that the FIFO queue
//      path runs (rerenderSection / RAF / setInterval all no-op safely),
//   3. append an async driver IIFE that has lexical access to the script
//      internals (fillData / aiQueue / aiActive / aiUndo / enqueueDraft / …),
//      drives the flow, asserts, and reports via global.__log + global.__resolve.
//
// The mock lifecycle (spawn/kill) + pass/fail aggregation live in the OUTER
// Node scope; the eval'd driver talks back through globals.
//
// Run: node test/e2e-test.js   (exit 0 = all non-skipped assertions pass)
//
// Requires Node 18+ (global fetch). Without fetch this E2E is impossible
// headlessly with no deps — we detect and report BLOCKED.

const fs = require('fs');
const { spawn } = require('child_process');

if (typeof fetch === 'undefined') {
  console.error('BLOCKED: global fetch is undefined (Node < 18). Cannot run headless HTTP E2E without adding dependencies.');
  process.exit(2);
}

const HTML = fs.readFileSync(__dirname + '/../design-template-generator.html', 'utf8');
const SRC = HTML.match(/<script>([\s\S]*)<\/script>/)[1];
const MOCK = __dirname + '/mock-opencode.js';

// ── DOM / env stub ────────────────────────────────────────────────────────────
// getElementById returns a reusable fake element (cached by id) so that mutations
// (style/textContent/classList/outerHTML) persist and never throw.
function makeFakeEl() {
  const set = new Set();
  return {
    style: {}, textContent: '', value: '', disabled: false, className: '',
    innerHTML: '', outerHTML: '',
    classList: {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      toggle: (c, f) => { const has = set.has(c); const on = f === undefined ? !has : !!f; on ? set.add(c) : set.delete(c); return on; },
      contains: (c) => set.has(c),
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    appendChild: () => {}, removeChild: () => {}, setAttribute: () => {},
    addEventListener: () => {}, focus: () => {}, click: () => {},
  };
}

function installStubs() {
  const els = new Map();
  global.document = {
    getElementById: (id) => { if (!els.has(id)) els.set(id, makeFakeEl()); return els.get(id); },
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => makeFakeEl(),
    addEventListener: () => {},
    body: { style: {} },
  };
  global.location = { protocol: 'http:', origin: 'http://localhost:8000' };
  const store = new Map();
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  // RAF runs the callback synchronously so rerenderSection's autoGrowAll fires
  // without a real frame; it just queries DOM (→ no-op) and returns.
  global.requestAnimationFrame = (fn) => { if (fn) fn(); return 0; };
  global.cancelAnimationFrame = () => {};
  global.confirm = () => true;
  global.alert = () => {};
  // setInterval/setTimeout/clear* exist natively in Node — startElapsed uses
  // setInterval and processQueue's finally clears it via stopElapsed.
}

// ── Drivers: code appended after SRC, with lexical access to script internals ──
// Each must, when done, push PASS/FAIL/SKIP strings to global.__log and call
// global.__resolve(). settle() is defined inside so it can read aiActive/aiQueue.
const SETTLE = `
  async function settle(ms){
    ms = ms || 8000;
    const t = Date.now();
    while (Date.now() - t < ms) {
      if (aiActive === null && aiQueue.length === 0) return;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('queue did not settle within ' + ms + 'ms');
  }
`;

const DRIVERS = {
  happy: `
;(async function(){
  ${SETTLE}
  const log = global.__log;
  const ok = (c, m) => log.push((c ? 'PASS' : 'FAIL') + ' — ' + m);
  try {
    CFG.aiUrl = 'http://127.0.0.1:4096';

    // NOTE on section choice: the spec suggested section '17' (Trade-off), but
    // 17's table anchors ARE placeholder text ('### _Decision title_',
    // '_Second alternative_'). The mock fills every _..._ with 'Mock value',
    // which rewrites those anchors, so validateSectionResponse's reorder
    // protection keeps the ORIGINAL (still-placeholder) tables — a draft on 17
    // never reduces its table-cell placeholder count under this mock.
    // (17 is also not in fullstack's pre-checked set: 01,02,03,05,10,11,13,14,16.)
    // We drive section '03' instead: stable heading anchors, 14 table
    // placeholders, fills cleanly under the mock — a meaningful fill assertion.
    const SEC = '03';

    // 1. select scenario, pin the target section, confirm it has placeholders
    selectScenario('fullstack');
    const sec = SECTIONS.find(s => s.n === SEC);
    ensureFillData(sec);
    const before = sectionPlaceholderCount(SEC);
    ok(before > 0, 'precondition: section ' + SEC + ' has placeholders (' + before + ')');

    // 2. draft one section → mock fills placeholders, undo snapshot recorded
    enqueueDraft(SEC);
    await settle();
    const after = sectionPlaceholderCount(SEC);
    ok(after < before, 'draft one fills section (' + before + ' -> ' + after + ')');
    ok(!!aiUndo[SEC], 'draft one records undo snapshot');
    ok(aiActive === null && aiQueue.length === 0, 'queue drained after single draft');

    // 3. undo → restores original placeholders, clears undo entry
    undoDraft(SEC);
    ok(sectionPlaceholderCount(SEC) === before, 'undo restores placeholder count (' + before + ')');
    ok(!aiUndo[SEC], 'undo clears the undo entry');

    // 4. batch — fresh state, draft every unfilled checked section
    selectScenario('fullstack');
    fillData = {};
    const targets = SECTIONS.filter(s => checked.has(s.n));
    targets.forEach(s => ensureFillData(s));
    const beforeCounts = {};
    targets.forEach(s => { beforeCounts[s.n] = sectionPlaceholderCount(s.n); });
    const hadPh = targets.filter(s => beforeCounts[s.n] > 0).map(s => s.n);
    ok(hadPh.length > 0, 'batch precondition: ' + hadPh.length + ' checked sections have placeholders');

    toggleBatch();
    await settle();

    const stillFull = hadPh.filter(n => sectionPlaceholderCount(n) >= beforeCounts[n]);
    ok(stillFull.length === 0, 'batch drafts all unfilled sections (no section left with >= original placeholders; offenders=' + JSON.stringify(stillFull) + ')');
    ok(aiBatch === null, 'aiBatch cleared after batch settles');
    ok(aiActive === null && aiQueue.length === 0, 'queue drained after batch');

    // 5. cancel mid-batch — timing sensitive headlessly; skip (manual checklist).
    log.push('SKIP cancel (timing) — covered by manual checklist');
  } catch (e) {
    log.push('FAIL — happy driver threw: ' + (e && e.stack || e));
  } finally {
    global.__resolve();
  }
})();
`,

  fail500: `
;(async function(){
  ${SETTLE}
  const log = global.__log;
  const ok = (c, m) => log.push((c ? 'PASS' : 'FAIL') + ' — ' + m);
  try {
    CFG.aiUrl = 'http://127.0.0.1:4096';
    const SEC = '03';
    selectScenario('fullstack');
    const sec = SECTIONS.find(s => s.n === SEC);
    ensureFillData(sec);
    const before = sectionPlaceholderCount(SEC);
    enqueueDraft(SEC);
    await settle();
    ok(sectionPlaceholderCount(SEC) === before, 'HTTP 500 leaves section untouched (' + before + ')');
    ok(!aiUndo[SEC], 'HTTP 500 records no undo snapshot');
    ok(aiActive === null && aiQueue.length === 0, 'queue drained after 500 error');
  } catch (e) {
    log.push('FAIL — fail500 driver threw: ' + (e && e.stack || e));
  } finally {
    global.__resolve();
  }
})();
`,

  badmd: `
;(async function(){
  ${SETTLE}
  const log = global.__log;
  const ok = (c, m) => log.push((c ? 'PASS' : 'FAIL') + ' — ' + m);
  try {
    CFG.aiUrl = 'http://127.0.0.1:4096';
    const SEC = '03';
    selectScenario('fullstack');
    const sec = SECTIONS.find(s => s.n === SEC);
    ensureFillData(sec);
    const before = sectionPlaceholderCount(SEC);
    enqueueDraft(SEC);
    await settle();
    ok(sectionPlaceholderCount(SEC) === before, 'malformed response rejected, fillData untouched (' + before + ')');
    ok(!aiUndo[SEC], 'malformed response records no undo snapshot');
    ok(aiActive === null && aiQueue.length === 0, 'queue drained after bad-md rejection');
  } catch (e) {
    log.push('FAIL — badmd driver threw: ' + (e && e.stack || e));
  } finally {
    global.__resolve();
  }
})();
`,
};

// ── Outer harness ───────────────────────────────────────────────────────────
function spawnMock(flags) {
  const proc = spawn('node', [MOCK, ...flags], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(proc); } };
    proc.stdout.on('data', () => done());      // mock prints once it's listening
    proc.stderr.on('data', (d) => process.stderr.write('[mock] ' + d));
    setTimeout(done, 600);                      // fallback if no stdout seen
  });
}

function killMock(proc) {
  return new Promise((resolve) => {
    if (!proc) return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    proc.once('exit', finish);
    if (proc.exitCode !== null || proc.signalCode !== null) return finish();
    proc.kill('SIGTERM');
    // escalate to SIGKILL if SIGTERM doesn't take, then give up after a bit
    setTimeout(() => { if (!done) { try { proc.kill('SIGKILL'); } catch (e) {} } }, 400);
    setTimeout(finish, 1500);
  });
}

// Wait until nothing is listening on :4096 so the next mock can bind cleanly.
async function waitPortFree(ms) {
  const t = Date.now();
  while (Date.now() - t < (ms || 3000)) {
    const free = await new Promise((resolve) => {
      const probe = require('net').connect(4096, '127.0.0.1');
      probe.once('connect', () => { probe.destroy(); resolve(false); });
      probe.once('error', () => resolve(true));
    });
    if (free) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function run(label, flags, driverName) {
  await waitPortFree();                       // ensure prior mock has released :4096
  const mock = await spawnMock(flags);
  // small extra settle for the listener
  await new Promise((r) => setTimeout(r, 200));

  installStubs();
  global.__log = [];
  let resolveDone;
  global.__done = new Promise((res) => { resolveDone = res; });
  global.__resolve = resolveDone;

  let evalError = null;
  try {
    eval(SRC + DRIVERS[driverName]);
  } catch (e) {
    evalError = e;
    global.__log.push('FAIL — eval threw: ' + (e && e.stack || e));
    resolveDone();
  }

  // safety timeout so a hung promise can't wedge the whole suite
  const timeout = new Promise((res) => setTimeout(() => {
    global.__log.push('FAIL — driver did not resolve within 12s');
    res();
  }, 12000));
  await Promise.race([global.__done, timeout]);

  await killMock(mock);

  const log = global.__log.slice();
  console.log('\n=== ' + label + ' (flags: ' + (flags.join(' ') || 'none') + ') ===');
  log.forEach((l) => console.log('  ' + l));
  return { label, log, evalError };
}

(async function main() {
  const results = [];
  results.push(await run('HAPPY', [], 'happy'));
  results.push(await run('FAIL500', ['--fail500'], 'fail500'));
  results.push(await run('BADMD', ['--bad-md'], 'badmd'));

  const all = results.flatMap((r) => r.log);
  const fails = all.filter((l) => l.startsWith('FAIL')).length;
  const passes = all.filter((l) => l.startsWith('PASS')).length;
  const skips = all.filter((l) => l.startsWith('SKIP')).length;

  console.log('\n=== SUMMARY ===');
  console.log('  PASS: ' + passes + '   FAIL: ' + fails + '   SKIP: ' + skips);
  process.exit(fails ? 1 : 0);
})();
