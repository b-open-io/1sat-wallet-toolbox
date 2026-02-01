/**
 * CWI (Chrome Wallet Interface) - BRC-100 WalletInterface implementations
 *
 * Two implementations for different contexts:
 * - event.ts: For browser pages (uses CustomEvent, forwarded by content script)
 * - chrome.ts: For extension popup/options (uses chrome.runtime.sendMessage directly)
 */

export { CWIEventName, type CWIResponseDetail } from "./types.js";
export { createCWI, type CWITransport } from "./factory.js";
export { createEventCWI, CWI as EventCWI } from "./event.js";
export { createChromeCWI, ChromeCWI } from "./chrome.js";
