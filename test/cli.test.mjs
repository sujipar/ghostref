// End-to-end: the binary a user actually runs. Unit tests can all pass while
// argument parsing, file walking or the exit code is broken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'bin', 'ghostref.mjs');
const SAMPLE = join(here, 'sample');

function cli(args, { expectFail = false } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.ok(!expectFail, 'expected a non-zero exit but it succeeded');
    return { stdout, code: 0 };
  } catch (err) {
    // A thrown error with no status means the process never ran; treating that
    // as "exit code non-zero" would hide a broken invocation.
    assert.notEqual(err.status, undefined, `the binary did not run: ${err.message}`);
    assert.ok(expectFail, `unexpected exit ${err.status}\n${err.stdout}\n${err.stderr}`);
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.status };
  }
}

test('--version prints a version', () => {
  assert.match(cli(['--version']).stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('--help lists every rule', () => {
  const { stdout } = cli(['--help']);
  for (const r of ['missing-selector', 'missing-id', 'missing-css-var',
                   'unstyled-class', 'dead-css-class', 'dead-css-var']) {
    assert.ok(stdout.includes(r), `help mentions ${r}`);
  }
});

test('the sample finds exactly its three planted bugs and exits 1', () => {
  const { stdout, code } = cli([SAMPLE], { expectFail: true });
  assert.equal(code, 1);
  assert.ok(stdout.includes('.card-titel'), stdout);
  assert.ok(stdout.includes('#counter'), stdout);
  assert.ok(stdout.includes('--lien'), stdout);
  assert.ok(stdout.includes('3 findings'), stdout);
});

test('the sample suggests the names that were meant', () => {
  const { stdout } = cli([SAMPLE], { expectFail: true });
  assert.ok(stdout.includes('.card-title'), 'suggests .card-title');
  assert.ok(stdout.includes('#count'), 'suggests #count');
  assert.ok(stdout.includes('var(--line)'), 'suggests var(--line)');
});

test('--no-exit-code reports the same findings but exits 0', () => {
  const { stdout, code } = cli([SAMPLE, '--no-exit-code']);
  assert.equal(code, 0);
  assert.ok(stdout.includes('3 findings'));
});

test('--json is parseable and carries stats', () => {
  const { stdout } = cli([SAMPLE, '--json', '--no-exit-code']);
  const j = JSON.parse(stdout);
  assert.equal(j.findings.length, 3);
  assert.ok(j.stats.lookups > 0);
  for (const f of j.findings) {
    assert.ok(f.rule && f.severity && f.path && typeof f.line === 'number' && f.message);
  }
});

test('--quiet drops the summary but keeps the findings', () => {
  const { stdout } = cli([SAMPLE, '--quiet', '--no-exit-code']);
  assert.ok(stdout.includes('.card-titel'));
  assert.ok(!stdout.includes('findings'), stdout);
});

test('--no-rule silences a rule', () => {
  const { stdout } = cli([SAMPLE, '--no-rule', 'missing-css-var', '--no-exit-code']);
  assert.ok(!stdout.includes('--lien'), stdout);
  assert.ok(stdout.includes('.card-titel'));
});

test('--exclude skips files', () => {
  const { stdout, code } = cli([SAMPLE, '--exclude', '*style.css', '--no-exit-code']);
  assert.equal(code, 0);
  assert.ok(stdout.includes('excluded: 1 file'), stdout);
  // With the stylesheet gone the variable check has nothing to compare against
  // and must say so rather than report every var() as undefined.
  assert.ok(stdout.includes('skipped missing-css-var'), stdout);
});

test('excluding everything is not an error', () => {
  const { stdout, code } = cli([SAMPLE, '--exclude', '*']);
  assert.equal(code, 0);
  assert.match(stdout, /was excluded/);
});

test('the sample proves the check is cross-file', () => {
  // .card-title is declared in index.html and styled in style.css; the typo
  // that references it lives in a third place, the inline script.
  const { stdout } = cli([SAMPLE, '--no-exit-code']);
  assert.ok(stdout.includes('.card-titel'));
  const only = cli([join(SAMPLE, 'index.html'), '--no-exit-code']).stdout;
  assert.ok(only.includes('skipped missing-css-var'), 'alone, the HTML cannot judge var()');
});

test('an unknown option fails loudly with exit 2', () => {
  const { code, stderr } = cli(['--nope'], { expectFail: true });
  assert.equal(code, 2);
  assert.match(stderr, /unknown option/);
});

test('an unknown rule name fails loudly with exit 2', () => {
  const { code, stderr } = cli(['--rule', 'no-such-rule'], { expectFail: true });
  assert.equal(code, 2);
  assert.match(stderr, /unknown rule/);
});

test('a path with nothing to scan says so instead of reporting success', () => {
  const { code, stderr } = cli([join(here, 'sample', 'index.html.nope')], { expectFail: true });
  assert.equal(code, 2);
  assert.match(stderr, /no HTML, CSS or JS/);
});

test('--all turns on the off-by-default rules', () => {
  const { stdout } = cli([SAMPLE, '--all', '--no-exit-code']);
  assert.ok(stdout.includes('info') || stdout.includes('warn'), stdout);
});

test('the summary always states how much was not judged', () => {
  const { stdout } = cli([SAMPLE, '--no-exit-code']);
  assert.match(stdout, /scanned 1 html/);
});

// An --exclude that quietly excludes nothing is worse than no flag at all:
// the run looks clean for the wrong reason. Paths from the walk are relative,
// so an anchored pattern silently misses them.
test('--exclude matches anywhere in the path, not just anchored', () => {
  const { stdout } = cli([SAMPLE, '--exclude', 'style', '--no-exit-code']);
  assert.ok(stdout.includes('excluded: 1 file'), stdout);
});

test('--exclude with a leading glob also works', () => {
  const { stdout } = cli([SAMPLE, '--exclude', '*/style.css', '--no-exit-code']);
  assert.ok(stdout.includes('excluded: 1 file'), stdout);
});
