import { analyze } from '../src/index.mjs';

/** Run analyze over inline sources. `files` is { path: text }. */
export function run(files, options) {
  return analyze(Object.entries(files).map(([path, text]) => ({ path, text })), options);
}

/** Rule ids of every finding, in order. */
export function rules(result) {
  return result.findings.map(f => f.rule);
}

/** Compact "rule@line: message" strings, handy in assertion messages. */
export function lines(result) {
  return result.findings.map(f => `${f.rule}@${f.line}`);
}

/** Does any finding mention this text? */
export function mentions(result, text) {
  return result.findings.some(f => f.message.includes(text) || f.suggestion === text);
}
