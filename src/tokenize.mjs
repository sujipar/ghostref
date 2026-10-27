// Strip comments and string bodies from source while preserving every byte offset.
//
// Why offsets must survive: a finding is useless without an accurate line number,
// and the cheap approach (regex-replace comments away) shifts every position after
// the first match. So instead of deleting, we overwrite with spaces. The masked
// text is the same length as the input, so `offsetToLine` stays exact.
//
// Why mask at all: a comment that mentions `querySelector('.foo')` is not code, and
// neither is the inside of a string. Scanning raw text reports both.

/** @typedef {{ value: string, start: number, end: number, quote: string }} Literal */

const SPACE = ' ';

/**
 * Split into UTF-16 code units, not code points.
 *
 * `[...src]` merges a surrogate pair into one element, so every array index
 * after the first emoji is one less than the string offset it came from. The
 * drift is silent: nothing throws, lookups just stop resolving. A 400 KB file
 * with 31 emoji lost 97% of its findings this way.
 */
function splitUnits(src) {
  return src.split('');
}


/** Replace [start,end) with spaces, but keep newlines so line counting holds. */
function blank(chars, start, end) {
  for (let i = start; i < end && i < chars.length; i++) {
    if (chars[i] !== '\n') chars[i] = SPACE;
  }
}

/**
 * Decide whether a `/` at `i` opens a regex literal or is a division operator.
 * Looks back at the last meaningful character: after a value (identifier, number,
 * `)`, `]`, `` ` ``) a slash divides; anywhere else it opens a regex.
 */
function regexAllowedAt(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  const c = src[j];
  if (c === ')' || c === ']' || c === '}') return false;
  if (/[A-Za-z0-9_$]/.test(c)) {
    // Keywords are followed by regexes (`return /x/`), identifiers are not (`a /x/`).
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
    const word = src.slice(k + 1, j + 1);
    return ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
            'case', 'do', 'else', 'yield', 'await', 'throw'].includes(word);
  }
  return true;
}

/**
 * Tokenize JavaScript-ish source.
 * @param {string} src
 * @returns {{ masked: string, strings: Literal[] }}
 *   masked  — same length as src, comments and string bodies replaced by spaces
 *   strings — every string literal found, with its offsets (quotes excluded)
 */
export function maskJs(src) {
  const chars = splitUnits(src);
  const strings = [];
  const templates = [];
  // Stack of template-literal depths so `${ `nested` }` is handled.
  const tmplStack = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    // Leaving a `${ ... }` back into its template literal.
    if (c === '}' && tmplStack.length && tmplStack[tmplStack.length - 1].inExpr) {
      tmplStack[tmplStack.length - 1].inExpr = false;
      i++;
      continue;
    }

    if (c === '/' && next === '/') {
      let j = i;
      while (j < src.length && src[j] !== '\n') j++;
      blank(chars, i, j);
      i = j;
      continue;
    }

    if (c === '/' && next === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j === -1 ? src.length : j + 2;
      blank(chars, i, j);
      i = j;
      continue;
    }

    if (c === '"' || c === "'") {
      let j = i + 1;
      let buf = '';
      while (j < src.length) {
        if (src[j] === '\\') { buf += src[j + 1] ?? ''; j += 2; continue; }
        if (src[j] === c) break;
        if (src[j] === '\n') break; // unterminated; bail rather than eat the file
        buf += src[j];
        j++;
      }
      strings.push({ value: buf, start: i + 1, end: j, quote: c });
      blank(chars, i + 1, j);
      i = Math.min(j + 1, src.length);
      continue;
    }

    if (c === '`') {
      tmplStack.push({ inExpr: false });
      const tmplStart = i + 1;
      let tmplPure = true; // no ${} seen yet -> behaves like a plain string
      i++;
      // Walk the template, blanking literal chunks and recursing into ${}.
      while (i < src.length && tmplStack.length) {
        if (src[i] === '\\') { blank(chars, i, i + 2); i += 2; continue; }
        if (src[i] === '`') {
          const raw = src.slice(tmplStart, i);
          if (tmplPure) strings.push({ value: raw, start: tmplStart, end: i, quote: '`' });
          // Interpolated templates are not reliable *values*, but their literal
          // chunks are still real markup: a test fixture written as
          // `<div class="row">${body}</div>` really does create `.row`.
          else templates.push({ value: raw, start: tmplStart, end: i });
          tmplStack.pop(); i++; break;
        }
        if (src[i] === '$' && src[i + 1] === '{') {
          tmplPure = false;
          i += 2;
          // Hand control back to the main loop for the expression body by
          // tracking brace depth here (expressions can contain strings).
          let depth = 1;
          while (i < src.length && depth > 0) {
            const d = src[i];
            if (d === '{') { depth++; i++; continue; }
            if (d === '}') { depth--; i++; continue; }
            if (d === '"' || d === "'") {
              const q = d;
              let j = i + 1, buf = '';
              while (j < src.length) {
                if (src[j] === '\\') { buf += src[j + 1] ?? ''; j += 2; continue; }
                if (src[j] === q || src[j] === '\n') break;
                buf += src[j]; j++;
              }
              strings.push({ value: buf, start: i + 1, end: j, quote: q });
              blank(chars, i + 1, j);
              i = Math.min(j + 1, src.length);
              continue;
            }
            if (d === '/' && src[i + 1] === '/') {
              let j = i; while (j < src.length && src[j] !== '\n') j++;
              blank(chars, i, j); i = j; continue;
            }
            i++;
          }
          continue;
        }
        chars[i] !== '\n' && (chars[i] = SPACE);
        i++;
      }
      continue;
    }

    if (c === '/' && regexAllowedAt(src, i)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '\n') break;
        else if (src[j] === '/' && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) {
        while (j + 1 < src.length && /[a-z]/.test(src[j + 1])) j++;
        blank(chars, i, j + 1);
        i = j + 1;
        continue;
      }
    }

    i++;
  }

  return { masked: chars.join(''), strings, templates };
}

/**
 * Tokenize CSS source. Only block comments and strings exist.
 * @param {string} src
 * @returns {{ masked: string, strings: Literal[] }}
 */
export function maskCss(src) {
  const chars = splitUnits(src);
  const strings = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j === -1 ? src.length : j + 2;
      blank(chars, i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1, buf = '';
      while (j < src.length) {
        if (src[j] === '\\') { buf += src[j + 1] ?? ''; j += 2; continue; }
        if (src[j] === c) break;
        buf += src[j]; j++;
      }
      strings.push({ value: buf, start: i + 1, end: j, quote: c });
      blank(chars, i + 1, j);
      i = Math.min(j + 1, src.length);
      continue;
    }
    i++;
  }
  return { masked: chars.join(''), strings, templates: [] };
}

/** Build a line-start index so offsets become line numbers in O(log n). */
export function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return starts;
}

/** @returns {number} 1-based line for a byte offset. */
export function offsetToLine(starts, offset) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}
