// Collect what each language *defines* and what it *looks up*, then let rules.mjs
// compare the two sides.
//
// The central distinction, and the reason cross-file checking is needed at all:
//
//   CSS  `.x { }`              -> x has a style
//   HTML `class="x"`           -> x exists in the DOM
//   JS   `classList.add('x')`  -> x exists in the DOM (created at runtime)
//   JS   `innerHTML = '<b class="x">'` -> x exists in the DOM (created at runtime)
//   JS   `querySelector('.x')` -> x is *expected* to exist
//
// A lookup with no creator anywhere returns null and throws nothing. That is the
// bug class this tool exists to find.

import { maskJs, maskCss } from './tokenize.mjs';

const IDENT = '[A-Za-z0-9_\\u00a1-\\uffff-]';

/** Pull class/id tokens out of an HTML attribute value. Skips templating. */
function attrTokens(value) {
  // `{{x}}`, `${x}`, `<%= x %>`, `{x}` mean the real value is unknown.
  if (/\{\{|\$\{|<%|\{\s*\w/.test(value)) return null;
  return value.split(/\s+/).filter(Boolean);
}

/**
 * Scan HTML.
 * @returns {{
 *   classes: Map<string, number>, ids: Map<string, number>, tags: Set<string>,
 *   styles: {code: string, offset: number}[], scripts: {code: string, offset: number}[],
 *   unknownAttrs: number
 * }}  Maps hold name -> first offset, so findings can report a location.
 */
export function collectHtml(src) {
  const classes = new Map(), ids = new Map(), tags = new Set();
  const styles = [], scripts = [];
  const inlineVarDefs = new Map();
  let unknownAttrs = 0;

  // Blank HTML comments but keep offsets.
  const chars = [...src];
  const cm = /<!--[\s\S]*?(?:-->|$)/g;
  let m;
  while ((m = cm.exec(src))) {
    for (let i = m.index; i < m.index + m[0].length; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
  const html = chars.join('');

  const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  while ((m = tagRe.exec(html))) {
    const name = m[1].toLowerCase();
    tags.add(name);
    const attrs = m[2] || '';
    const attrBase = m.index + 1 + m[1].length;

    // style="--gap: 8px" really does define a custom property.
    const sRe = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let sm;
    while ((sm = sRe.exec(attrs))) {
      const css = sm[1] ?? sm[2] ?? '';
      const dRe = /(--[A-Za-z0-9_¡-￿-]+)\s*:/g;
      let d;
      while ((d = dRe.exec(css))) {
        if (!inlineVarDefs.has(d[1])) inlineVarDefs.set(d[1], attrBase + sm.index);
      }
    }

    const aRe = /\b(class|id)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let a;
    while ((a = aRe.exec(attrs))) {
      const key = a[1].toLowerCase();
      const raw = a[3] ?? a[4] ?? a[5] ?? '';
      const at = attrBase + a.index;
      const toks = attrTokens(raw);
      if (toks === null) { unknownAttrs++; continue; }
      for (const t of toks) {
        const target = key === 'class' ? classes : ids;
        if (!target.has(t)) target.set(t, at);
      }
    }

    // Inline <style> / <script> bodies, with absolute offsets preserved.
    if (name === 'style' || name === 'script') {
      const openEnd = m.index + m[0].length;
      const close = html.toLowerCase().indexOf(`</${name}`, openEnd);
      const end = close === -1 ? html.length : close;
      const body = src.slice(openEnd, end);
      if (name === 'style') {
        styles.push({ code: body, offset: openEnd });
      } else if (!/\bsrc\s*=/i.test(attrs)) {
        // A `type` we do not understand (e.g. text/template) is not JS.
        const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
        const isJs = !type || /javascript|module|text\/babel|jsx/.test(type);
        if (isJs) scripts.push({ code: body, offset: openEnd });
        else styles.length; // ignore non-JS script bodies
      }
    }
  }

  return { classes, ids, tags, styles, scripts, unknownAttrs, inlineVarDefs };
}

/**
 * Scan CSS.
 * @param {string} src
 * @param {number} base absolute offset of src inside its file
 */
export function collectCss(src, base = 0) {
  const { masked } = maskCss(src);
  const classes = new Map(), ids = new Map();
  const varDefs = new Map();
  const varUses = [];
  const rules = []; // { classes: string[], ids: string[], offset }

  // --custom-prop: value
  const defRe = /(--[A-Za-z0-9_¡-￿-]+)\s*:/g;
  let m;
  while ((m = defRe.exec(masked))) {
    if (!varDefs.has(m[1])) varDefs.set(m[1], base + m.index);
  }

  // var(--custom-prop [, fallback])
  // Names assembled by a preprocessor: `--#{$prefix}gap`, `--@{ns}gap`,
  // `--$(x)gap`. We cannot know what they expand to, only that they exist.
  let interpolatedDefs = 0;
  const interpRe = /--[A-Za-z0-9_-]*(?:#\{|@\{|\$\()/g;
  while (interpRe.exec(masked)) interpolatedDefs++;

  const useRe = /var\(\s*(--[A-Za-z0-9_¡-￿-]+)\s*(,)?/g;
  while ((m = useRe.exec(masked))) {
    varUses.push({ name: m[1], offset: base + m.index, hasFallback: !!m[2] });
  }

  // Selector lists: text before each `{` that is not an at-rule or declaration.
  let depth = 0, segStart = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{') {
      if (depth === 0) {
        const text = masked.slice(segStart, i);
        const trimmed = text.trim();
        // @media / @supports open a nested block whose children are selectors.
        if (trimmed && !trimmed.startsWith('@')) {
          const cls = [], idl = [];
          const cRe = new RegExp(`\\.(${IDENT}+)`, 'g');
          let s;
          while ((s = cRe.exec(text))) {
            cls.push(s[1]);
            if (!classes.has(s[1])) classes.set(s[1], base + segStart + s.index);
          }
          const iRe = new RegExp(`#(${IDENT}+)`, 'g');
          while ((s = iRe.exec(text))) {
            idl.push(s[1]);
            if (!ids.has(s[1])) ids.set(s[1], base + segStart + s.index);
          }
          if (cls.length || idl.length) {
            rules.push({ classes: cls, ids: idl, offset: base + segStart + (text.length - text.trimStart().length) });
          }
        } else if (trimmed.startsWith('@')) {
          // Recurse into the at-rule body so nested selectors are seen.
          let d = 1, j = i + 1;
          while (j < masked.length && d > 0) {
            if (masked[j] === '{') d++;
            else if (masked[j] === '}') d--;
            j++;
          }
          const atName = /^@([a-zA-Z-]+)/.exec(trimmed)?.[1]?.toLowerCase();
          // keyframes selectors are `0%`/`from`, not element selectors.
          if (atName !== 'keyframes' && !/keyframes/.test(atName || '')) {
            const inner = collectCss(src.slice(i + 1, j - 1), base + i + 1);
            for (const [k, v] of inner.classes) if (!classes.has(k)) classes.set(k, v);
            for (const [k, v] of inner.ids) if (!ids.has(k)) ids.set(k, v);
            for (const [k, v] of inner.varDefs) if (!varDefs.has(k)) varDefs.set(k, v);
            varUses.push(...inner.varUses);
            rules.push(...inner.rules);
            interpolatedDefs += inner.interpolatedDefs;
          }
          i = j - 1;
          segStart = j;
          continue;
        }
      }
      depth++;
      continue;
    }
    if (c === '}') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) segStart = i + 1;
      continue;
    }
    if (depth === 0 && c === ';') segStart = i + 1;
  }

  return { classes, ids, varDefs, varUses, rules, interpolatedDefs };
}

// --- JS -------------------------------------------------------------------

const LOOKUP_FNS = {
  querySelector: 'selector',
  querySelectorAll: 'selector',
  closest: 'selector',
  matches: 'selector',
  getElementById: 'id',
  getElementsByClassName: 'class',
};
// Writing a class and asking about one are different acts.
//
// `add` brings a class into existence, so it can never be a dangling reference.
// `contains` is a question that tolerates "no" — a false answer is the normal
// path, not a bug — and the class being asked about is very often applied by
// something outside this codebase: a library, the server, a CSS framework. So
// `contains` is recorded as a read (which exempts the class from
// unstyled-class) but is never judged as a lookup. Doing otherwise reported 63
// false findings in htmx's own test suite, every one of them `.htmx-request`.
const CLASSLIST_WRITE = new Set(['add', 'remove', 'toggle', 'replace']);
const CLASSLIST_READ = new Set(['contains']);

/** Split a selector string into the class/id names it requires. */
export function selectorNames(sel) {
  const classes = [], ids = [];
  // Ignore attribute selectors and pseudo contents, which are not names.
  const cleaned = sel.replace(/\[[^\]]*\]/g, ' ').replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, ' ');
  const cRe = new RegExp(`\\.(${IDENT}+)`, 'g');
  const iRe = new RegExp(`#(${IDENT}+)`, 'g');
  let m;
  while ((m = cRe.exec(cleaned))) if (validName(m[1])) classes.push(m[1]);
  while ((m = iRe.exec(cleaned))) if (validName(m[1])) ids.push(m[1]);
  return { classes, ids };
}

/**
 * Is this a usable class/id name? An empty or punctuation-only string is not a
 * name, and reporting `#` as "looked up but nothing creates it" is noise that
 * costs the whole tool its credibility.
 */
export function validName(s) {
  return typeof s === 'string' && s.length > 0 && new RegExp(`^${IDENT}+$`).test(s);
}

/** A selector we cannot resolve statically (built from variables, etc.). */
function looksDynamic(s) {
  return /\$\{|\+|\bthis\b/.test(s);
}

/**
 * Scan JavaScript.
 * @param {string} src
 * @param {number} base absolute offset of src inside its file
 */
export function collectJs(src, base = 0) {
  const { masked, strings, templates } = maskJs(src);
  const byStart = new Map(strings.map(s => [s.start, s]));

  const lookups = [];      // { kind, value, offset }
  const created = new Map(); // class/id created at runtime -> offset
  const readClasses = new Set(); // classes this code asks about but never writes
  const createdIds = new Map();
  const inlineStyles = [];
  let unresolved = 0;      // dynamic lookups we deliberately do not judge
  let stringMarkup = 0;    // markup found inside string literals

  // Class names are routinely hoisted into constants
  // (`const CLASS_NAME_CLONE = 'carousel-item-clone'`) and then used as
  // `classList.add(CLASS_NAME_CLONE)`. Without resolving them the creation site
  // is invisible while the `querySelector('.carousel-item-clone')` that reads it
  // back is not, which produces a confident, wrong finding.
  //
  // A name declared twice with different values is dropped: a guess is worse
  // than an admitted unknown.
  const consts = new Map(); // name -> Set of literal values seen
  {
    const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
    let m;
    while ((m = re.exec(masked))) {
      const lit = byStart.get(m.index + m[0].length + 1);
      if (!lit) continue;
      if (!consts.has(m[1])) consts.set(m[1], new Set());
      consts.get(m[1]).add(lit.value);
    }
  }

  /**
   * Find the string literals passed to the call whose `(` sits at openIdx.
   *
   * `concat` matters as much as the literals: in `querySelector('.' + name)` the
   * first argument *starts* with a literal but is not one, so judging `'.'` on
   * its own would be judging a value we never saw. Such a call is counted as
   * not-judged instead, and the count is printed.
   *
   * @returns {{args: Literal[], concat: boolean}}
   */
  function literalArgsAt(openIdx, multi = false) {
    const out = [];
    let i = openIdx + 1;
    while (i < masked.length) {
      while (i < masked.length && /\s/.test(masked[i])) i++;
      let lit = byStart.get(i + 1);
      let extra = null;
      if (!lit) {
        // Not a literal. If it names a constant we resolved, stand in for it.
        const idm = /^[A-Za-z_$][\w$]*/.exec(masked.slice(i, i + 64));
        if (!idm) break;
        const vals = consts.get(idm[0]);
        if (!vals || vals.size === 0) break;
        const end = i + idm[0].length - 1;
        const list = [...vals];
        // Deliberately asymmetric. On a creation site, listing every value the
        // name might hold can only *prevent* a false alarm, so be generous. On a
        // lookup, an ambiguous name must stay unjudged, because picking one of
        // two candidates would produce a confident finding from a guess.
        if (list.length > 1 && !multi) break;
        lit = { value: list[0], start: i, end, quote: '' };
        if (multi && list.length > 1) {
          extra = list.slice(1).map(v => ({ value: v, start: i, end, quote: '' }));
        }
      }
      out.push(lit);
      if (extra) out.push(...extra);
      i = lit.end + 1;
      while (i < masked.length && /\s/.test(masked[i])) i++;
      if (masked[i] === ',') { i++; continue; }
      // Anything other than the end of the argument list means the literal was
      // only one operand of a larger expression.
      if (masked[i] !== ')') return { args: [], concat: true };
      break;
    }
    return { args: out, concat: false };
  }

  // 1. Lookup calls: querySelector('.x'), getElementById('x'), el.matches('.y')
  for (const [fn, kind] of Object.entries(LOOKUP_FNS)) {
    const re = new RegExp(`\\.\\s*${fn}\\s*\\(`, 'g');
    let m;
    while ((m = re.exec(masked))) {
      const open = m.index + m[0].length - 1;
      const { args } = literalArgsAt(open);
      if (!args.length) {
        // Either a variable or a dynamic expression -> unknown, not a finding.
        unresolved++;
        continue;
      }
      const raw = args[0].value;
      if (looksDynamic(raw)) { unresolved++; continue; }
      if (kind !== 'selector' && !validName(raw)) { unresolved++; continue; }
      if (kind === 'selector' && !raw.trim()) { unresolved++; continue; }
      lookups.push({ kind, value: raw, offset: base + args[0].start });
    }
  }

  // 2. classList.add/remove/toggle/contains(...) — both a lookup and a creator.
  {
    const re = /\.\s*classList\s*\.\s*([a-zA-Z]+)\s*\(/g;
    let m;
    while ((m = re.exec(masked))) {
      const isWrite = CLASSLIST_WRITE.has(m[1]);
      const isRead = CLASSLIST_READ.has(m[1]);
      if (!isWrite && !isRead) continue;
      const open = m.index + m[0].length - 1;
      const { args } = literalArgsAt(open, isWrite);
      if (!args.length) { unresolved++; continue; }
      args.forEach((a, idx) => {
        if (looksDynamic(a.value) || !validName(a.value)) { unresolved++; return; }
        // `replace(old, new)` reads the first and creates the second.
        const reads = isRead || (m[1] === 'replace' && idx === 0);
        if (!reads && !created.has(a.value)) created.set(a.value, base + a.start);
        if (reads) readClasses.add(a.value);
      });
    }
  }

  // 3. className = 'a b' — creates classes.
  {
    const re = /\.\s*className\s*=\s*/g;
    let m;
    while ((m = re.exec(masked))) {
      const lit = byStart.get(m.index + m[0].length + 1);
      if (!lit) { unresolved++; continue; }
      for (const t of lit.value.split(/\s+/).filter(Boolean)) {
        if (!created.has(t)) created.set(t, base + lit.start);
      }
    }
  }

  // 3b. JSX and framework templates write markup as code, not as a string:
  //     <div className="row"> / <div class="row">. Without this, every React or
  //     Vue project reports its whole DOM as missing.
  let markupAttrs = 0;
  {
    const re = /(?<![.\w$])(className|class|id)\s*=\s*/g;
    let m;
    while ((m = re.exec(masked))) {
      const lit = byStart.get(m.index + m[0].length + 1);
      if (!lit) continue; // className={expr} -> unknown, and that is fine
      const toks = attrTokens(lit.value);
      if (toks === null) continue;
      markupAttrs++;
      const target = m[1] === 'id' ? createdIds : created;
      for (const tok of toks) if (!target.has(tok)) target.set(tok, base + lit.start);
    }
  }

  // 4. Any string literal OR template chunk containing markup creates whatever
  //    it declares. This is what keeps JS-rendered UIs - and test fixtures -
  //    from drowning in false positives.
  for (const s of [...strings, ...templates]) {
    if (!/<[a-zA-Z]/.test(s.value) && !/\bclass\s*=/.test(s.value)) continue;
    const aRe = /\b(class|id)\s*=\s*(?:\\?["']([^"'\\]*)\\?["']|([A-Za-z0-9_-]+))/g;
    let a;
    while ((a = aRe.exec(s.value))) {
      const raw = a[2] ?? a[3] ?? '';
      const toks = attrTokens(raw);
      if (toks === null) continue;
      stringMarkup++;
      for (const t of toks) {
        const target = a[1].toLowerCase() === 'class' ? created : createdIds;
        if (!target.has(t)) target.set(t, base + s.start);
      }
    }
  }

  // 5. setAttribute('class'|'id', '...')
  {
    const re = /\.\s*setAttribute\s*\(/g;
    let m;
    while ((m = re.exec(masked))) {
      const { args } = literalArgsAt(m.index + m[0].length - 1, true);
      if (args.length < 2) continue;
      const key = args[0].value.toLowerCase();
      if (key !== 'class' && key !== 'id') continue;
      const toks = attrTokens(args[1].value);
      if (toks === null) continue;
      for (const t of toks) {
        const target = key === 'class' ? created : createdIds;
        if (!target.has(t)) target.set(t, base + args[1].start);
      }
    }
  }

  // 6. el.style.setProperty('--x', v) defines a custom property at runtime.
  const varDefsRuntime = new Map();
  {
    const re = /\.\s*setProperty\s*\(/g;
    let m;
    while ((m = re.exec(masked))) {
      const { args } = literalArgsAt(m.index + m[0].length - 1);
      if (!args.length) continue;
      if (args[0].value.startsWith('--') && !varDefsRuntime.has(args[0].value)) {
        varDefsRuntime.set(args[0].value, base + args[0].start);
      }
    }
  }

  // 7. CSS text embedded in JS strings: var(--x) uses and --x: definitions.
  for (const s of strings) {
    if (!s.value.includes('--')) continue;
    const uRe = /var\(\s*(--[A-Za-z0-9_¡-￿-]+)\s*(,)?/g;
    let u;
    while ((u = uRe.exec(s.value))) {
      inlineStyles.push({ name: u[1], offset: base + s.start, hasFallback: !!u[2] });
    }
    const dRe = /(--[A-Za-z0-9_¡-￿-]+)\s*:/g;
    let d;
    while ((d = dRe.exec(s.value))) {
      if (!varDefsRuntime.has(d[1])) varDefsRuntime.set(d[1], base + s.start);
    }
  }

  return { lookups, created, createdIds, varDefsRuntime, varUses: inlineStyles,
           unresolved, markupAttrs, stringMarkup, readClasses };
}
