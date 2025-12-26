import { WalletStorageManager } from "@bsv/wallet-toolbox/mobile";
import { StorageIdb } from "@bsv/wallet-toolbox/mobile/out/src/storage/StorageIdb";
import { OneSatWallet } from "../../src/OneSatWallet";
import { IndexedDbSyncQueue } from "../../src/sync/IndexedDbSyncQueue";
import type { SyncQueueItemStatus, SyncQueueStats, SyncState } from "../../src/sync/types";

// State
interface AppState {
  page: "login" | "dashboard";
  identityKey: string;
  addresses: string[];
  chain: "main" | "test";
  apiUrl: string;
  isSyncing: boolean;
  isStreamActive: boolean;
  isProcessorActive: boolean;
}

const state: AppState = {
  page: "login",
  identityKey: "02403bbec3576b7852586f2e79ea7297f313a0c2f1cd63d26b9996aed4a9b710d9",
  addresses: [
    "13AGuUcJKJm5JaT9qssFxK8DETo3tAaa66",
    "1AjdTTSvxTde1FtMjwSuyNqvwiwjmBAjD1",
    "1FDHUkNu5QLH1XhdjJ3tpcEVSetB5QhnCZ",
  ],
  chain: "main",
  apiUrl: "http://localhost:8080",
  isSyncing: false,
  isStreamActive: false,
  isProcessorActive: false,
};

// Instances (initialized on dashboard)
let syncQueue: IndexedDbSyncQueue | null = null;
let statsQueue: IndexedDbSyncQueue | null = null; // Persistent queue for stats polling
let wallet: OneSatWallet | null = null;
let storage: WalletStorageManager | null = null;
let statsInterval: ReturnType<typeof setInterval> | null = null;

const app = document.getElementById("app");
if (!app) throw new Error("Missing #app element");

function render() {
  // Cleanup intervals
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }

  if (state.page === "login") {
    renderLogin();
  } else {
    renderDashboard();
  }
}

function renderLogin() {
  app.innerHTML = `
    <div class="login-page">
      <div class="login-container">
        <h1>1Sat Wallet Tester</h1>
        
        <div class="form-group">
          <label for="api-url">API URL</label>
          <input 
            type="text" 
            id="api-url" 
            value="${state.apiUrl}"
            placeholder="http://localhost:8080/api"
          />
        </div>

        <div class="form-group">
          <label for="chain">Network</label>
          <select id="chain">
            <option value="main" ${state.chain === "main" ? "selected" : ""}>Mainnet</option>
            <option value="test" ${state.chain === "test" ? "selected" : ""}>Testnet</option>
          </select>
        </div>

        <div class="form-group">
          <label for="identity-key">Identity Key (Public Key Hex)</label>
          <input 
            type="text" 
            id="identity-key" 
            placeholder="02abc123..."
            value="${state.identityKey}"
          />
        </div>

        <div class="form-group">
          <label for="addresses">Addresses (one per line)</label>
          <textarea 
            id="addresses" 
            placeholder="1ABC...&#10;1XYZ..."
          >${state.addresses.join("\n")}</textarea>
          <div class="hint">Enter BSV addresses to sync, one per line</div>
        </div>

        <button class="btn btn-primary" id="login-btn">Continue</button>
      </div>
    </div>
  `;

  const apiUrlInput = document.getElementById("api-url");
  const chainSelect = document.getElementById("chain");
  const identityKeyInput = document.getElementById("identity-key");
  const addressesTextarea = document.getElementById("addresses");
  const loginBtn = document.getElementById("login-btn");

  apiUrlInput?.addEventListener("input", (e) => {
    state.apiUrl = (e.target as HTMLInputElement).value;
  });

  chainSelect?.addEventListener("change", (e) => {
    state.chain = (e.target as HTMLSelectElement).value as "main" | "test";
  });

  identityKeyInput?.addEventListener("input", (e) => {
    state.identityKey = (e.target as HTMLInputElement).value.trim();
  });

  addressesTextarea?.addEventListener("input", (e) => {
    const text = (e.target as HTMLTextAreaElement).value;
    state.addresses = text
      .split("\n")
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
  });

  loginBtn?.addEventListener("click", () => {
    if (!state.identityKey) {
      alert("Please enter an identity key");
      return;
    }
    if (state.addresses.length === 0) {
      alert("Please enter at least one address");
      return;
    }
    state.page = "dashboard";
    render();
  });
}

async function initWallet(): Promise<void> {
  // Initialize sync queue
  syncQueue = new IndexedDbSyncQueue(state.identityKey);

  // Create IDB storage
  const storageProvider = new StorageIdb({
    chain: state.chain,
    feeModel: { model: "sat/kb", value: 1 },
    commissionSatoshis: 0,
  });

  // Migrate storage
  await storageProvider.migrate("1sat-tester", state.identityKey);

  // Initialize storage manager
  storage = new WalletStorageManager(state.identityKey, storageProvider);

  // Create wallet with sync queue
  wallet = new OneSatWallet({
    rootKey: state.identityKey, // Read-only mode with public key
    storage,
    chain: state.chain,
    owners: new Set(state.addresses),
    onesatUrl: state.apiUrl,
    syncQueue,
  });

  // Set up event listeners
  wallet.on("sync:start", (event) => {
    log(`Sync started for ${event.addresses.length} addresses`);
    state.isSyncing = true;
    updateSyncButtons();
  });

  wallet.on("sync:progress", (event) => {
    log(`Progress: ${event.done} done, ${event.pending} pending, ${event.failed} failed`);
  });

  wallet.on("sync:complete", () => {
    log("Sync complete");
    state.isSyncing = false;
    updateSyncButtons();
  });

  wallet.on("sync:error", (event) => {
    log(`Sync error: ${event.message}`, "error");
    state.isSyncing = false;
    updateSyncButtons();
  });
}

async function renderDashboard() {
  // Get initial stats (queue may not exist yet)
  let stats: SyncQueueStats = { pending: 0, processing: 0, done: 0, failed: 0 };
  let syncState: SyncState = { lastQueuedScore: 0 };

  // Initialize persistent stats queue if not already created
  if (!statsQueue) {
    statsQueue = new IndexedDbSyncQueue(state.identityKey);
  }

  // Try to get existing queue stats
  try {
    stats = await statsQueue.getStats();
    syncState = await statsQueue.getState();
  } catch {
    // Queue doesn't exist yet, use defaults
  }

  app.innerHTML = `
    <div class="dashboard-page">
      <div class="dashboard-header">
        <h1>1Sat Wallet Tester</h1>
        <button class="btn btn-secondary" id="logout-btn">Logout</button>
      </div>
      
      <div class="dashboard-content">
        <div class="card">
          <h2>Configuration</h2>
          <div class="info-grid">
            <div class="info-row">
              <span class="label">API URL</span>
              <span class="value">${state.apiUrl}</span>
            </div>
            <div class="info-row">
              <span class="label">Network</span>
              <span class="value">${state.chain === "main" ? "Mainnet" : "Testnet"}</span>
            </div>
            <div class="info-row">
              <span class="label">Identity Key</span>
              <span class="value">${truncate(state.identityKey, 20)}</span>
            </div>
          </div>
        </div>

        <div class="card">
          <h2>Addresses (${state.addresses.length})</h2>
          <div class="address-list">
            ${state.addresses.map((addr) => `<div class="address-item">${addr}</div>`).join("")}
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <h2>Sync</h2>
            <div class="button-group">
              <button class="btn btn-primary" id="sync-btn">Start Sync</button>
              <button class="btn btn-danger" id="stop-btn" style="display: none;">Stop</button>
              <button class="btn btn-secondary" id="clear-btn">Clear Queue</button>
            </div>
          </div>
          <div class="control-row">
            <div class="control-group">
              <span class="control-label">SSE Stream</span>
              <button class="btn btn-sm" id="stream-btn">Start</button>
            </div>
            <div class="control-group">
              <span class="control-label">Queue Processor</span>
              <button class="btn btn-sm" id="processor-btn">Start</button>
            </div>
          </div>
          <div class="stats-grid" id="stats-grid">
            ${renderStatsGrid(stats)}
          </div>
          <div class="sync-state" id="sync-state">
            ${renderSyncState(syncState)}
          </div>
          <div class="log-container">
            <div class="log-box" id="log-box"></div>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <h2>Queue Items</h2>
            <div class="button-group">
              <button class="btn btn-sm" id="view-pending-btn">Pending</button>
              <button class="btn btn-sm" id="view-processing-btn">Processing</button>
              <button class="btn btn-sm" id="view-done-btn">Done</button>
              <button class="btn btn-sm" id="view-failed-btn">Failed</button>
            </div>
          </div>
          <div class="queue-items" id="queue-items">
            <div class="placeholder">Select a status to view queue items</div>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <h2>Wallet Outputs</h2>
            <div class="button-group">
              <button class="btn btn-sm" id="basket-fund-btn">fund</button>
              <button class="btn btn-sm" id="basket-1sat-btn">1sat</button>
              <button class="btn btn-sm" id="basket-bsv21-btn">bsv21</button>
              <button class="btn btn-sm" id="basket-opns-btn">opns</button>
              <button class="btn btn-sm" id="basket-lock-btn">lock</button>
              <button class="btn btn-sm" id="basket-default-btn">default</button>
            </div>
          </div>
          <div class="wallet-outputs" id="wallet-outputs">
            <div class="placeholder">Select a basket to view outputs</div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.getElementById("logout-btn")?.addEventListener("click", handleLogout);
  document.getElementById("sync-btn")?.addEventListener("click", handleSync);
  document.getElementById("stop-btn")?.addEventListener("click", handleStopSync);
  document.getElementById("clear-btn")?.addEventListener("click", handleClearQueue);
  document.getElementById("stream-btn")?.addEventListener("click", handleToggleStream);
  document.getElementById("processor-btn")?.addEventListener("click", handleToggleProcessor);
  document.getElementById("view-pending-btn")?.addEventListener("click", () => viewQueueItems("pending"));
  document.getElementById("view-processing-btn")?.addEventListener("click", () => viewQueueItems("processing"));
  document.getElementById("view-done-btn")?.addEventListener("click", () => viewQueueItems("done"));
  document.getElementById("view-failed-btn")?.addEventListener("click", () => viewQueueItems("failed"));
  document.getElementById("basket-fund-btn")?.addEventListener("click", () => viewBasketOutputs("fund"));
  document.getElementById("basket-1sat-btn")?.addEventListener("click", () => viewBasketOutputs("1sat"));
  document.getElementById("basket-bsv21-btn")?.addEventListener("click", () => viewBasketOutputs("bsv21"));
  document.getElementById("basket-opns-btn")?.addEventListener("click", () => viewBasketOutputs("opns"));
  document.getElementById("basket-lock-btn")?.addEventListener("click", () => viewBasketOutputs("lock"));
  document.getElementById("basket-default-btn")?.addEventListener("click", () => viewBasketOutputs("default"));

  // Start stats polling
  statsInterval = setInterval(updateStats, 500);
}

function renderStatsGrid(stats: SyncQueueStats): string {
  return `
    <div class="stat-item">
      <span class="stat-value">${stats.pending}</span>
      <span class="stat-label">Pending</span>
    </div>
    <div class="stat-item">
      <span class="stat-value">${stats.processing}</span>
      <span class="stat-label">Processing</span>
    </div>
    <div class="stat-item">
      <span class="stat-value stat-success">${stats.done}</span>
      <span class="stat-label">Done</span>
    </div>
    <div class="stat-item">
      <span class="stat-value stat-error">${stats.failed}</span>
      <span class="stat-label">Failed</span>
    </div>
  `;
}

function renderSyncState(syncState: SyncState): string {
  const lastSynced = syncState.lastSyncedAt
    ? new Date(syncState.lastSyncedAt).toLocaleString()
    : "Never";

  return `
    <div class="info-row">
      <span class="label">Last Queued Score</span>
      <span class="value">${syncState.lastQueuedScore.toFixed(6)}</span>
    </div>
    <div class="info-row">
      <span class="label">Last Synced</span>
      <span class="value">${lastSynced}</span>
    </div>
  `;
}

async function updateStats() {
  // Use the active syncQueue if available, otherwise use persistent statsQueue
  const queue = syncQueue || statsQueue;
  if (!queue) return;

  try {
    const stats = await queue.getStats();
    const syncState = await queue.getState();
    updateStatsDisplay(stats, syncState);
  } catch {
    // Queue might be closed or not ready
  }
}

function updateStatsDisplay(stats: SyncQueueStats, syncState: SyncState) {
  const statsGrid = document.getElementById("stats-grid");
  const syncStateEl = document.getElementById("sync-state");

  if (statsGrid) {
    statsGrid.innerHTML = renderStatsGrid(stats);
  }
  if (syncStateEl) {
    syncStateEl.innerHTML = renderSyncState(syncState);
  }
}

function updateSyncButtons() {
  const syncBtn = document.getElementById("sync-btn") as HTMLButtonElement | null;
  const stopBtn = document.getElementById("stop-btn") as HTMLButtonElement | null;

  if (syncBtn) {
    syncBtn.style.display = state.isSyncing ? "none" : "block";
  }
  if (stopBtn) {
    stopBtn.style.display = state.isSyncing ? "block" : "none";
  }
}

async function handleSync() {
  if (state.isSyncing) return;

  log("Initializing wallet...");

  try {
    await initWallet();
    log("Starting sync...");
    wallet?.sync();
  } catch (error) {
    log(`Failed to start sync: ${error}`, "error");
    state.isSyncing = false;
    updateSyncButtons();
  }
}

function handleStopSync() {
  if (!wallet || !state.isSyncing) return;

  log("Stopping sync...");
  wallet.stopSync();
  state.isSyncing = false;
  state.isStreamActive = false;
  state.isProcessorActive = false;
  updateSyncButtons();
  updateControlButtons();
  log("Sync stopped");
}

async function handleToggleStream() {
  if (!wallet) {
    // Need to init wallet first
    log("Initializing wallet...");
    await initWallet();
  }

  if (state.isStreamActive) {
    log("Stopping SSE stream...");
    wallet?.stopStream();
    state.isStreamActive = false;
    log("SSE stream stopped");
  } else {
    log("Starting SSE stream...");
    wallet?.startStream();
    state.isStreamActive = true;
    log("SSE stream started");
  }
  updateControlButtons();
}

async function handleToggleProcessor() {
  if (!wallet) {
    // Need to init wallet first
    log("Initializing wallet...");
    await initWallet();
  }

  if (state.isProcessorActive) {
    log("Stopping queue processor...");
    wallet?.stopProcessor();
    state.isProcessorActive = false;
    log("Queue processor stopped");
  } else {
    log("Starting queue processor...");
    state.isProcessorActive = true;
    updateControlButtons();
    wallet?.startProcessor().then(() => {
      state.isProcessorActive = false;
      updateControlButtons();
    });
    log("Queue processor started");
  }
  updateControlButtons();
}

function updateControlButtons() {
  const streamBtn = document.getElementById("stream-btn");
  const processorBtn = document.getElementById("processor-btn");

  if (streamBtn) {
    streamBtn.textContent = state.isStreamActive ? "Stop" : "Start";
    streamBtn.className = state.isStreamActive ? "btn btn-sm btn-danger" : "btn btn-sm";
  }
  if (processorBtn) {
    processorBtn.textContent = state.isProcessorActive ? "Stop" : "Start";
    processorBtn.className = state.isProcessorActive ? "btn btn-sm btn-danger" : "btn btn-sm";
  }
}

async function handleClearQueue() {
  if (state.isSyncing) {
    alert("Cannot clear queue while syncing");
    return;
  }

  if (!confirm("Clear all queue data?")) return;

  const tempQueue = new IndexedDbSyncQueue(state.identityKey);
  try {
    await tempQueue.clear();
    log("Queue cleared");
  } catch (error) {
    log(`Failed to clear queue: ${error}`, "error");
  }
  await tempQueue.close();
}

function handleLogout() {
  // Stop sync if running
  if (wallet) {
    wallet.stopSync();
    wallet.close();
    wallet = null;
  }
  if (syncQueue) {
    syncQueue.close();
    syncQueue = null;
  }
  if (statsQueue) {
    statsQueue.close();
    statsQueue = null;
  }
  storage = null;
  state.isSyncing = false;
  state.page = "login";
  render();
}

function log(message: string, type: "info" | "error" = "info") {
  const logBox = document.getElementById("log-box");
  if (!logBox) return;

  const time = new Date().toLocaleTimeString();
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${time}] ${message}`;
  logBox.appendChild(entry);
  logBox.scrollTop = logBox.scrollHeight;
}

function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return `${str.slice(0, len)}...`;
}

async function viewQueueItems(status: SyncQueueItemStatus) {
  const container = document.getElementById("queue-items");
  if (!container) return;

  container.innerHTML = '<div class="placeholder">Loading...</div>';

  const tempQueue = new IndexedDbSyncQueue(state.identityKey);
  try {
    const items = await tempQueue.getByStatus(status, 200);

    if (items.length === 0) {
      container.innerHTML = `<div class="placeholder">No ${status} items</div>`;
      return;
    }

    // Sort by score descending to see most recent first
    items.sort((a, b) => b.score - a.score);

    // Group by block height (integer part of score)
    const byBlock = new Map<number, typeof items>();
    for (const item of items) {
      const block = Math.floor(item.score);
      const existing = byBlock.get(block);
      if (existing) {
        existing.push(item);
      } else {
        byBlock.set(block, [item]);
      }
    }

    let html = `<div class="queue-summary">Showing ${items.length} ${status} items across ${byBlock.size} blocks</div>`;
    html += '<div class="queue-list">';

    for (const [block, blockItems] of byBlock) {
      html += `<div class="queue-block">
        <div class="queue-block-header">Block ${block} (${blockItems.length} items)</div>
        <div class="queue-block-items">`;

      for (const item of blockItems) {
        const txid = item.outpoint.substring(0, 64);
        const vout = item.outpoint.substring(65);
        const isSpend = item.spendTxid ? "spend" : "create";

        html += `<div class="queue-item ${isSpend}">
          <div class="queue-item-main">
            <span class="queue-item-txid">${txid.substring(0, 8)}...${txid.substring(56)}</span>
            <span class="queue-item-vout">:${vout}</span>
            <span class="queue-item-type">${isSpend}</span>
          </div>
          <div class="queue-item-details">
            <span>Score: ${item.score.toFixed(6)}</span>
            ${item.spendTxid ? `<span>Spent by: ${item.spendTxid.substring(0, 12)}...</span>` : ""}
            ${item.lastError ? `<span class="error">Error: ${item.lastError}</span>` : ""}
          </div>
        </div>`;
      }

      html += "</div></div>";
    }

    html += "</div>";
    container.innerHTML = html;
  } catch (error) {
    container.innerHTML = `<div class="placeholder error">Error: ${error}</div>`;
  } finally {
    await tempQueue.close();
  }
}

async function viewBasketOutputs(basket: string) {
  const container = document.getElementById("wallet-outputs");
  if (!container) return;

  if (!wallet) {
    container.innerHTML = '<div class="placeholder">Initialize wallet first (start sync or stream)</div>';
    return;
  }

  container.innerHTML = '<div class="placeholder">Loading...</div>';

  try {
    const result = await wallet.listOutputs({ basket, limit: 100 });

    if (result.outputs.length === 0) {
      container.innerHTML = `<div class="placeholder">No outputs in basket "${basket}"</div>`;
      return;
    }

    let totalSats = 0;
    let html = `<div class="output-summary">Showing ${result.outputs.length} outputs in "${basket}" (total: ${result.totalOutputs})</div>`;
    html += '<div class="output-list">';

    for (const output of result.outputs) {
      const outpoint = output.outpoint;
      const txid = outpoint.substring(0, 64);
      const vout = outpoint.substring(65);
      totalSats += output.satoshis;

      html += `<div class="output-item">
        <div class="output-main">
          <span class="output-txid">${txid}</span>
          <span class="output-vout">:${vout}</span>
          <span class="output-sats">${output.satoshis} sats</span>
        </div>
        <div class="output-details">
          ${output.tags?.length ? `<span>Tags: ${output.tags.join(", ")}</span>` : ""}
          ${output.customInstructions ? `<span class="output-instructions">${truncate(output.customInstructions, 100)}</span>` : ""}
        </div>
      </div>`;
    }

    html += "</div>";
    const totalBsv = totalSats / 100000000;
    html += `<div class="output-total">Total: ${totalSats.toLocaleString()} sats (${totalBsv.toFixed(8)} BSV)</div>`;
    container.innerHTML = html;
  } catch (error) {
    container.innerHTML = `<div class="placeholder error">Error: ${error}</div>`;
  }
}

// Initial render
render();
