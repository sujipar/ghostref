// Guards the way the tests are run, which no other test can.
//
// `node --test` behaves differently on every major version: Node 18 and 20 do
// not expand globs, Node 22 added glob support, Node 26 treats a directory
// argument as a module to load. The only spelling that works everywhere is an
// explicit list of files - and an explicit list silently goes stale the first
// time someone adds a test file, which would make a whole suite stop running
// while CI stayed green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

test('every test file is listed in the npm test script', () => {
  const onDisk = readdirSync(here).filter(f => f.endsWith('.test.mjs')).sort();
  const script = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.test;
  const listed = script.split(/\s+/).filter(a => a.endsWith('.test.mjs'))
    .map(a => a.replace(/^test\//, '')).sort();
  assert.deepEqual(listed, onDisk,
    'add the new file to scripts.test in package.json, or it will never run');
});

test('the test script does not rely on glob expansion', () => {
  const script = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.test;
  assert.ok(!script.includes('*'),
    'globs are expanded by Node 22+ only, and never by cmd.exe');
});

test('CI runs the tests through npm so there is one place to fix', () => {
  const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.ok(ci.includes('npm test'), 'CI should call npm test, not its own command');
});

test('the package declares no dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.peerDependencies, undefined);
});

test('the published file list covers everything the binary imports', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const bin = readFileSync(join(root, 'bin', 'ghostref.mjs'), 'utf8');
  // Every local import must live under a directory that `files` publishes.
  const imports = [...bin.matchAll(/from '(\.[^']+)'/g)].map(m => m[1]);
  assert.ok(imports.length > 0, 'the binary imports something');
  for (const i of imports) {
    const top = i.replace(/^\.\.?\//, '').split('/')[0];
    assert.ok(pkg.files.includes(top), `${top} is imported but not in package.json files`);
  }
});

// Windows gives the walk `test\\sample\\style.css`. Every --exclude pattern in
// every README is written with forward slashes, so without normalising both
// sides the flag matches nothing on Windows and reports no problem doing it.
// Four Windows runners in CI are what caught this; it is cheap to keep caught.
test('paths are reported with forward slashes on every platform', () => {
  const bin = readFileSync(join(root, 'bin', 'ghostref.mjs'), 'utf8');
  assert.ok(/const slash = /.test(bin), 'a normaliser exists');
  assert.ok(bin.includes('r.test(slash(p))'), '--exclude compares normalised paths');
  assert.ok(bin.includes('slash(relative('), 'findings carry normalised paths');
});

// A README that claims 88 tests while the suite runs 96 is a small lie, and a
// reader who checks one number and finds it wrong stops trusting the rest -
// including the benchmark table, which is the part that has to be believed.
//
// Counted statically on purpose: running the suite from inside the suite to
// count it recurses forever, which is exactly what the first attempt did.
test('the README test count matches the number of tests declared', () => {
  let declared = 0;
  for (const f of readdirSync(here).filter(f => f.endsWith('.test.mjs'))) {
    const src = readFileSync(join(here, f), 'utf8');
    declared += (src.match(/^test\(/gm) || []).length;
  }
  assert.ok(declared > 50, `counted ${declared}, which cannot be right`);
  for (const [file, re] of [
    ['README.md', /`npm test` runs (\d+) of them/],
    ['README.ko.md', /`npm test` 가 (\d+)가지를 돌립니다/],
  ]) {
    const m = re.exec(readFileSync(join(root, file), 'utf8'));
    assert.ok(m, `${file} states a test count`);
    assert.equal(Number(m[1]), declared, `${file} says ${m[1]}, the suite declares ${declared}`);
  }
});
