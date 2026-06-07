// test/helpers-test.js — Node assertions for the AI-draft pure helpers.
// The page script is evaluated with DOM stubs; assertions are appended into the
// same eval so const/let bindings (SECTIONS, fillData, …) are in scope.
// Run: node test/helpers-test.js   (exit 0 = all pass)
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../design-template-generator.html', 'utf8');
const src = html.match(/<script>([\s\S]*)<\/script>/)[1];

global.document = {getElementById: () => null, querySelectorAll: () => [], addEventListener: () => {}, body: {style: {}}};
global.location = {protocol: 'http:', origin: 'http://localhost:8000'};
global.localStorage = {getItem: () => null, setItem: () => {}, removeItem: () => {}};
global.requestAnimationFrame = () => {};
global.confirm = () => true;
global.alert = () => {};

const assertions = `
;(function(){
  let fails = 0;
  const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' — ' + m); if(!c) fails++; };

  ok(typeof aiCfg === 'function', 'aiCfg defined');
  ok(aiCfg().url === 'http://127.0.0.1:4096', 'aiCfg default url');

  ok(stripWrappingFence('\\\`\\\`\\\`md\\n## X\\n\\\`\\\`\\\`') === '## X', 'stripWrappingFence strips fence');
  ok(stripWrappingFence('## X') === '## X', 'stripWrappingFence passthrough');

  ok(extractResponseText([{type:'text',text:'a'},{type:'tool'},{type:'text',text:'b'}]) === 'a\\nb', 'extractResponseText joins text parts');

  const p = buildSectionPrompt('17');
  ok(p.includes('## Current section markdown') && p.includes('## Output contract'), 'buildSectionPrompt has frame');
  ok(p.includes('Trade-off'), 'buildSectionPrompt includes section content');

  const ex = guideRulesExcerpt('17');
  ok(typeof ex === 'string' && !/worked example/i.test(ex.split('\\n').filter(l=>/^#{2,4}\\s/.test(l)).join('\\n')), 'guideRulesExcerpt excludes worked-example heading');
  ok(ex.length <= 4000, 'guideRulesExcerpt capped at 4000');

  const tpl = serializeBlocks(fillData['17']);
  const good = validateSectionResponse('17', tpl.replace(/_[^_\\n|]+_/g, 'Filled'));
  ok(good.ok === true, 'validateSectionResponse accepts same-shape response');
  const bad = validateSectionResponse('17', '## Wrong heading\\n\\ntext');
  ok(bad.ok === false, 'validateSectionResponse rejects wrong heading');
  const empty = validateSectionResponse('17', '');
  ok(empty.ok === false, 'empty response rejected');

  // ── Section 13: two tables share the column|type|description|constraints sig ──
  ensureFillData(SECTIONS.find(s => s.n === '13'));
  const anc13 = tableAnchors(fillData['13']);
  ok(anc13[0] !== anc13[1] && anc13[0] && anc13[1], 'tableAnchors distinguishes section 13 entity tables');

  const tpl13 = serializeBlocks(fillData['13']);
  const good13 = validateSectionResponse('13', tpl13.replace(/_[^_\\n|]+_/g, 'Filled'));
  ok(good13.ok === true && !good13.warning, 'section 13 same-shape response accepted without warning');
  ok(good13.blocks.filter(b => b.type === 'table').length === fillData['13'].filter(b => b.type === 'table').length, 'section 13 keeps all tables');

  // Reorder: swap the two entity sections (bold label travels with its table),
  // headings stay present but the two same-sig tables appear in swapped order.
  const rb = parseMarkdownBlocks(tpl13).map(b => JSON.parse(JSON.stringify(b)));
  const ti = rb.map((b, i) => b.type === 'table' ? i : -1).filter(i => i >= 0);
  const ta = ti[0], tb = ti[1];
  const tmp = rb[ta]; rb[ta] = rb[tb]; rb[tb] = tmp;
  // swap the two bold entity labels in the text blocks immediately above each table
  const li = ti.map(t => { for(let i = t - 1; i >= 0; i--) if(rb[i].type === 'text' && /\\*\\*.+?\\*\\*/.test(rb[i].value)) return i; return -1; });
  const l0 = rb[li[0]].value.match(/\\*\\*.+?\\*\\*.*/)[0];
  const l1 = rb[li[1]].value.match(/\\*\\*.+?\\*\\*.*/)[0];
  rb[li[0]].value = rb[li[0]].value.replace(l0, l1);
  rb[li[1]].value = rb[li[1]].value.replace(l1, l0);
  const swapped = validateSectionResponse('13', serializeBlocks(rb));
  ok(swapped.ok === true && !!swapped.warning, 'section 13 reordered tables → ok with warning');
  const orig13 = fillData['13'].filter(b => b.type === 'table');
  const m13 = swapped.blocks.filter(b => b.type === 'table');
  ok(m13[0].rows[1][0] === orig13[0].rows[1][0] && m13[1].rows[0][0] === orig13[1].rows[0][0], 'section 13 reorder keeps ORIGINAL tables (no silent merge)');

  // Preamble: chatter before the heading is stripped from merged content.
  const pre = validateSectionResponse('13', 'Some preamble chatter\\n\\n' + tpl13.replace(/_[^_\\n|]+_/g, 'Filled'));
  ok(pre.ok === true && pre.blocks.find(b => b.type === 'text').value.startsWith('##'), 'preamble stripped — first merged text block starts with ##');

  process.exit(fails ? 1 : 0);
})();
`;
eval(src + assertions);
