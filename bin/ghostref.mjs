#!/usr/bin/env node
// CLI. Walks the given paths, hands every readable file to analyze(), prints
// findings, and exits non-zero when something is broken so CI can gate on it.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { analyze, RULES, kindOf } from '../src/index.mjs';

const VERSION = '0.1.0';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.output', '.cache', 'vendor', '.venv', 'venv', '__pycache__',
]);

const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { r: '\x1b[31m', y: '\x1b[33m', b: '\x1b[34m', d: '\x1b[2m', bold: '\x1b[1m', x: '\x1b[0m' }
  : { r: '', y: '', b: '', d: '', bold: '', x: '' };

const SEV = {
  error: { label: 'error', color: C.r },
  warn:  { label: 'warn ', color: C.y },
  info:  { label: 'info ', color: C.b },
};

function help() {
  const rules = Object.entries(RULES)
    .map(([n, r]) => `    ${n.padEnd(18)}${r.off ? C.d + ' (off by default)' + C.x : ''}\n      ${C.d}${r.doc}${C.x}`)
    .join('\n');
  return `${C.bold}ghostref${C.x} ${VERSION} - find references that silently point at nothing

${C.bold}Usage${C.x}
  ghostref [paths...] [options]

  Paths default to the current directory. Give it your HTML, CSS and JS
  together: the checks are cross-file, so a lookup in a script is only
  judged against the markup and stylesheets you pass in.

${C.bold}Options${C.x}
  --json                 machine-readable output
  --all                  enable every rule, including the off-by-default ones
  --rule <name>          enable one rule (repeatable)
  --no-rule <name>       disable one rule (repeatable)
  --no-suggest           do not print "did you mean" hints
  --exclude <glob>       skip paths containing this pattern; * spans anything
  --no-exit-code         always exit 0 (useful while adopting)
  --quiet                only print findings, no summary
  -h, --help             this text
  -v, --version          print version

${C.bold}Rules${C.x}
${rules}

${C.bold}Exit codes${C.x}
  0  nothing found (or --no-exit-code)
  1  at least one error-level finding
  2  bad usage

${C.bold}Why this exists${C.x}
  querySelector('.typo') returns null. var(--typo) is dropped. Neither throws,
  so both survive every test suite and every type checker, and are found only
  by a human noticing the page looks wrong. Each language's linter sees only
  its own files, so nobody checks across the gap. ghostref does.
`;
}

function walk(root, out, seen) {
  let st;
  try { st = statSync(root); } catch { return; }
  if (seen.has(root)) return;
  seen.add(root);
  if (st.isFile()) { out.push(root); return; }
  if (!st.isDirectory()) return;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(join(root, e.name), out, seen);
    } else if (e.isFile()) {
      if (kindOf(e.name)) out.push(join(root, e.name));
    }
  }
}

function main(argv) {
  const paths = [];
  const rules = {};
  let json = false, all = false, exitCode = true, quiet = false, suggest = true;
  const excludes = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { process.stdout.write(help()); return 0; }
    else if (a === '-v' || a === '--version') { console.log(VERSION); return 0; }
    else if (a === '--json') json = true;
    else if (a === '--all') all = true;
    else if (a === '--no-exit-code') exitCode = false;
    else if (a === '--quiet') quiet = true;
    else if (a === '--no-suggest') suggest = false;
    else if (a === '--exclude') {
      const pat = argv[++i];
      if (!pat) { console.error('ghostref: --exclude needs a pattern'); return 2; }
      excludes.push(pat);
    }
    else if (a === '--rule' || a === '--no-rule') {
      const name = argv[++i];
      if (!name || !RULES[name]) {
        console.error(`ghostref: unknown rule ${JSON.stringify(name ?? '')}. Known: ${Object.keys(RULES).join(', ')}`);
        return 2;
      }
      rules[name] = a === '--rule';
    } else if (a.startsWith('-')) {
      console.error(`ghostref: unknown option ${a}\nTry --help`);
      return 2;
    } else paths.push(a);
  }

  if (all) for (const n of Object.keys(RULES)) if (rules[n] === undefined) rules[n] = true;
  if (!paths.length) paths.push('.');

  const list = [];
  const seen = new Set();
  for (const p of paths) walk(p, list, seen);

  // Match anywhere in the path, not anchored. Paths come out of the walk
  // relative to what the user typed, so an anchored `*/test/*` silently fails
  // to match `test/x.js` - and an --exclude that quietly excludes nothing is
  // the worst possible outcome for a flag whose whole job is to shut something
  // up. `*` still spans separators.
  const toRe = g => new RegExp(g.split('*').map(x =>
    x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*'));
  const exRe = excludes.map(toRe);
  const excluded = [];

  const files = [];
  const unreadable = [];
  for (const p of list) {
    if (exRe.some(r => r.test(p))) { excluded.push(p); continue; }
    try {
      const text = readFileSync(p, 'utf8');
      // A NUL byte means this is not text; reading it as source invents findings.
      if (text.includes('\u0000')) { unreadable.push([p, 'looks binary']); continue; }
      files.push({ path: relative(process.cwd(), p) || p, text });
    } catch (err) {
      unreadable.push([p, err.code || String(err.message)]);
    }
  }

  if (!files.length) {
    // Excluding everything is a choice the user made, so it is not an error.
    // Finding nothing to scan in the first place usually is one.
    const allExcluded = excluded.length > 0;
    const msg = allExcluded
      ? `ghostref: every one of the ${excluded.length} candidate file(s) was excluded`
      : 'ghostref: no HTML, CSS or JS files found in ' + paths.join(', ');
    if (json) {
      console.log(JSON.stringify({ version: VERSION, findings: [], stats: null,
        excluded: excluded.length, note: msg }, null, 2));
      return 0;
    }
    if (allExcluded) { if (!quiet) console.log(msg); return 0; }
    console.error(msg);
    return 2;
  }

  const result = analyze(files, { rules, suggest });

  if (json) {
    console.log(JSON.stringify({
      version: VERSION,
      findings: result.findings,
      stats: result.stats,
      skippedChecks: result.skippedChecks,
      unreadable: unreadable.map(([path, why]) => ({ path, why })),
      excluded: excluded.length,
    }, null, 2));
  } else {
    render(result, unreadable, quiet, excluded);
  }

  const errors = result.findings.filter(f => f.severity === 'error').length;
  return exitCode && errors > 0 ? 1 : 0;
}

function render(result, unreadable, quiet, excluded = []) {
  const { findings, stats, skippedChecks } = result;
  const out = [];

  let last = null;
  for (const f of findings) {
    if (f.path !== last) { out.push(`\n${C.bold}${f.path}${C.x}`); last = f.path; }
    const sev = SEV[f.severity];
    const loc = `${f.line}`.padStart(6);
    out.push(`${C.d}${loc}${C.x}  ${sev.color}${sev.label}${C.x}  ${f.message}  ${C.d}${f.rule}${C.x}`);
    if (f.suggestion) out.push(`        ${C.d}did you mean ${C.x}${f.suggestion}${C.d} ?${C.x}`);
  }

  if (!quiet) {
    const e = findings.filter(f => f.severity === 'error').length;
    const w = findings.filter(f => f.severity === 'warn').length;
    const i = findings.filter(f => f.severity === 'info').length;
    out.push('');
    if (!findings.length) {
      out.push(`${C.bold}No dangling references found.${C.x}`);
    } else {
      const parts = [];
      if (e) parts.push(`${e} error${e > 1 ? 's' : ''}`);
      if (w) parts.push(`${w} warning${w > 1 ? 's' : ''}`);
      if (i) parts.push(`${i} info`);
      out.push(`${C.bold}${findings.length} finding${findings.length > 1 ? 's' : ''}${C.x} (${parts.join(', ')})`);
    }

    const f = stats.files;
    out.push(`${C.d}scanned ${f.html} html, ${f.css} css, ${f.js} js  ` +
      `| ${stats.domClasses} classes and ${stats.domIds} ids in the DOM, ` +
      `${stats.cssVars} custom properties, ${stats.lookups} lookups${C.x}`);

    // Anything we chose not to judge is reported. A check that quietly did
    // nothing must never be mistaken for a check that passed.
    if (stats.unresolvedLookups) {
      out.push(`${C.d}not judged: ${stats.unresolvedLookups} lookup${stats.unresolvedLookups > 1 ? 's' : ''} built from variables${C.x}`);
    }
    if (stats.templatedAttrs) {
      out.push(`${C.d}not judged: ${stats.templatedAttrs} templated class/id attribute${stats.templatedAttrs > 1 ? 's' : ''}${C.x}`);
    }
    for (const s of skippedChecks) {
      out.push(`${C.y}skipped${C.x} ${s.checks.join(', ')} ${C.d}- ${s.why}${C.x}`);
    }
    if (excluded.length) {
      out.push(`${C.d}excluded: ${excluded.length} file${excluded.length > 1 ? 's' : ''} by --exclude${C.x}`);
    }
    if (stats.suppressed) {
      out.push(`${C.d}suppressed: ${stats.suppressed} finding${stats.suppressed > 1 ? 's' : ''} by ghostref-ignore comments${C.x}`);
    }
    if (unreadable.length) {
      out.push(`${C.d}unreadable: ${unreadable.length} file${unreadable.length > 1 ? 's' : ''} (${unreadable.slice(0, 3).map(([p]) => p).join(', ')}${unreadable.length > 3 ? ', ...' : ''})${C.x}`);
    }
  }

  const text = out.join('\n').replace(/^\n/, '');
  if (text.trim()) console.log(text);
}

process.exitCode = main(process.argv.slice(2));
