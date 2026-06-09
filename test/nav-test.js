// test/nav-test.js — Node assertions for step-1 → step-2 wizard navigation.
//
// Regression for the "Next does nothing" report: when the Service name field is
// empty, goToStep() must (a) hold on step 1 AND (b) surface VISIBLE feedback —
// not silently move focus. The page is self-contained (zero network), so a
// blocked corporate network cannot affect this; the silent gate was the cause.
//
// Run: node test/nav-test.js   (exit 0 = all pass)
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/../design-template-generator.html', 'utf8');
const src = html.match(/<script>([\s\S]*)<\/script>/)[1];

// Minimal DOM stub: a registry of fake elements keyed by id.
function fakeEl(id) {
  const cls = new Set();
  return {
    id, value: '', innerHTML: '', textContent: '', _focused: false,
    focus() { this._focused = true; },
    classList: {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      toggle: (c, f) => (f === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : (f ? cls.add(c) : cls.delete(c))),
      contains: (c) => cls.has(c),
    },
  };
}
const REG = {};
const el = (id) => (REG[id] || (REG[id] = fakeEl(id)));

global.document = {
  getElementById: (id) => el(id),
  querySelectorAll: () => [],
  addEventListener: () => {},
  body: { style: {} },
};
global.location = { protocol: 'file:', origin: 'null' };
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.requestAnimationFrame = () => {};
global.confirm = () => true;
global.alert = () => {};

const assertions = `
;(function(){
  let fails = 0;
  const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' — ' + m); if(!c) fails++; };

  // --- empty Service name: clicking "Next: tech stack" must NOT advance ---
  document.getElementById('svc-name').value = '';
  currentStep = 1;
  goToStep(2);
  ok(currentStep === 1, 'empty name: stays on step 1');
  ok(document.getElementById('svc-name').classList.contains('input-err'), 'empty name: field gets error highlight');
  ok(document.getElementById('svc-name-err').classList.contains('show'), 'empty name: inline error message is shown');

  // --- filling the name then editing clears the error and lets nav proceed ---
  document.getElementById('svc-name').value = 'Order Service';
  if (typeof clearSvcErr === 'function') clearSvcErr();
  ok(!document.getElementById('svc-name').classList.contains('input-err'), 'after input: error highlight cleared');
  ok(!document.getElementById('svc-name-err').classList.contains('show'), 'after input: error message hidden');
  goToStep(2);
  ok(currentStep === 2, 'filled name: advances to step 2');

  console.log(fails ? ('\\n' + fails + ' FAILED') : '\\nALL PASS');
  if (fails) { global.__navFail = fails; }
})();
`;

eval(src + assertions);
process.exit(global.__navFail ? 1 : 0);
