# ghostref

Find references that silently point at nothing.

```
npx ghostref .
```

Zero dependencies. One file type it understands is enough; give it all three and
it checks across them.

---

## The bug class

```js
document.querySelector('.card-titel').replaceChildren('Hi');
```

The class is `card-title`. This line returns `null`, and the optional-chaining
you added last week means it does not even throw. The heading just never
updates.

```css
.badge { border: 1px solid var(--lien); }
```

The property is `--line`. CSS drops the whole declaration without a word. The
border simply never appears.

Both survive every test suite, every type checker and every linter you already
run, for one structural reason: **the name and its definition live in different
files, and each language's tooling only reads its own.** ESLint parses the
script and cannot see your markup. Stylelint parses the stylesheet and cannot
see your script. Nobody is looking across the gap.

So these are found by a human noticing the page looks wrong — if anyone
notices at all.

## What it checks

| rule | finds | default |
|---|---|---|
| `missing-selector` | `querySelector('.x')` where nothing in the project creates `.x` | error |
| `missing-id` | `getElementById('x')` where no element or script creates that id | error |
| `missing-css-var` | `var(--x)` where `--x` is never defined | error |
| `unstyled-class` | a class added to the DOM that no CSS rule targets | off |
| `dead-css-class` | a CSS rule for a class nothing creates | off |
| `dead-css-var` | a custom property defined but never read | off |

The first three are silent failures: something returns `null` or gets dropped
and execution carries on. The last three are dead weight — useful in a cleanup
pass, too noisy to gate a build on, so they are off until you ask with `--all`.

## Example

```
$ npx ghostref test/sample

test/sample/index.html
    18  error  .card-titel in selector ".card-titel" matches nothing this project creates  missing-selector
        did you mean .card-title ?
    21  error  #counter is looked up but nothing creates it  missing-id
        did you mean #count ?

test/sample/style.css
    18  error  var(--lien) is read but --lien is never defined  missing-css-var
        did you mean var(--line) ?

3 findings (3 errors)
scanned 1 html, 1 css, 0 js  | 4 classes and 1 ids in the DOM, 2 custom properties, 5 lookups
```

Each name is declared in one file, styled in a second and referenced from a
third. No single-language tool can see any of the three.

Suggestions use an edit distance that counts a transposition as one change,
because `main` → `mian` is how names actually get mistyped. Names shorter than
three characters get no suggestion: every one-letter name is one edit from
every other, and a hint that is noise teaches you to ignore the hints that are
not.

## It knows your DOM is built at runtime

A class only has to exist *somewhere*, not in your markup:

```js
el.classList.add('is-open');                       // creates .is-open
el.setAttribute('class', 'row');                   // creates .row
box.innerHTML = `<div class="cell">${v}</div>`;    // creates .cell
const CLONE = 'item-clone';
el.classList.add(CLONE);                           // creates .item-clone
<div className="card" />                           // JSX, creates .card
el.style.setProperty('--gap', '4px');              // defines --gap
<div style="--pad: 8px">                           // defines --pad
```

All of these register as creations. Class-name constants are resolved, which
matters because libraries hoist every class name into one; before that was
handled, Bootstrap's own test suite produced dozens of confident, wrong
findings.

## It tells you what it did not judge

```
not judged: 25 lookups built from variables
not judged: 1 templated class/id attribute
skipped missing-selector, missing-id — nothing given here declares markup
skipped missing-css-var — 5 custom properties are declared through preprocessor interpolation
```

A check that quietly did nothing must never be mistaken for a check that
passed. `querySelector('.' + name)` cannot be judged, so it is counted and
reported rather than guessed at. Point ghostref at a folder of stylesheets with
no markup and it refuses to judge selectors at all, because in that situation
*every* lookup looks broken and a page of false findings is worse than silence.

## Ignoring things

```js
document.querySelector('.applied-by-the-server');  // ghostref-ignore
// ghostref-ignore-next-line missing-selector
document.querySelector('.also-fine');
/* ghostref-disable */                             // whole file
```

Naming a rule narrows the suppression to it. Some classes genuinely arrive from
outside your source — a server template, a CDN widget, a drag-and-drop library
— and a linter with no escape hatch gets switched off entirely, taking its real
findings with it.

## In CI

```yaml
- run: npx ghostref . --exclude vendor
```

Exit codes: `0` clean, `1` at least one error-level finding, `2` bad usage.
`--no-exit-code` always exits 0 while you work through a backlog, and `--json`
gives you `{ findings, stats, skippedChecks }` to feed a reporter.

## Options

```
--json                 machine-readable output
--all                  enable every rule, including the off-by-default ones
--rule <name>          enable one rule (repeatable)
--no-rule <name>       disable one rule (repeatable)
--exclude <glob>       skip paths containing this pattern; * spans anything
--no-suggest           do not print "did you mean" hints
--no-exit-code         always exit 0
--quiet                only print findings, no summary
```

Reads `.html .htm .xhtml .vue .svelte`, `.css .scss .sass .less .pcss`,
`.js .mjs .cjs .jsx .ts .tsx .mts .cts`, and the `<style>` / `<script>` blocks
inside HTML. Skips `node_modules`, `dist`, `build`, `coverage`, `vendor` and
dotfolders.

## Does it actually find anything?

Pointed at a 14,000-line production Electron app it had never seen, in 0.14s:

```
613  error  var(--바닥) is read but --바닥 is never defined
     did you mean var(--바탕) ?
642  error  var(--주의선) is read but --주의선 is never defined
     did you mean var(--주의점) ?
```

Two live bugs — a panel with no background colour and a badge with no border —
both weeks old, both typos of a neighbouring name. Neither is visible to a CSS
linter (`var(--바닥)` is perfectly valid CSS) or to a JS linter (no JS is
involved). It also judged 405 selector lookups in the same codebase without a
single false alarm.

## Benchmark

```
node bench/run.mjs
```

Every figure below comes out of that script, against upstream `main`:

| subject | files | lookups judged | findings | ms |
|---|---|---|---|---|
| todomvc/examples/react | 14 | 1 | 0 | 64 |
| htmx/www | 143 | 104 | 1 | 120 |
| htmx/test | 125 | 47 | 1 | 110 |
| jquery/test | 143 | 168 | 0 | 143 |
| bootstrap | 305 | 1,966 | 54 | 181 |
| bootstrap/site | 90 | 60 | 0 | 81 |
| pico | 295 | 0 | 0 | 587 |
| alpine/tests | 77 | 28 | 0 | 92 |
| svelte/packages | 8,592 | 2,050 | 9 | 635 |

4,424 lookups judged across 9,896 files. Most projects come back clean. The
findings that remain cluster in test fixtures that build DOM from interpolated
strings, and in classes applied by something outside the repository — the cases
`ghostref-ignore` exists for. Bootstrap's count is inflated by a shallow clone,
which omits the documentation pages its scripts reference.

## Limits

Being specific about these is the point; a tool that hides them is a tool you
cannot calibrate.

- **Server-side templates are not read.** Hugo, Jinja, ERB, Blade and friends
  declare markup ghostref never sees. On such a project either `--exclude` the
  scripts that reference it or turn `missing-selector` off.
- **Selectors assembled at runtime are not judged**, only counted.
- **Classes and custom properties injected from outside** — a widget, a parent
  component passing `--accent`, a server adding `is-active` — cannot be seen.
  Suppress them.
- **Scope is ignored.** Everything you pass in is one namespace, so handing it
  two unrelated apps at once can let one app's class satisfy the other's typo.
  Run it per app.
- **It is not a parser.** A hand-written tokenizer masks comments, strings,
  template literals and regex literals before any rule runs, which is enough
  for the patterns above and is why there are no dependencies. Exotic syntax
  may simply go unjudged — which it will tell you about.

## Design rules

Drawn from the failures that produced this tool, kept because each one was paid
for:

1. **Unknown and absent are different.** A lookup that cannot be resolved is
   counted, never reported.
2. **A skipped check is announced.** Silence must never be mistakable for a
   pass.
3. **Guesses lose to admissions.** An ambiguous constant resolves at a creation
   site, where being generous can only prevent a false alarm, and stays
   unresolved at a lookup, where it would manufacture a confident wrong answer.
4. **False alarms are the real failure mode.** A noisy linter gets switched
   off, and then its true findings are gone too. Every guard above is covered
   by a test that fails when the guard is removed.

`npm test` runs 95 of them.

## Licence

MIT
