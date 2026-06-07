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
  const mangled = validateSectionResponse('17', tpl.replace(/^\\|.*\\|$/m, '| Only | Two |'));
  ok(mangled.ok === true && mangled.blocks.some(b => b.type === 'table'), 'mangled table falls back to original');
  const empty = validateSectionResponse('17', '');
  ok(empty.ok === false, 'empty response rejected');

  process.exit(fails ? 1 : 0);
})();
`;
eval(src + assertions);
