"use strict";

/**
 * Workspace search logic for the search_code tool.
 *
 * Pure functions only — no `vscode` dependency — so the matching semantics
 * (case-insensitive, literal) are unit-testable with node --test.
 */

/**
 * Build the findFiles glob from a comma-separated extension filter.
 *
 * @param {string} [fileTypes] - e.g. ".js,.ts" or " js , ts "
 * @returns {string} glob for findFiles (catch-all or extension-filtered brace glob)
 */
function buildFileGlob(fileTypes) {
  if (!fileTypes) return "**/*";
  const exts = fileTypes
    .split(",")
    .map((s) => s.trim().replace(/^\./, ""))
    .filter(Boolean);
  return exts.length === 0 ? "**/*" : `**/*.{${exts.join(",")}}`;
}

/**
 * Find case-insensitive literal matches of `pattern` in `lines`.
 *
 * The pattern is treated as a plain string: regex metacharacters are escaped
 * so the documented search_code contract ("literal string") holds.
 *
 * Deliberately no `g` flag: with the global flag, RegExp#test advances
 * `lastIndex` between calls and silently skips lines depending on where the
 * previous match ended.
 *
 * @param {string[]} lines
 * @param {string} pattern - raw literal pattern (empty matches every line)
 * @returns {Array<{line: number, text: string}>} matches with 1-based line numbers
 */
function findMatchesInLines(lines, pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escaped, "i");
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      matches.push({ line: i + 1, text: lines[i] });
    }
  }
  return matches;
}

/**
 * Heuristic: true if the buffer is likely binary (contains NUL bytes).
 * Binary files are skipped so decoded garbage can't spuriously "match".
 *
 * @param {Buffer} buf
 * @returns {boolean}
 */
function looksBinary(buf) {
  return buf.includes(0);
}

module.exports = { buildFileGlob, findMatchesInLines, looksBinary };
