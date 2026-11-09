const fs = require("fs");
const path = require("path");

/**
 * Render the chat webview HTML, inlining marked.js so the panel can render
 * markdown without a network request.
 *
 * Both hosts (sidebar view and editor tab) use the same document; only the
 * transport differs.
 *
 * @param {string} extensionPath - Absolute path to the extension root.
 * @returns {string} Complete HTML document.
 */
function renderChatHtml(extensionPath) {
  const htmlPath = path.join(extensionPath, "webview-ui", "chat.html");
  const markedPath = path.join(extensionPath, "webview-ui", "marked.js");
  const html = fs.readFileSync(htmlPath, "utf-8");
  const markedJs = fs.readFileSync(markedPath, "utf-8");
  return html.replace("</head>", "<script>" + markedJs + "</script></head>");
}

module.exports = { renderChatHtml };
