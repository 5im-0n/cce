const vscode = require("vscode");

/**
 * Tool definitions in OpenAI function-calling format.
 * Each tool has a name, description, and JSON Schema parameters.
 *
 * @type {Array<{ type: "function", function: { name: string, description: string, parameters: object } }>}
 */
const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file from the workspace. Returns line numbers and content. Files over 500 lines are truncated unless offset/limit is used.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file, relative to the workspace root",
          },
          offset: {
            type: "number",
            description: "Line number to start reading from (1-based). Defaults to 1.",
          },
          limit: {
            type: "number",
            description: "Maximum number of lines to read. Defaults to 500.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_selection",
      description:
        "Get the currently selected text in the active editor, along with the file path and line range.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_code",
      description:
        "Search for a pattern in the workspace using ripgrep. Returns matching file paths, line numbers, and content.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              "Search pattern (literal string, matched case-insensitively by default)",
          },
          fileTypes: {
            type: "string",
            description:
              "Optional comma-separated file extensions to filter (e.g. '.js,.ts')",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List files and directories in the workspace. Returns an array of relative paths.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Directory path relative to workspace root. Defaults to root.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_diagnostics",
      description:
        "Get VSCode diagnostic messages (errors, warnings, hints) for a file or the entire workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Optional file path relative to workspace root. If omitted, returns diagnostics for all files.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Execute a shell command in the workspace root. Returns stdout and stderr. Use with caution.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute",
          },
          cwd: {
            type: "string",
            description:
              "Working directory for the command. Defaults to workspace root.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agent",
      description:
        "Spawn parallel sub-agents to work on multiple independent tasks simultaneously. " +
        "Each sub-agent receives a prompt and returns a result. Use this when you can break work into parallel pieces " +
        "(e.g., searching multiple files, analyzing different parts of code, researching multiple topics at once). " +
        "Sub-agents have access to all tools and can execute multiple tool-calling rounds (up to 10) before returning a final result. " +
        "Give each sub-agent a complete, self-contained prompt with enough context to work independently.",
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            items: { type: "string" },
            description: "List of prompts. Each prompt is sent to a separate sub-agent in parallel.",
          },
        },
        required: ["tasks"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create a new file or completely overwrite an existing file with new content. " +
        "Use this to create brand-new files or to rewrite an entire file from scratch. " +
        "For targeted edits within an existing file, use edit_file instead.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file, relative to the workspace root. Parent directories are created automatically if needed.",
          },
          content: {
            type: "string",
            description: "The complete file content to write. Replaces the entire file if it already exists.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Make a targeted edit to an existing file by finding an exact text match and replacing it. " +
        "Copy-paste the exact lines from the file (as returned by read_file) into oldText. " +
        "oldText must match exactly and be unique in the file—include enough surrounding context to make it unique. " +
        "To insert new content, match adjacent existing lines and include the new content in newText. " +
        "To delete content, use an empty string for newText.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file, relative to the workspace root.",
          },
          oldText: {
            type: "string",
            description: "The exact text to find in the file. Must match exactly (including whitespace). Must be unique in the file. Include enough surrounding lines so the match is unambiguous.",
          },
          newText: {
            type: "string",
            description: "The text to replace oldText with. Use an empty string to delete the matched text.",
          },
        },
        required: ["path", "oldText", "newText"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_files",
      description:
        "Delete a file or directory (recursively) in the workspace. Use with caution.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file or directory, relative to the workspace root.",
          },
          recursive: {
            type: "boolean",
            description: "Required when deleting a non-empty directory. Set to true to confirm recursive deletion.",
          },
        },
        required: ["path"],
      },
    },
  },
];

/**
 * Return the subset of tool definitions that are enabled.
 * @param {Record<string, boolean>} enabledTools
 * @returns {Array<object>}
 */
function getEnabledDefinitions(enabledTools) {
  return TOOL_DEFINITIONS.filter(
    (t) => enabledTools[t.function.name] !== false
  );
}

module.exports = { getEnabledDefinitions };
