// Public API. `analyze` takes files already read into memory so the same code
// serves the CLI, an editor plugin and a test.

import { collectHtml, collectCss, collectJs, selectorNames } from './collect.mjs';
import { lineIndex, offsetToLine } from './tokenize.mjs';

export const RULES = {
  'missing-selector': {
    severity: 'error',
    doc: 'A selector is queried but nothing in the project ever creates a matching class.',
  },
  'missing-id': {
    severity: 'error',
    doc: 'An id is looked up but no element or script ever creates it.',
  },
  'missing-css-var': {
    severity: 'error',
    doc: 'var(--x) is read but --x is never defined. CSS drops the declaration silently.',
  },
  'unstyled-class': {
    severity: 'warn',
    off: true,
    doc: 'A class is added to the DOM but no CSS rule targets it, so it has no effect.',
  },
  'dead-css-class': {
    severity: 'info',
    off: true,
    doc: 'A CSS rule targets a class that nothing in the project creates.',
  },
  'dead-css-var': {
    severity: 'info',
    off: true,
    doc: 'A custom property is defined but never read.',
  },
};

const HTML_EXT = new Set(['.html', '.htm', '.xhtml', '.vue', '.svelte']);
const CSS_EXT = new Set(['.css', '.scss', '.sass', '.less', '.pcss', '.postcss']);
const JS_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts']);

function extOf(p) {
  const i = p.lastIndexOf('.');
  return i === -1 ? '' : p.slice(i).toLowerCase();
}

export function kindOf(path) {
  const e = extOf(path);
  if (HTML_EXT.has(e)) return 'html';
  if (CSS_EXT.has(e)) return 'css';
  if (JS_EXT.has(e)) return 'js';
  return null;
}

/**
 * Read suppression comments out of a file.
 *
 * A linter with no escape hatch gets switched off entirely, so the three shapes
 * people already expect from eslint are honoured:
 *
 *   something();              // ghostref-ignore
 *   // ghostref-ignore-next-line missing-selector
 *   // ghostref-disable        (whole file)
 *
 * Naming a rule narrows the suppression to it; naming none suppresses all.
 * Read from raw text on purpose: these live in comments, which the tokenizer
 * erases before any rule runs.
 */
function suppressions(text) {
  const lines = text.split('\n');
  const perLine = new Map(); // 1-based line -> Set of rules, or '*'
  let whole = null;
  const rulesIn = tail => {
    const named = Object.keys(RULES).filter(r => tail.includes(r));
    return named.length ? new Set(named) : '*';
  };
  const merge = (ln, val) => {
    const cur = perLine.get(ln);
    if (cur === '*' || val === '*') perLine.set(ln, '*');
    else if (cur) for (const r of val) cur.add(r);
    else perLine.set(ln, new Set(val));
  };
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const dis = L.indexOf('ghostref-disable');
    if (dis !== -1) {
      const val = rulesIn(L.slice(dis));
      whole = whole === '*' || val === '*' ? '*' : new Set([...(whole || []), ...val]);
      continue;
    }
    const nxt = L.indexOf('ghostref-ignore-next-line');
    if (nxt !== -1) { merge(i + 2, rulesIn(L.slice(nxt))); continue; }
    const ign = L.indexOf('ghostref-ignore');
    if (ign !== -1) merge(i + 1, rulesIn(L.slice(ign)));
  }
  return { perLine, whole };
}

/**
 * Optimal string alignment distance, capped so long comparisons bail early.
 *
 * Transposition counts as one edit, not two. Plain Levenshtein scores
 * `main` -> `mian` as 2 and so refuses to suggest it, yet swapping two
 * neighbouring keys is the single most common way to mistype a name.
 */
function distance(a, b, cap = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const sub = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + sub);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      }
      if (cur[j] < best) best = cur[j];
    }
    if (best > cap) return cap + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Nearest known name, if it is close enough to be a plausible typo.
 *
 * The edit budget grows with length because a one-character difference means
 * something quite different in `.bx` than in `.sidebar-collapsed`. Names under
 * three characters get no suggestion at all: every one-letter name is one edit
 * from every other, so "did you mean .a?" carries no information and only
 * teaches the reader to distrust the hints that are good.
 */
function didYouMean(name, pool) {
  // Minimum length before a suggestion is worth making. Latin names need three
  // characters: every one- or two-letter name is a single edit from every other
  // one, so a hint there is noise. CJK is denser - `--바닥` and `--바탕` are two
  // characters, one edit apart, and mean completely different things, which is
  // exactly the case worth catching. Judging those by the Latin bar silently
  // dropped a real suggestion on a real bug.
  const bare = name.replace(/^--/, '');
  const dense = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(bare);
  if (bare.length < (dense ? 2 : 3)) return null;
  const cap = name.length <= 5 ? 1 : name.length <= 9 ? 2 : 3;
  let best = null, bestD = cap + 1;
  for (const cand of pool) {
    if (cand === name) continue;
    const d = distance(name, cand, cap);
    if (d < bestD) { bestD = d; best = cand; }
  }
  return bestD <= cap ? best : null;
}

/**
 * @param {{path: string, text: string}[]} files
 * @param {{ rules?: Record<string, boolean>, suggest?: boolean }} [options]
 */
export function analyze(files, options = {}) {
  const enabled = name => {
    const o = options.rules?.[name];
    if (o !== undefined) return o;
    return !RULES[name].off;
  };

  // --- gather -------------------------------------------------------------
  const domClasses = new Map();   // name -> {path, offset}
  const domIds = new Map();
  const cssClasses = new Map();
  const cssIds = new Map();
  const varDefs = new Map();
  const varUses = [];            // {name, path, offset, hasFallback}
  const lookups = [];            // {kind, value, path, offset}
  const readClasses = new Set(); // asked about via classList.contains
  const lines = new Map();       // path -> line index
  const suppress = new Map();    // path -> suppression map
  const counts = { html: 0, css: 0, js: 0, skipped: 0 };
  let unresolved = 0, unknownAttrs = 0, interpolatedVarDefs = 0;
  // How many files actually *declare* markup. JS that pokes at classes it
  // never declares is not evidence of what the DOM contains.
  let markupSources = 0;

  const put = (map, name, path, offset) => {
    if (!map.has(name)) map.set(name, { path, offset });
  };

  for (const f of files) {
    const kind = kindOf(f.path);
    if (!kind) { counts.skipped++; continue; }
    lines.set(f.path, lineIndex(f.text));
    if (f.text.includes('ghostref-')) suppress.set(f.path, suppressions(f.text));

    if (kind === 'html') {
      counts.html++;
      markupSources++;
      const h = collectHtml(f.text);
      unknownAttrs += h.unknownAttrs;
      for (const [n, o] of h.classes) put(domClasses, n, f.path, o);
      for (const [n, o] of h.ids) put(domIds, n, f.path, o);
      for (const [n, o] of h.inlineVarDefs) put(varDefs, n, f.path, o);
      for (const b of h.styles) {
        const c = collectCss(b.code, b.offset);
        interpolatedVarDefs += c.interpolatedDefs;
        for (const [n, o] of c.classes) put(cssClasses, n, f.path, o);
        for (const [n, o] of c.ids) put(cssIds, n, f.path, o);
        for (const [n, o] of c.varDefs) put(varDefs, n, f.path, o);
        for (const u of c.varUses) varUses.push({ ...u, path: f.path });
      }
      for (const b of h.scripts) {
        const j = collectJs(b.code, b.offset);
        unresolved += j.unresolved;
        for (const [n, o] of j.created) put(domClasses, n, f.path, o);
        for (const [n, o] of j.createdIds) put(domIds, n, f.path, o);
        for (const [n, o] of j.varDefsRuntime) put(varDefs, n, f.path, o);
        for (const u of j.varUses) varUses.push({ ...u, path: f.path });
        for (const l of j.lookups) lookups.push({ ...l, path: f.path });
        for (const c of j.readClasses) readClasses.add(c);
      }
    } else if (kind === 'css') {
      counts.css++;
      const c = collectCss(f.text, 0);
      interpolatedVarDefs += c.interpolatedDefs;
      for (const [n, o] of c.classes) put(cssClasses, n, f.path, o);
      for (const [n, o] of c.ids) put(cssIds, n, f.path, o);
      for (const [n, o] of c.varDefs) put(varDefs, n, f.path, o);
      for (const u of c.varUses) varUses.push({ ...u, path: f.path });
    } else {
      counts.js++;
      const j = collectJs(f.text, 0);
      unresolved += j.unresolved;
      if (j.markupAttrs > 0) markupSources++;
      for (const [n, o] of j.created) put(domClasses, n, f.path, o);
      for (const [n, o] of j.createdIds) put(domIds, n, f.path, o);
      for (const [n, o] of j.varDefsRuntime) put(varDefs, n, f.path, o);
      for (const u of j.varUses) varUses.push({ ...u, path: f.path });
      for (const l of j.lookups) lookups.push({ ...l, path: f.path });
      for (const c of j.readClasses) readClasses.add(c);
    }
  }

  // Two different questions need two different sets.
  //
  // "Does this lookup resolve?" must consider CSS too: a stylesheet that styles
  // `.panel` proves the author intends that name to exist, so reporting it as
  // "nothing creates it" would be a false alarm on every conditionally rendered
  // element. A real typo is absent from the stylesheet as well, which is exactly
  // why it still gets caught.
  //
  // "Is this CSS rule dead?" must NOT consider CSS, or the rule can never fire.
  const knownClasses = new Set([...domClasses.keys(), ...cssClasses.keys()]);
  const knownIds = new Set([...domIds.keys(), ...cssIds.keys()]);
  const createdClasses = new Set([...domClasses.keys()]);
  const createdIds = new Set([...domIds.keys()]);

  // --- preconditions ------------------------------------------------------
  // Without any DOM source, every lookup would look broken. Refusing to judge
  // beats emitting a page of false findings — but say so out loud.
  const skippedChecks = [];
  // Only a DOM *source* counts here. A stylesheet that mentions `#bd-theme`
  // proves the name is known, not that anything renders it, so counting CSS
  // would re-open the very hole this guard exists to close: pointed at a
  // stylesheet-only folder, every lookup in every script looks broken.
  const haveDom = markupSources > 0 && (domClasses.size > 0 || domIds.size > 0);
  const haveCss = cssClasses.size > 0 || varDefs.size > 0;
  if (!haveDom) {
    skippedChecks.push({
      checks: ['missing-selector', 'missing-id'],
      why: 'nothing given here declares markup (no HTML, JSX or template), so the DOM is unknown and every lookup would look broken',
    });
  }
  if (!haveCss) {
    skippedChecks.push({
      checks: ['missing-css-var', 'unstyled-class', 'dead-css-class'],
      why: 'no CSS was given',
    });
  }
  // A preprocessor that assembles property names by interpolation
  // (`--#{$prefix}gap: ...`) hides the real name from static reading. Judging
  // var() against only the names we can see reports an entire theme as
  // undefined, which is how this check earns a reputation for crying wolf.
  if (interpolatedVarDefs > 0) {
    skippedChecks.push({
      checks: ['missing-css-var', 'dead-css-var'],
      why: `${interpolatedVarDefs} custom propert${interpolatedVarDefs > 1 ? 'ies are' : 'y is'} `
        + 'declared through preprocessor interpolation, so the full set of defined names is unknowable',
    });
  }

  // --- rules --------------------------------------------------------------
  const findings = [];
  const add = (rule, path, offset, message, extra = {}) => {
    const li = lines.get(path);
    findings.push({
      rule,
      severity: RULES[rule].severity,
      path,
      line: li ? offsetToLine(li, offset) : 1,
      message,
      ...extra,
    });
  };
  const suggest = options.suggest !== false;

  if (haveDom) {
    const seen = new Set();
    for (const l of lookups) {
      if (l.kind === 'id') {
        if (knownIds.has(l.value)) continue;
        const key = `id|${l.value}|${l.path}|${l.offset}`;
        if (seen.has(key) || !enabled('missing-id')) continue;
        seen.add(key);
        const hint = suggest ? didYouMean(l.value, knownIds) : null;
        add('missing-id', l.path, l.offset,
          `#${l.value} is looked up but nothing creates it`,
          hint ? { suggestion: `#${hint}` } : {});
        continue;
      }
      if (l.kind === 'classname' || l.kind === 'class') {
        if (knownClasses.has(l.value)) continue;
        if (!enabled('missing-selector')) continue;
        const hint = suggest ? didYouMean(l.value, knownClasses) : null;
        add('missing-selector', l.path, l.offset,
          `.${l.value} is referenced but nothing creates it`,
          hint ? { suggestion: `.${hint}` } : {});
        continue;
      }
      // kind === 'selector': a full CSS selector string
      const { classes, ids } = selectorNames(l.value);
      for (const c of classes) {
        if (knownClasses.has(c) || !enabled('missing-selector')) continue;
        const hint = suggest ? didYouMean(c, knownClasses) : null;
        add('missing-selector', l.path, l.offset,
          `.${c} in selector "${l.value}" matches nothing this project creates`,
          hint ? { suggestion: `.${hint}` } : {});
      }
      for (const id of ids) {
        if (knownIds.has(id) || !enabled('missing-id')) continue;
        const hint = suggest ? didYouMean(id, knownIds) : null;
        add('missing-id', l.path, l.offset,
          `#${id} in selector "${l.value}" matches nothing this project creates`,
          hint ? { suggestion: `#${hint}` } : {});
      }
    }
  }

  if (haveCss && !interpolatedVarDefs && enabled('missing-css-var')) {
    const reported = new Set();
    for (const u of varUses) {
      if (varDefs.has(u.name)) continue;
      // `var(--x, 4px)` has an explicit fallback; the author planned for absence.
      if (u.hasFallback) continue;
      const key = `${u.name}|${u.path}|${u.offset}`;
      if (reported.has(key)) continue;
      reported.add(key);
      const hint = suggest ? didYouMean(u.name, varDefs.keys()) : null;
      add('missing-css-var', u.path, u.offset,
        `var(${u.name}) is read but ${u.name} is never defined`,
        hint ? { suggestion: `var(${hint})` } : {});
    }
  }

  if (haveCss && haveDom && enabled('unstyled-class')) {
    // Classes the code asks about are state flags, not styling mistakes.
    const readByJs = new Set([...readClasses, ...lookups.filter(l => l.kind !== 'id').map(l => l.value)]);
    for (const [name, where] of domClasses) {
      if (cssClasses.has(name) || readByJs.has(name)) continue;
      add('unstyled-class', where.path, where.offset,
        `.${name} is added to the DOM but no CSS rule targets it`);
    }
  }

  if (haveCss && haveDom && enabled('dead-css-class')) {
    for (const [name, where] of cssClasses) {
      if (createdClasses.has(name)) continue;
      add('dead-css-class', where.path, where.offset,
        `.${name} is styled but nothing creates it`);
    }
  }

  if (haveCss && !interpolatedVarDefs && enabled('dead-css-var')) {
    const used = new Set(varUses.map(u => u.name));
    for (const [name, where] of varDefs) {
      if (used.has(name)) continue;
      add('dead-css-var', where.path, where.offset, `${name} is defined but never read`);
    }
  }

  // Apply suppression comments last, so a rule never has to know about them.
  let suppressed = 0;
  const kept = findings.filter(f => {
    const sup = suppress.get(f.path);
    if (!sup) return true;
    const hits = w => w === '*' || (w && w.has(f.rule));
    if (hits(sup.whole) || hits(sup.perLine.get(f.line))) { suppressed++; return false; }
    return true;
  });
  findings.length = 0;
  findings.push(...kept);

  findings.sort((a, b) =>
    a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule));

  return {
    findings,
    stats: {
      files: counts,
      domClasses: createdClasses.size,
      domIds: createdIds.size,
      cssClasses: cssClasses.size,
      cssVars: varDefs.size,
      lookups: lookups.length,
      classesOnlyAskedAbout: readClasses.size,
      unresolvedLookups: unresolved,
      templatedAttrs: unknownAttrs,
      interpolatedVarDefs,
      markupSources,
      suppressed,
    },
    skippedChecks,
  };
}
