const vscode = require("vscode");
const path = require("path");
const cp = require("child_process");

/**
 * Execute a tool call and return its result as a string.
 *
 * @param {string} toolName
 * @param {Record<string, any>} args
 * @param {AbortSignal} [signal] - cancellation signal from the chat request;
 *   forwarded to tools that support it (search_code)
 * @param {(scanned: number, total: number) => void} [onProgress] - live
 *   progress callback for long-running tools (search_code); the caller posts
 *   it to the webview as toolStatus
 * @returns {Promise<string>}
 */
async function executeToolCall(toolName, args, signal, onProgress) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";

  switch (toolName) {
    case "read_file":
      return readFile(workspaceRoot, args.path, args.offset, args.limit);

    case "write_file":
      return writeFile(workspaceRoot, args.path, args.content);

    case "edit_file":
      return editFile(workspaceRoot, args.path, args.oldText, args.newText);

    case "delete_files":
      return deleteFiles(workspaceRoot, args.path, args.recursive);

    case "get_selection":
      return getSelection();

    case "search_code":
      return searchCode(workspaceRoot, args.pattern, args.include, args.exclude, signal, onProgress);

    case "list_files":
      return listFiles(workspaceRoot, args.path);

    case "get_diagnostics":
      return getDiagnostics(workspaceRoot, args.path);

    case "run_command":
      return runCommand(workspaceRoot, args.command, args.cwd);

    default:
      return `Unknown tool: ${toolName}`;
  }
}

// ── tool implementations ───────────────────────────────────

/**
 * @param {string} root
 * @param {string} filePath
 * @param {number} [offset] - 1-based line number to start from
 * @param {number} [limit] - Maximum number of lines to read
 */
function readFile(root, filePath, offset, limit) {
  const fullPath = path.resolve(root, filePath);
  const fs = require("fs");
  if (!fs.existsSync(fullPath)) {
    return `Error: file not found: ${filePath}`;
  }
  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    return `Error: path is a directory: ${filePath}`;
  }
  const content = fs.readFileSync(fullPath, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  const start = Math.max(0, (offset || 1) - 1);
  const end = limit ? start + limit : Math.min(start + 2000, totalLines);
  const slice = lines.slice(start, end);

  // Number the lines
  const numbered = slice.map((l, i) => `${start + i + 1}: ${l}`).join("\n");

  let result = `File: ${filePath} (${totalLines} lines total`;
  if (totalLines > slice.length) {
    result += `, showing lines ${start + 1}-${Math.min(end, totalLines)}`;
  }
  result += `)\n${numbered}`;
  return limitResult(result, `... (${totalLines} lines total)`);
}

/**
 * Create a new file or completely overwrite an existing file.
 * @param {string} root
 * @param {string} filePath
 * @param {string} [content]
 */
function writeFile(root, filePath, content) {
  const fullPath = path.resolve(root, filePath);
  const fs = require("fs");

  // Create parent dirs if needed
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const isExisting = fs.existsSync(fullPath);

  fs.writeFileSync(fullPath, content || "", "utf-8");

  const newStat = fs.statSync(fullPath);
  const action = isExisting ? "Overwrote" : "Created";
  return `${action} ${filePath} (${newStat.size} bytes)`;
}

/**
 * Make a targeted edit by finding an exact text match and replacing it.
 * oldText must match exactly and be unique in the file.
 * @param {string} root
 * @param {string} filePath
 * @param {string} oldText
 * @param {string} newText
 */
function editFile(root, filePath, oldText, newText) {
  const fullPath = path.resolve(root, filePath);
  const fs = require("fs");

  if (!fs.existsSync(fullPath)) {
    return `Error: file not found: ${filePath}`;
  }

  const existing = fs.readFileSync(fullPath, "utf-8");

  // Count occurrences of oldText
  let count = 0;
  let idx = existing.indexOf(oldText);
  let lastIdx = -1;
  while (idx !== -1) {
    count++;
    lastIdx = idx;
    idx = existing.indexOf(oldText, idx + 1);
  }

  if (count === 0) {
    // Try to help: show what's near the expected location
    const snippet = oldText.slice(0, 40).replace(/\n/g, "\\n");
    return `Error: oldText not found in ${filePath}. Could not match: "${snippet}..."`;
  }

  if (count > 1) {
    // Show context around the first match to help the model make it unique
    const lineNum = existing.slice(0, lastIdx).split("\n").length;
    return `Error: oldText matches ${count} locations in ${filePath}. Include more surrounding context to make it unique. Last match near line ${lineNum}.`;
  }

  const replaced = existing.replace(oldText, newText);
  fs.writeFileSync(fullPath, replaced, "utf-8");

  const oldLen = oldText.length;
  const newLen = newText.length;
  const diff = newLen - oldLen;
  const diffStr = diff >= 0 ? `+${diff}` : `${diff}`;
  return `Edited ${filePath}: replaced ${oldLen} chars with ${newLen} chars (${diffStr}).`;
}

/**
 * Delete a file or directory (recursively).
 * @param {string} root
 * @param {string} filePath
 * @param {boolean} [recursive] - Allow deleting non-empty directories
 */
function deleteFiles(root, filePath, recursive) {
  const fullPath = path.resolve(root, filePath);
  const fs = require("fs");

  if (!fs.existsSync(fullPath)) {
    return `Error: not found: ${filePath}`;
  }

  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    const entries = fs.readdirSync(fullPath);
    if (entries.length > 0 && !recursive) {
      return `Error: directory is not empty (${entries.length} entries). Set recursive: true to delete anyway.`;
    }
    fs.rmSync(fullPath, { recursive: true, force: true });
    return `Deleted directory: ${filePath}`;
  }

  fs.unlinkSync(fullPath);
  return `Deleted file: ${filePath}`;
}

/**
 * Get the current selection in the active editor.
 */
function getSelection() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return "No active editor.";

  const doc = editor.document;
  const sel = editor.selection;

  if (sel.isEmpty) {
    return `No selection. Cursor is at line ${sel.start.line + 1}, column ${sel.start.character + 1} in "${doc.fileName}".`;
  }

  const text = doc.getText(sel);
  return `File: ${doc.fileName}\nLines: ${sel.start.line + 1}-${sel.end.line + 1}\n\`\`\`\n${limitText(text, 4000)}\n\`\`\``;
}

/**
 * Search workspace for a literal pattern using the VSCode workspace API.
 *
 * Glob semantics are VSCode's, passed through verbatim (see the tool
 * definition for the contract). No file cap — findFiles scans everything, so a
 * definitive "No matches found." is never a false negative.
 *
 * Two honest limits bound worst-case cost:
 * - Collection stops early at MAX_MATCHES: a broad pattern (e.g. ":") returns
 *   quickly instead of building a huge result array, and the result then
 *   reports "N+ matches" so the model knows more exist and narrows the search.
 * - The scan stops after MAX_FILES_SCANNED files; the result then says
 *   "first N of M files scanned" so an early "No matches found." is never
 *   presented as definitive.
 *
 * Cancellable: the caller's AbortSignal is forwarded to findFiles (via a
 * CancellationTokenSource) and checked before each file read. Throws an
 * AbortError (name === "AbortError") on cancellation so the chat loop stops
 * the whole request instead of continuing with a dead signal.
 *
 * Progress: onProgress is invoked every PROGRESS_INTERVAL scanned files with
 * (scanned, total) so the caller can show live status in the webview.
 *
 * @param {string} root
 * @param {string} pattern
 * @param {string} [include] - comma-separated globs of files to search
 * @param {string} [exclude] - comma-separated globs of files to skip
 * @param {AbortSignal} [signal] - cancellation signal from the chat request
 * @param {(scanned: number, total: number) => void} [onProgress] - live
 *   progress updates (scanned files, total files from findFiles)
 * @returns {Promise<string>}
 */
async function searchCode(root, pattern, include, exclude, signal, onProgress) {
  if (!pattern || !pattern.trim()) {
    return "Error: pattern is required.";
  }

  const {
    buildIncludeGlob,
    buildExcludeGlob,
    findMatchesInLines,
    formatMatchLines,
    looksBinary,
    MAX_MATCHES,
    MAX_FILES_SCANNED,
    PROGRESS_INTERVAL,
  } = require("./search");
  const includeGlob = buildIncludeGlob(include);
  const excludeGlob = buildExcludeGlob(exclude);

  if (signal && signal.aborted) throw abortError();

  // Forward the caller's signal to findFiles so an abort stops the walk.
  const cts = new vscode.CancellationTokenSource();
  const onAbort = () => cts.cancel();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  let files;
  try {
    files = await vscode.workspace.findFiles(includeGlob, excludeGlob, undefined, cts.token);
  } catch {
    if (cts.token.isCancellationRequested) throw abortError();
    return `Error: invalid search glob (include: '${include ?? ""}', exclude: '${exclude ?? ""}'). Use VSCode glob syntax with '/' separators.`;
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    cts.dispose();
  }
  if (files.length === 0) return "No files found to search.";

  const results = [];
  let filesSearched = 0;
  let capped = false; // stopped early at MAX_MATCHES matches
  let budgetExceeded = false; // stopped early at MAX_FILES_SCANNED files
  for (const file of files) {
    if (signal && signal.aborted) throw abortError();
    if (filesSearched >= MAX_FILES_SCANNED) {
      // Honest under-count: unscanned files may still match, so the result
      // reports "first N of M files" instead of a false "No matches found."
      budgetExceeded = true;
      break;
    }
    filesSearched++;
    if (onProgress && filesSearched % PROGRESS_INTERVAL === 0) {
      onProgress(filesSearched, files.length);
    }
    try {
      const buf = await vscode.workspace.fs.readFile(file);
      if (looksBinary(buf)) continue; // skip binary files
      const lines = buf.toString().split("\n");
      const need = MAX_MATCHES - results.length;
      const fileMatches = findMatchesInLines(lines, pattern, need);
      const relPath = vscode.workspace.asRelativePath(file);
      for (const m of fileMatches) {
        results.push(`${relPath}:${m.line}: ${m.text.trim()}`);
      }
      if (fileMatches.length >= need) {
        // At least MAX_MATCHES exist; stop scanning further files.
        capped = true;
        break;
      }
    } catch { /* skip unreadable files */ }
  }

  if (results.length === 0) {
    if (budgetExceeded) {
      return `No matches found in the first ${filesSearched} of ${files.length} files scanned (more remain — narrow with include/exclude).`;
    }
    return "No matches found.";
  }
  return formatMatchLines(results, MAX_MATCHES, 500, { capped, filesSearched, budgetExceeded, totalFiles: files.length });
}

/**
 * Create an AbortError for cancellation propagation. The chat loop matches on
 * `name === "AbortError"` (deliberately without `instanceof Error`, since
 * fetch's abort DOMException also carries this name).
 * @returns {Error}
 */
function abortError() {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

/**
 * List files in a directory.
 * @param {string} root
 * @param {string} [dirPath] - Directory relative to root; defaults to root
 */
async function listFiles(root, dirPath) {
  const target = dirPath ? path.resolve(root, dirPath) : root;
  const fs = require("fs");

  if (!fs.existsSync(target)) {
    return `Error: directory not found: ${dirPath || "."}`;
  }

  const entries = await vscode.workspace.fs.readDirectory(
    vscode.Uri.file(target)
  );
  const result = entries
    .sort((a, b) => {
      // directories first
      if (a[1] === 2 && b[1] !== 2) return -1;
      if (a[1] !== 2 && b[1] === 2) return 1;
      return a[0].localeCompare(b[0]);
    })
    .map(([name, type]) => {
      const prefix = type === 2 ? "[dir]  " : "[file] ";
      return prefix + name;
    })
    .join("\n");

  return result || "(empty directory)";
}

/**
 * Get diagnostics (problems) from VSCode.
 * @param {string} root
 * @param {string} [filePath] - Restrict to a single file; omit for all files
 */
function getDiagnostics(root, filePath) {
  if (filePath) {
    const fullPath = path.resolve(root, filePath);
    const diags = vscode.languages.getDiagnostics(vscode.Uri.file(fullPath));
    return formatDiagnostics(filePath, diags);
  }

  // All files
  const all = vscode.languages.getDiagnostics();
  let out = "";
  for (const [uri, diags] of all) {
    if (diags.length === 0) continue;
    const relPath = vscode.workspace.asRelativePath(uri);
    out += formatDiagnostics(relPath, diags) + "\n";
  }
  return out || "No diagnostics found.";
}

/**
 * @param {string} filePath
 * @param {Array<vscode.Diagnostic>} diags
 */
function formatDiagnostics(filePath, diags) {
  if (diags.length === 0) return `${filePath}: No issues.`;

  const severityLabel = [
    "",
    "ERROR",
    "WARN",
    "INFO",
    "HINT",
  ];

  return diags
    .map((d) => {
      const sev = severityLabel[d.severity] || "?";
      const pos = `L${d.range.start.line + 1}:${d.range.start.character + 1}`;
      return `${filePath}:${pos} [${sev}] ${d.message}`;
    })
    .join("\n");
}

/**
 * Execute a shell command.
 * @param {string} root
 * @param {string} command
 * @param {string} [cwd] - Working directory relative to root
 */
function runCommand(root, command, cwd) {
  return new Promise((resolve) => {
    const workingDir = cwd ? path.resolve(root, cwd) : root;

    cp.exec(
      command,
      {
        cwd: workingDir,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        let out = "";
        if (stdout) out += stdout;
        if (stderr) out += (out ? "\n" : "") + stderr;
        if (err && !out) out = `Command failed: ${err.message}`;
        resolve(limitText(out, 4000) || "(no output)");
      }
    );
  });
}

// ── helpers ────────────────────────────────────────────────

/**
 * Truncate a result to a reasonable size (100 lines / 8000 chars).
 * @param {string} text
 * @param {string} suffix
 * @returns {string}
 */
function limitResult(text, suffix) {
  const lines = text.split("\n");
  if (lines.length > 100) {
    return lines.slice(0, 100).join("\n") + "\n" + suffix;
  }
  if (text.length > 8000) {
    return text.slice(0, 8000) + "\n" + suffix;
  }
  return text;
}

/**
 * Truncate text to a maximum length.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function limitText(text, maxLen) {
  if (text.length > maxLen) {
    return text.slice(0, maxLen) + "\n... (truncated)";
  }
  return text;
}

module.exports = { executeToolCall };
