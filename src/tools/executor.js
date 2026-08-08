const vscode = require("vscode");
const path = require("path");
const cp = require("child_process");

/**
 * Execute a tool call and return its result as a string.
 *
 * @param {string} toolName
 * @param {object} args
 * @returns {Promise<string>}
 */
async function executeToolCall(toolName, args) {
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
      return searchCode(workspaceRoot, args.pattern, args.fileTypes);

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
 * Search workspace using ripgrep (via workspace.findFiles + grep) or fallback.
 * @param {string} root
 * @param {string} pattern
 * @param {string} [fileTypes]
 */
async function searchCode(root, pattern, fileTypes) {
  // Try ripgrep first, fallback to VSCode API
  try {
    return await ripgrepSearch(root, pattern, fileTypes);
  } catch {
    return await vscodeSearch(pattern, fileTypes);
  }
}

/**
 * Use ripgrep binary (bundled with VSCode) for fast search.
 */
function ripgrepSearch(root, pattern, fileTypes) {
  return new Promise((resolve) => {
    const rgPath = path.join(
      vscode.env.appRoot,
      "..",
      "resources",
      "app",
      "node_modules.asar.unpacked",
      "@vscode",
      "ripgrep",
      "bin",
      "rg"
    );

    const args = ["--no-heading", "--line-number", "-n", "--color", "never", "-i"];
    if (fileTypes) {
      fileTypes.split(",").forEach((ext) => {
        const cleaned = ext.trim().replace(/^\./, "");
        args.push("--type-add", `custom:*.${cleaned}`);
        args.push("--type", "custom");
      });
    }
    args.push("--", pattern, root);

    const proc = cp.spawn(rgPath, args, {
      cwd: root,
      timeout: 10000,
      maxBuffer: 512 * 1024,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });

    proc.on("error", () => {
      resolve(vscodeSearch(pattern, fileTypes));
    });

    proc.on("close", (code) => {
      if (code === 1 && !stdout) {
        resolve("No matches found.");
      } else if (stdout) {
        resolve(limitResult(stdout, "... (results truncated)"));
      } else {
        resolve(stderr || `ripgrep exited with code ${code}`);
      }
    });
  });
}

/**
 * Fallback search using VSCode workspace API.
 */
async function vscodeSearch(pattern, fileTypes) {
  const patternStr = fileTypes
    ? `**/*.{${fileTypes.split(",").map((s) => s.trim().replace(/^\./, "")).join(",")}}`
    : "**/*";

  const files = await vscode.workspace.findFiles(patternStr, "**/node_modules/**", 50);
  if (files.length === 0) return "No files found to search.";

  const results = [];
  const regex = new RegExp(escapeRegex(pattern), "gi");

  for (const file of files) {
    try {
      const content = (await vscode.workspace.fs.readFile(file)).toString();
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          const relPath = vscode.workspace.asRelativePath(file);
          results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
          if (results.length >= 50) break;
        }
      }
    } catch { /* skip unreadable files */ }
    if (results.length >= 50) break;
  }

  if (results.length === 0) return "No matches found.";
  return limitResult(results.join("\n"), `... (${results.length} matches)`);
}

/**
 * List files in a directory.
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

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

function limitText(text, maxLen) {
  if (text.length > maxLen) {
    return text.slice(0, maxLen) + "\n... (truncated)";
  }
  return text;
}

module.exports = { executeToolCall };
