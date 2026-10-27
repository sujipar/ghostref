# Changelog

## 0.1.0

First release.

- Cross-file checks for `querySelector` / `getElementById` / `var(--x)` against
  the markup, stylesheets and scripts you pass in.
- Understands DOM built at runtime: `classList`, `className`, `setAttribute`,
  `innerHTML`, template literals, JSX `className`, `style.setProperty`,
  inline `style="--x:"`, and class names hoisted into constants.
- Reports everything it declined to judge, and refuses to judge selectors at all
  when no markup source was supplied.
- `ghostref-ignore`, `ghostref-ignore-next-line`, `ghostref-disable`, optionally
  narrowed to one rule.
- "Did you mean" suggestions using optimal string alignment, so a transposition
  costs one edit.
- Zero dependencies.
