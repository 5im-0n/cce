const { targets, findConflicts, describeConflict } = require("./conflict");

/**
 * Registry of tool calls currently executing, across every chat.
 *
 * Each chat announces the tool it is about to run and clears it afterwards.
 * When another chat asks for approval on a tool that touches the same target,
 * the approval card can warn that someone else is already working there.
 * Nothing is blocked — the warning is advisory.
 */

/**
 * @typedef {Object} ActivityRegistry
 * @property {(chatId: string, chatTitle: string, toolName: string, args: Record<string, any>) => void} start
 * @property {(chatId: string) => void} end
 * @property {(chatId: string, toolName: string, args: Record<string, any>) => Array<string>} warningsFor
 */

/**
 * @returns {ActivityRegistry}
 */
function createActivityRegistry() {
  /** @type {Map<string, import("./conflict").ChatActivity>} */
  const inFlight = new Map();

  return {
    /**
     * @param {string} chatId
     * @param {string} chatTitle
     * @param {string} toolName
     * @param {Record<string, any>} args
     */
    start(chatId, chatTitle, toolName, args) {
      const list = targets(toolName, args);
      if (list.length === 0) {
        inFlight.delete(chatId);
        return;
      }
      inFlight.set(chatId, { chatId, chatTitle, toolName, targets: list });
    },

    /**
     * @param {string} chatId
     */
    end(chatId) {
      inFlight.delete(chatId);
    },

    /**
     * @param {string} chatId
     * @param {string} toolName
     * @param {Record<string, any>} args
     * @returns {Array<string>} One warning line per conflicting chat.
     */
    warningsFor(chatId, toolName, args) {
      const conflicts = findConflicts(Array.from(inFlight.values()), chatId, toolName, args);
      return conflicts.map(describeConflict);
    },
  };
}

module.exports = { createActivityRegistry };
