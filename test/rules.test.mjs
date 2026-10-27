// ghostref-disable missing-css-var
// The CSS in this file is fixture text inside JS strings. ghostref cannot
// tell a fixture from markup a page really builds, and it is right not to
// try - so the honest move is to say so here rather than weaken the rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, rules, mentions } from '../tools/testing.mjs';

const CSS = { 'app.css': ':root{--line:#ddd}\n.box{color:red}\n#main{display:block}' };
const HTML = { 'app.html': '<div class="box" id="main"></div>' };

test('missing-selector: a queried class nobody creates', () => {
  const r = run({ ...HTML, ...CSS, 'a.js': "document.querySelector('.bax')" });
  assert.deepEqual(rules(r), ['missing-selector']);
  assert.ok(mentions(r, '.box'), 'suggests the near name');
});

test('missing-selector: a class that exists is not reported', () => {
  const r = run({ ...HTML, ...CSS, 'a.js': "document.querySelector('.box')" });
  assert.deepEqual(rules(r), []);
});

test('missing-id: a looked-up id nobody creates', () => {
  const r = run({ ...HTML, ...CSS, 'a.js': "document.getElementById('mian')" });
  assert.deepEqual(rules(r), ['missing-id']);
  assert.ok(mentions(r, '#main'));
});

test('missing-id: an id that exists is not reported', () => {
  const r = run({ ...HTML, ...CSS, 'a.js': "document.getElementById('main')" });
  assert.deepEqual(rules(r), []);
});

test('missing-css-var: var() with no definition', () => {
  const r = run({ ...HTML, 'app.css': ':root{--line:#ddd}\n.box{border-color:var(--lien)}' });
  assert.deepEqual(rules(r), ['missing-css-var']);
  assert.ok(mentions(r, 'var(--line)'));
});

test('missing-css-var: a defined property is not reported', () => {
  const r = run({ ...HTML, 'app.css': ':root{--line:#ddd}\n.box{border-color:var(--line)}' });
  assert.deepEqual(rules(r), []);
});

// `var(--x, 8px)` says in the source that absence was planned for.
test('missing-css-var: an explicit fallback is respected', () => {
  const r = run({ ...HTML, 'app.css': '.box{gap:var(--gap, 8px)}\n:root{--line:red}' });
  assert.deepEqual(rules(r), []);
});

test('a definition in another file still counts', () => {
  const r = run({
    ...HTML,
    'tokens.css': ':root{--line:#ddd}',
    'app.css': '.box{border-color:var(--line)}',
  });
  assert.deepEqual(rules(r), []);
});

test('var() inside an inline style attribute is honoured as a definition', () => {
  const r = run({
    'app.html': '<div class="box" style="--gap: 8px"></div>',
    'app.css': '.box{padding:var(--gap)}',
  });
  assert.deepEqual(rules(r), []);
});

test('selectors in CSS prove a name is intended, so lookups are not flagged', () => {
  // `.panel` is styled but never rendered in this snapshot. That is a dead rule,
  // not a broken lookup, and the two deserve different severities.
  const r = run({
    ...HTML,
    'app.css': '.box{color:red}\n.panel{padding:1px}',
    'a.js': "document.querySelector('.panel')",
  });
  assert.deepEqual(rules(r), []);
});

test('dead-css-class fires only when asked for', () => {
  const files = { ...HTML, 'app.css': '.box{color:red}\n.panel{padding:1px}' };
  assert.deepEqual(rules(run(files)), []);
  const on = run(files, { rules: { 'dead-css-class': true } });
  assert.deepEqual(rules(on), ['dead-css-class']);
});

test('unstyled-class fires only when asked for, and skips state flags', () => {
  const files = {
    ...HTML,
    'app.css': '.box{color:red}',
    'a.js': "el.classList.add('is-open'); el.classList.contains('is-open'); el.classList.add('plain-paint')",
  };
  const on = run(files, { rules: { 'unstyled-class': true } });
  // `is-open` is read back, so it is a flag; `plain-paint` is only ever written.
  assert.deepEqual(rules(on), ['unstyled-class']);
  assert.ok(mentions(on, '.plain-paint'));
});

test('classList and className create classes', () => {
  const r = run({
    ...HTML, ...CSS,
    'a.js': "el.classList.add('fresh'); other.className = 'made';\n" +
            "document.querySelector('.fresh'); document.querySelector('.made')",
  });
  assert.deepEqual(rules(r), []);
});

test('markup built in a string literal creates its classes', () => {
  const r = run({
    ...HTML, ...CSS,
    'a.js': `box.innerHTML = '<span class="from-js" id="js-id">x</span>';
             document.querySelector('.from-js'); document.getElementById('js-id')`,
  });
  assert.deepEqual(rules(r), []);
});

// The shape every test fixture and every template helper uses.
test('markup in an interpolated template creates its classes', () => {
  const r = run({
    ...HTML, ...CSS,
    'a.js': 'box.innerHTML = `<div class="row">${body}</div>`;\n' +
            "document.querySelector('.row')",
  });
  assert.deepEqual(rules(r), []);
});

test('JSX className creates classes', () => {
  const r = run({
    'App.jsx': 'export default () => <div className="card" id="root" />;',
    'app.css': '.card{color:red}',
    'a.js': "document.querySelector('.card'); document.getElementById('root')",
  });
  assert.deepEqual(rules(r), []);
});

test('setAttribute creates classes and ids', () => {
  const r = run({
    ...HTML, ...CSS,
    'a.js': "el.setAttribute('class','attr-made'); el.setAttribute('id','attr-id');\n" +
            "document.querySelector('.attr-made'); document.getElementById('attr-id')",
  });
  assert.deepEqual(rules(r), []);
});

test('setProperty defines a custom property', () => {
  const r = run({
    ...HTML,
    'app.css': '.box{gap:var(--runtime)}',
    'a.js': "el.style.setProperty('--runtime','4px')",
  });
  assert.deepEqual(rules(r), []);
});

test('closest and matches are checked too', () => {
  const r = run({ ...HTML, ...CSS, 'a.js': "el.closest('.nope'); el.matches('.box')" });
  assert.deepEqual(rules(r), ['missing-selector']);
});

test('compound selectors are decomposed', () => {
  const r = run({ ...HTML, ...CSS, 'a.js': "document.querySelector('.box > .inner')" });
  assert.deepEqual(rules(r), ['missing-selector']);
  assert.ok(mentions(r, '.inner'));
});

test('attribute and pseudo parts are not read as names', () => {
  const r = run({
    ...HTML, ...CSS,
    'a.js': `document.querySelectorAll('.box[data-x="y"]:not(.box):nth-child(2)')`,
  });
  assert.deepEqual(rules(r), []);
});

test('@media blocks are read for both definitions and selectors', () => {
  const r = run({
    'app.html': '<div class="wide"></div>',
    'app.css': '@media (min-width: 40em){ :root{--pad:2px} .wide{padding:var(--pad)} }',
  });
  assert.deepEqual(rules(r), []);
});

test('keyframe steps are not treated as selectors', () => {
  const r = run({
    'app.html': '<div class="spin"></div>',
    'app.css': '@keyframes turn{from{opacity:0}to{opacity:1}}\n.spin{animation:turn 1s}',
  }, { rules: { 'dead-css-class': true } });
  assert.deepEqual(rules(r), []);
});

test('findings are sorted by path then line', () => {
  const r = run({
    'b.html': '<div class="ok"></div>',
    'app.css': '.ok{color:red}',
    'a.js': "document.querySelector('.z1')\ndocument.querySelector('.z2')",
    'z.js': "document.querySelector('.z3')",
  });
  assert.deepEqual(r.findings.map(f => `${f.path}:${f.line}`), ['a.js:1', 'a.js:2', 'z.js:1']);
});
