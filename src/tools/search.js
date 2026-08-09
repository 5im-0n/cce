"use strict";

/**
 * Workspace search logic for the search_code tool.
 *
 * Pure functions only — no `vscode` dependency — so the matching semantics
 * (case-insensitive, literal) and glob building are unit-testable with
 * node --test.
 */

/** Maximum matches collected before the search stops early (display cap). */
const MAX_MATCHES = 500;

/** Maximum files scanned before the search stops (honest under-count budget). */
const MAX_FILES_SCANNED = 10000;

/** Files scanned between progress updates (search_code reports live status). */
const PROGRESS_INTERVAL = 500;

/**
 * Split a comma-separated glob list, respecting `{a,b}` brace groups so a
 * comma inside braces is not treated as a separator.
 *
 * @param {string} [value] - comma-separated globs, e.g. "*.ts, src/main.js"
 * @returns {string[]} trimmed, non-empty globs
 */
function splitGlobs(value) {
  if (value == null) return [];
  if (typeof value !== "string") return [];

  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "{") depth += 1;
    if (ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);

  return parts.map((s) => s.trim()).filter(Boolean);
}

/**
 * Build the findFiles include glob. Glob semantics are VSCode's, passed
 * through verbatim: `*` does not cross `/`, `**` does. No magic prefixing —
 * "*.ts" means root-level only, exactly as in VSCode search.
 *
 * @param {string} [include] - comma-separated globs of files to search
 * @returns {string} glob for findFiles (catch-all or brace union)
 */
function buildIncludeGlob(include) {
  const globs = splitGlobs(include);
  if (globs.length === 0) return "**/*";
  if (globs.length === 1) return globs[0];
  return `{${globs.join(",")}}`;
}

/**
 * Build the findFiles exclude glob. Returns undefined when no exclude is
 * given so findFiles falls back to the workspace `files.exclude` setting,
 * matching VSCode search behavior. Nothing is excluded automatically.
 *
 * @param {string} [exclude] - comma-separated globs of files to skip
 * @returns {string|undefined} glob for findFiles, or undefined for the default
 */
function buildExcludeGlob(exclude) {
  const globs = splitGlobs(exclude);
  if (globs.length === 0) return undefined;
  if (globs.length === 1) return globs[0];
  return `{${globs.join(",")}}`;
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
 * @param {number} [limit] - stop after this many matches (undefined = no limit).
 *   A returned array of length `limit` means "at least limit matches exist".
 * @returns {Array<{line: number, text: string}>} matches with 1-based line numbers
 */
function findMatchesInLines(lines, pattern, limit) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escaped, "i");
  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      matches.push({ line: i + 1, text: lines[i] });
      if (limit != null && limit > 0 && matches.length >= limit) break;
    }
  }
  return matches;
}

/**
 * Format match lines for the model: cap the number shown and per-line length.
 *
 * The cap protects the model's context budget — the full tool result is sent
 * to the model — but never lies: when matches are hidden the result says so
 * explicitly so the model narrows the search instead of trusting a partial
 * result as complete.
 *
 * `extra.capped` marks a search that stopped early at `maxShown` matches: the
 * total is unknown, so the suffix reports "N+" (an explicit under-count) and
 * optionally how many files were scanned before stopping.
 *
 * `extra.budgetExceeded` marks a search that stopped at the file-scan budget
 * (MAX_FILES_SCANNED) while matches were still being collected: the total is
 * unknown because unscanned files may also match, so the suffix reports the
 * exact match count with "first N of M files" and tells the model to narrow.
 *
 * @param {string[]} lines - pre-formatted "path:line: text" strings
 * @param {number} maxShown - maximum number of lines to include
 * @param {number} maxLineLength - per-line character cap (minified lines)
 * @param {{ capped?: boolean, filesSearched?: number, budgetExceeded?: boolean, totalFiles?: number }} [extra] -
 *   capped: stopped early at maxShown matches; budgetExceeded: stopped at the
 *   file-scan budget; filesSearched/totalFiles: scan progress for the suffix
 * @returns {string}
 */
function formatMatchLines(lines, maxShown, maxLineLength, extra) {
  const shown = lines.slice(0, maxShown).map((l) =>
    l.length > maxLineLength ? l.slice(0, maxLineLength) + "…" : l
  );
  let out = shown.join("\n");
  if (extra && extra.budgetExceeded) {
    const files =
      extra.filesSearched != null && extra.totalFiles != null
        ? ` in first ${extra.filesSearched} of ${extra.totalFiles} files`
        : "";
    out += `\n... (${lines.length} matches${files} — narrow for a complete result)`;
  } else if (extra && extra.capped) {
    const files =
      extra.filesSearched != null ? ` in ${extra.filesSearched} files searched` : "";
    out += `\n... (${lines.length}+ matches${files}; showing first ${maxShown} — narrow with include/exclude)`;
  } else if (lines.length > maxShown) {
    out += `\n... (${lines.length} matches total; showing first ${maxShown} — narrow with include/exclude)`;
  }
  return out;
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

module.exports = {
  splitGlobs,
  buildIncludeGlob,
  buildExcludeGlob,
  findMatchesInLines,
  formatMatchLines,
  looksBinary,
  MAX_MATCHES,
  MAX_FILES_SCANNED,
  PROGRESS_INTERVAL,
};
