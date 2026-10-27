#!/usr/bin/env node
// Reproduce the numbers in the README.
//
//   node bench/run.mjs            # clone (shallow) into bench/repos and measure
//   node bench/run.mjs --no-fetch # measure whatever is already cloned
//
// Every figure in the README comes out of this script. If a change makes
// ghostref noisier on real code, this is where it shows.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, '..', 'bin', 'ghostref.mjs');
const REPOS = join(here, 'repos');
const fetch = !process.argv.includes('--no-fetch');

// Picked to span the ways real projects are laid out: plain HTML+JS, a docs site
// of many pages, a jQuery-era test suite, a Sass design system, a framework
// monorepo, and a CSS-only library.
const SUBJECTS = [
  ['tastejs/todomvc',          'todomvc/examples/javascript-es6'],
  ['tastejs/todomvc',          'todomvc/examples/react'],
  ['bigskysoftware/htmx',      'htmx/www'],
  ['bigskysoftware/htmx',      'htmx/test'],
  ['jquery/jquery',            'jquery/test'],
  ['twbs/bootstrap',           'bootstrap'],
  ['twbs/bootstrap',           'bootstrap/site'],
  ['picocss/pico',             'pico'],
  ['alpinejs/alpine',          'alpine/tests'],
  ['sveltejs/svelte',          'svelte/packages'],
];

function clone(repo) {
  const dir = join(REPOS, repo.split('/')[1]);
  if (existsSync(dir)) return true;
  if (!fetch) return false;
  mkdirSync(REPOS, { recursive: true });
  process.stderr.write(`cloning ${repo}\n`);
  const r = spawnSync('git', ['clone', '--depth', '1', '-q', `https://github.com/${repo}.git`, dir],
    { stdio: 'inherit' });
  return r.status === 0;
}

function measure(target) {
  const t0 = process.hrtime.bigint();
  let out;
  try {
    out = execFileSync(process.execPath, [BIN, target, '--json', '--no-exit-code'],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch (err) {
    return { error: err.message.split('\n')[0] };
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const j = JSON.parse(out);
  const byRule = {};
  for (const f of j.findings) byRule[f.rule] = (byRule[f.rule] || 0) + 1;
  return { ms, findings: j.findings.length, byRule, stats: j.stats,
           skipped: (j.skippedChecks || []).map(s => s.checks.join('+')) };
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const lpad = (s, n) => String(s).padStart(n);

console.log(pad('subject', 34) + lpad('files', 7) + lpad('lookups', 9) +
            lpad('found', 7) + lpad('unjudged', 10) + lpad('ms', 7));
console.log('-'.repeat(74));

let totalLookups = 0, totalFound = 0, totalFiles = 0, missing = 0;
for (const [repo, target] of SUBJECTS) {
  if (!clone(repo)) { missing++; continue; }
  const full = join(REPOS, target);
  if (!existsSync(full)) { console.log(pad(target, 34) + lpad('(absent)', 7)); continue; }
  const m = measure(full);
  if (m.error) { console.log(pad(target, 34) + '  ' + m.error); continue; }
  const f = m.stats.files;
  totalLookups += m.stats.lookups;
  totalFound += m.findings;
  totalFiles += f.html + f.css + f.js;
  console.log(pad(target, 34) + lpad(f.html + f.css + f.js, 7) +
    lpad(m.stats.lookups, 9) + lpad(m.findings, 7) +
    lpad(m.stats.unresolvedLookups, 10) + lpad(m.ms.toFixed(0), 7));
}
console.log('-'.repeat(74));
console.log(pad('total', 34) + lpad(totalFiles, 7) + lpad(totalLookups, 9) + lpad(totalFound, 7));
if (missing) {
  // Say it out loud. A benchmark that silently measured less than it claims is
  // worse than no benchmark.
  console.log(`\n${missing} subject(s) could not be fetched, so this run measured less than the full set.`);
  process.exitCode = 1;
}
