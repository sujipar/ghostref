import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskJs, maskCss, lineIndex, offsetToLine } from '../src/tokenize.mjs';

test('masking keeps the string length so offsets stay valid', () => {
  const src = '/* comment */ const a = "value";';
  const { masked } = maskJs(src);
  assert.equal(masked.length, src.length);
});

test('newlines survive masking so line numbers stay right', () => {
  const { masked } = maskJs('/* a\nb\nc */\nx');
  assert.equal(masked.split('\n').length, 4);
});

test('line comments are removed', () => {
  const { masked } = maskJs("a // querySelector('.ghost')\nb");
  assert.ok(!masked.includes('ghost'));
  assert.ok(masked.includes('a'));
});

test('block comments are removed', () => {
  const { masked } = maskJs("/* querySelector('.ghost') */ real");
  assert.ok(!masked.includes('ghost'));
  assert.ok(masked.includes('real'));
});

test('string bodies are removed but collected', () => {
  const { masked, strings } = maskJs(`fn('.one', "#two")`);
  assert.ok(!masked.includes('one'));
  assert.deepEqual(strings.map(s => s.value), ['.one', '#two']);
});

test('a regex literal is not read as code', () => {
  const { masked } = maskJs('/ghost/.test(x)');
  assert.ok(!masked.includes('ghost'));
});

test('division is not mistaken for a regex', () => {
  const { masked } = maskJs('const r = a / b; const c = 1 / 2;');
  assert.ok(masked.includes('a / b'), masked);
  assert.ok(masked.includes('1 / 2'), masked);
});

test('a keyword before a slash means regex, an identifier means division', () => {
  assert.ok(!maskJs('return /abc/.test(s)').masked.includes('abc'));
  assert.ok(maskJs('x = total / count').masked.includes('total / count'));
});

test('template literals without interpolation count as strings', () => {
  const { strings } = maskJs('q(`.three`)');
  assert.deepEqual(strings.map(s => s.value), ['.three']);
});

test('interpolated templates are not strings but are kept as templates', () => {
  const { strings, templates } = maskJs('q(`.a${v}b`)');
  assert.equal(strings.length, 0);
  assert.deepEqual(templates.map(t => t.value), ['.a${v}b']);
});

test('code inside ${} is still code', () => {
  const { masked } = maskJs('x = `a ${ findIt } b`');
  assert.ok(masked.includes('findIt'));
});

test('a nested template does not break the scan that follows it', () => {
  const src = 'x = `a ${ c ? `<b>${v}</b>` : "" } z`;\nfn("after");';
  const { masked, strings } = maskJs(src);
  assert.ok(masked.includes('fn('), masked);
  assert.ok(strings.some(s => s.value === 'after'));
});

test('braces inside a regex inside ${} do not unbalance the scan', () => {
  const src = 'x = `${ s.replace(/\\{\\d+\\}/g, "") }`;\nfn("after");';
  const { strings } = maskJs(src);
  assert.ok(strings.some(s => s.value === 'after'));
});

// This is the bug that cost 97% of findings on a real 400 KB file: `[...src]`
// splits by code point, so one emoji shifts every later index by one.
test('offsets stay correct after an astral character', () => {
  const src = 'const icon = "\u{1F512}";\nfn("after-emoji");';
  const { masked, strings } = maskJs(src);
  assert.equal(masked.length, src.length);
  const lit = strings.find(s => s.value === 'after-emoji');
  assert.ok(lit, 'literal after the emoji was collected');
  assert.equal(src.slice(lit.start, lit.end), 'after-emoji');
});

test('many astral characters do not accumulate drift', () => {
  const src = '// \u{1F512}\u{1F4C4}\u{1F50D}\u{1F310}\u{1F91D}\n'.repeat(40) + 'fn("tail");';
  const { strings } = maskJs(src);
  const lit = strings.find(s => s.value === 'tail');
  assert.ok(lit);
  assert.equal(src.slice(lit.start, lit.end), 'tail');
});

test('css comments and strings are masked', () => {
  const { masked } = maskCss(`.a{/* .ghost */ color:red} .b{content:"ghost"}`);
  assert.ok(!masked.includes('ghost'));
});

test('offsetToLine is 1-based and exact', () => {
  const src = 'a\nb\nquerySelector(".x")';
  const idx = lineIndex(src);
  assert.equal(offsetToLine(idx, 0), 1);
  assert.equal(offsetToLine(idx, src.indexOf('querySelector')), 3);
});

test('an unterminated string does not swallow the rest of the file', () => {
  const { masked } = maskJs("a = 'oops\nfn(\"later\")");
  assert.ok(masked.includes('fn('), masked);
});
