// Every test here defends a decision *not* to report something. A linter that
// cries wolf gets turned off, and once it is off the real findings are gone too,
// so these matter as much as the rules themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, rules } from './helpers.mjs';

test('with no markup source, selector checks are skipped and said to be skipped', () => {
  const r = run({
    'theme.css': '.btn{color:red}\n#bar{display:block}',
    'app.js': "document.querySelector('.anything'); document.getElementById('whatever')",
  });
  assert.deepEqual(rules(r), [], 'nothing is judged');
  const skipped = r.skippedChecks.flatMap(s => s.checks);
  assert.ok(skipped.includes('missing-selector'), 'and the skip is reported');
  assert.ok(skipped.includes('missing-id'));
});

// A stylesheet naming `#bar` shows the name is known, not that anything renders
// it. Counting CSS as a DOM source reopens the hole the guard above closes.
test('CSS alone is not a DOM source', () => {
  const r = run({
    'theme.css': '#bd-theme{color:red}',
    'app.js': "document.querySelector('#bd-theme use')",
  });
  assert.deepEqual(rules(r), []);
});

test('with no CSS, variable and styling checks are skipped and said to be skipped', () => {
  const r = run({ 'app.html': '<div class="x"></div>' });
  const skipped = r.skippedChecks.flatMap(s => s.checks);
  assert.ok(skipped.includes('missing-css-var'));
});

// `--#{$prefix}gap: 0` means the real name is unknowable, so judging var()
// against the visible names reports an entire design system as undefined.
test('preprocessor interpolation disables the variable check', () => {
  const r = run({
    'app.html': '<div class="x"></div>',
    '_root.scss': ':root{ --#{$prefix}gap: 0; }',
    'app.scss': '.x{ gap: var(--bs-gap) }',
  });
  assert.deepEqual(rules(r), []);
  const s = r.skippedChecks.find(s => s.checks.includes('missing-css-var'));
  assert.ok(s, 'the skip is reported');
  assert.match(s.why, /interpolation/);
});

test('a dynamic selector is counted as not judged, never as a finding', () => {
  const r = run({
    'app.html': '<div class="x"></div>',
    'app.css': '.x{color:red}',
    'a.js': "document.querySelector('.' + name); document.querySelector(`#${id}`)",
  });
  assert.deepEqual(rules(r), []);
  assert.ok(r.stats.unresolvedLookups >= 2, `counted ${r.stats.unresolvedLookups}`);
});

test('a literal that is only one operand of an expression is not judged', () => {
  const r = run({
    'app.html': '<div class="x"></div>',
    'app.css': '.x{color:red}',
    'a.js': "document.getElementById('row-' + i)",
  });
  assert.deepEqual(rules(r), []);
  assert.equal(r.stats.unresolvedLookups, 1);
});

// `#` is not a name. Reporting it is the kind of noise that gets a tool deleted.
test('an empty or punctuation-only name is never reported', () => {
  const r = run({
    'app.html': '<div class="x"></div>',
    'app.css': '.x{color:red}',
    'a.js': "document.getElementById(''); document.querySelector('#'); document.querySelector('.')",
  });
  assert.deepEqual(rules(r), []);
});

test('a class name assigned to a constant is resolved at its creation site', () => {
  const r = run({
    'app.html': '<div class="x"></div>',
    'app.css': '.x{color:red}',
    'a.js': "const CLONE = 'item-clone';\nel.classList.add(CLONE);\n" +
            "document.querySelector('.item-clone')",
  });
  assert.deepEqual(rules(r), []);
});

// Guessing which value a reassigned name holds is worse than admitting we do not
// know - but the two sides of the question deserve opposite answers.
test('an ambiguous constant is not resolved at a lookup', () => {
  const r = run({
    'app.html': '<div class="x"></div>',
    'app.css': '.x{color:red}',
    'a.js': "let N = 'one';\nlet N = 'two';\ndocument.querySelector(N)",
  });
  assert.deepEqual(rules(r), [], 'an ambiguous lookup is not judged');
  assert.equal(r.stats.unresolvedLookups, 1, 'and it is counted as not judged');
});

test('an ambiguous constant contributes every candidate at a creation site', () => {
  // Being generous here can only suppress a false alarm; being strict would
  // report `.one` as uncreated when the code may well create it.
  const r = run({
    'app.html': '<div class="x"></div>',
    'app.css': '.x{color:red}',
    'a.js': "let N = 'one';\nlet N = 'two';\nel.classList.add(N);\n" +
            "document.querySelector('.one');\ndocument.querySelector('.two')",
  });
  assert.deepEqual(rules(r), []);
});

// The shape that let 134 false findings through on a stylesheet-only folder:
// a handful of classes created by JS is not evidence of what the DOM contains.
test('classes created by JS alone are not a markup source', () => {
  const r = run({
    'theme.css': '.btn{color:red}',
    'app.js': "el.classList.add('is-open');\ndocument.querySelector('.anything-at-all')",
  });
  assert.deepEqual(rules(r), [], 'nothing is judged');
  assert.ok(r.skippedChecks.flatMap(s => s.checks).includes('missing-selector'));
});

test('templated class attributes are counted as not judged', () => {
  const r = run({
    'app.html': '<div class="{{ cls }}"></div><div class="real"></div>',
    'app.css': '.real{color:red}',
  });
  assert.equal(r.stats.templatedAttrs, 1);
});

test('a comment that mentions a selector is not a reference', () => {
  const r = run({
    'app.html': '<div class="x"></div>',
    'app.css': '.x{color:red}',
    'a.js': "// document.querySelector('.ghost')\n/* document.getElementById('also-ghost') */",
  });
  assert.deepEqual(rules(r), []);
});

test('a selector-shaped string that is not passed to a lookup is ignored', () => {
  const r = run({
    'app.html': '<div class="x"></div>',
    'app.css': '.x{color:red}',
    'a.js': "const label = '.not-a-lookup'; log('#also-not')",
  });
  assert.deepEqual(rules(r), []);
});

test('script bodies that are not JavaScript are not scanned', () => {
  const r = run({
    'app.html': '<div class="x"></div>' +
      '<script type="text/template"><div class="tpl"></div>q.querySelector(".ghost")</script>',
    'app.css': '.x{color:red}',
  });
  assert.deepEqual(rules(r), []);
});

test('an external script tag contributes no code', () => {
  const r = run({
    'app.html': '<div class="x"></div><script src="vendor.js"></script>',
    'app.css': '.x{color:red}',
  });
  assert.deepEqual(rules(r), []);
});

test('files of unknown type are counted as skipped, not silently dropped', () => {
  const r = run({ 'app.html': '<div class="x"></div>', 'notes.txt': "querySelector('.ghost')" });
  assert.equal(r.stats.files.skipped, 1);
  assert.deepEqual(rules(r), []);
});

test('a suggestion is only offered when it is close enough to be a typo', () => {
  const near = run({
    'app.html': '<div class="sidebar"></div>',
    'app.css': '.sidebar{color:red}',
    'a.js': "document.querySelector('.sidbar')",
  });
  assert.equal(near.findings[0].suggestion, '.sidebar');

  const far = run({
    'app.html': '<div class="sidebar"></div>',
    'app.css': '.sidebar{color:red}',
    'a.js': "document.querySelector('.totally-unrelated-name')",
  });
  assert.equal(far.findings[0].suggestion, undefined);
});

// `.a` and `.b` are one edit apart and have nothing to do with each other.
test('short names do not get far-fetched suggestions', () => {
  const r = run({
    'app.html': '<div class="a"></div>',
    'app.css': '.a{color:red}',
    'a.js': "document.querySelector('.b')",
  });
  assert.equal(r.findings[0].suggestion, undefined);
});

test('--no-suggest turns suggestions off', () => {
  const r = run({
    'app.html': '<div class="sidebar"></div>',
    'app.css': '.sidebar{color:red}',
    'a.js': "document.querySelector('.sidbar')",
  }, { suggest: false });
  assert.equal(r.findings[0].suggestion, undefined);
});

test('ghostref-ignore suppresses its own line only', () => {
  const r = run({
    'app.html': '<div class="x"></div>',
    'app.css': '.x{color:red}',
    'a.js': "document.querySelector('.g1') // ghostref-ignore\ndocument.querySelector('.g2')",
  });
  assert.deepEqual(r.findings.map(f => f.line), [2]);
  assert.equal(r.stats.suppressed, 1);
});

test('ghostref-ignore-next-line suppresses the following line', () => {
  const r = run({
    'app.html': '<div class="x"></div>',
    'app.css': '.x{color:red}',
    'a.js': "// ghostref-ignore-next-line\ndocument.querySelector('.g1')\ndocument.querySelector('.g2')",
  });
  assert.deepEqual(r.findings.map(f => f.line), [3]);
});

test('naming a rule narrows the suppression to it', () => {
  const r = run({
    'app.html': '<div class="x"></div>',
    'app.css': '.x{color:red}',
    'a.js': "document.querySelector('.g1') // ghostref-ignore missing-id",
  });
  assert.deepEqual(rules(r), ['missing-selector'], 'a different rule is not silenced');
});

test('ghostref-disable silences a whole file', () => {
  const r = run({
    'app.html': '<div class="x"></div>',
    'app.css': '.x{color:red}',
    'a.js': "/* ghostref-disable */\ndocument.querySelector('.g1')\ndocument.querySelector('.g2')",
  });
  assert.deepEqual(rules(r), []);
  assert.equal(r.stats.suppressed, 2);
});

test('suppression in one file does not leak into another', () => {
  const r = run({
    'app.html': '<div class="x"></div>',
    'app.css': '.x{color:red}',
    'a.js': "/* ghostref-disable */\ndocument.querySelector('.g1')",
    'b.js': "document.querySelector('.g2')",
  });
  assert.deepEqual(r.findings.map(f => f.path), ['b.js']);
});

test('analyze on an empty file list does not throw', () => {
  const r = run({});
  assert.deepEqual(rules(r), []);
});

// `querySelector('.x')` returning null lets null flow onward, which is a bug.
// `classList.contains('x')` returning false is the normal answer to a normal
// question, and the class is routinely applied by a library or the server. The
// first deserves a finding; the second produced 63 false ones in htmx's tests.
test('classList.contains is not judged as a lookup', () => {
  const r = run({
    'app.html': '<div class="x"></div>',
    'app.css': '.x{color:red}',
    'a.js': "if (el.classList.contains('applied-by-some-library')) {}",
  });
  assert.deepEqual(rules(r), []);
});

test('but classList.contains still exempts a class from unstyled-class', () => {
  const files = {
    'app.html': '<div class="x"></div>',
    'app.css': '.x{color:red}',
    'a.js': "el.classList.add('flag'); if (el.classList.contains('flag')) {}",
  };
  const on = run(files, { rules: { 'unstyled-class': true } });
  assert.deepEqual(rules(on), [], 'a class that is asked about is a state flag');
});

test('className assignment creates a class without being judged', () => {
  const r = run({
    'app.html': '<div class="x"></div>',
    'app.css': '.x{color:red}',
    'a.js': "el.className = 'written-only'",
  });
  assert.deepEqual(rules(r), []);
});

test('querySelector is still judged, so the distinction has teeth', () => {
  const r = run({
    'app.html': '<div class="x"></div>',
    'app.css': '.x{color:red}',
    'a.js': "document.querySelector('.applied-by-some-library')",
  });
  assert.deepEqual(rules(r), ['missing-selector']);
});
