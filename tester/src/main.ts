import {
  OneSatWallet,
  StorageIdb,
  WalletStorageManager,
} from "../../src/index";
import { PrivateKey } from "@bsv/sdk";
import type { Chain } from "@bsv/wallet-toolbox/mobile/out/src/sdk/types";

// DOM Elements
const indexerUrlInput = document.getElementById("indexer-url") as HTMLInputElement;
const chainSelect = document.getElementById("chain") as HTMLSelectElement;
const addressInput = document.getElementById("address") as HTMLInputElement;
const syncBtn = document.getElementById("sync-btn") as HTMLButtonElement;
const stopBtn = document.getElementById("stop-btn") as HTMLButtonElement;
const resyncBtn = document.getElementById("resync-btn") as HTMLButtonElement;
const resetProgressBtn = document.getElementById("reset-progress-btn") as HTMLButtonElement;
const clearStorageBtn = document.getElementById("clear-storage-btn") as HTMLButtonElement;
const syncProgressInfo = document.getElementById("sync-progress-info") as HTMLDivElement;
const txidInput = document.getElementById("txid") as HTMLInputElement;
const parseTxBtn = document.getElementById("parse-tx-btn") as HTMLButtonElement;
const statusBox = document.getElementById("status") as HTMLDivElement;
const progressBar = document.getElementById("progress-bar") as HTMLDivElement;
const progressText = document.getElementById("progress-text") as HTMLDivElement;
const logsBox = document.getElementById("logs") as HTMLDivElement;
const dataDisplay = document.getElementById("data-display") as HTMLDivElement;
const listOutputsBtn = document.getElementById("list-outputs-btn") as HTMLButtonElement;
const listActionsBtn = document.getElementById("list-actions-btn") as HTMLButtonElement;
const showBasketsBtn = document.getElementById("show-baskets-btn") as HTMLButtonElement;

// State
let wallet: OneSatWallet | null = null;
let storage: WalletStorageManager | null = null;
let isSyncing = false;

// Logging - batched updates to prevent DOM thrashing
const MAX_LOG_ENTRIES = 200;
const LOG_FLUSH_INTERVAL = 100; // ms
let logBuffer: { message: string; type: string; time: string }[] = [];
let logFlushScheduled = false;

function flushLogs() {
  if (logBuffer.length === 0) return;

  const fragment = document.createDocumentFragment();
  for (const { message, type, time } of logBuffer) {
    const entry = document.createElement("div");
    entry.className = `log-entry ${type}`;
    entry.innerHTML = `<span class="log-time">${time}</span>${escapeHtml(message)}`;
    fragment.appendChild(entry);
  }
  logsBox.appendChild(fragment);
  logBuffer = [];

  // Remove old entries
  while (logsBox.children.length > MAX_LOG_ENTRIES) {
    logsBox.removeChild(logsBox.firstChild!);
  }

  logsBox.scrollTop = logsBox.scrollHeight;
  logFlushScheduled = false;
}

function log(message: string, type: "info" | "success" | "error" | "tx" = "info") {
  const time = new Date().toLocaleTimeString();
  logBuffer.push({ message, type, time });

  if (!logFlushScheduled) {
    logFlushScheduled = true;
    setTimeout(flushLogs, LOG_FLUSH_INTERVAL);
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function setStatus(message: string, type: "syncing" | "success" | "error" | "" = "") {
  statusBox.textContent = message;
  statusBox.className = `status-box ${type}`;
}

function setProgress(percent: number, text: string = "") {
  progressBar.style.width = `${percent}%`;
  progressText.textContent = text;
}

function getSyncStorageKey(address: string): string {
  return `1sat:sync:${address}`;
}

function getSyncProgress(address: string): number {
  return Number(localStorage.getItem(getSyncStorageKey(address)) || "0");
}

function updateSyncProgressInfo() {
  const address = addressInput.value.trim();
  if (!address) {
    syncProgressInfo.textContent = "";
    return;
  }
  const progress = getSyncProgress(address);
  if (progress > 0) {
    syncProgressInfo.textContent = `Last sync score: ${progress.toFixed(0)}`;
  } else {
    syncProgressInfo.textContent = "No previous sync";
  }
}

function resetSyncProgress() {
  const address = addressInput.value.trim();
  if (!address) {
    setStatus("Please enter an address", "error");
    return;
  }
  localStorage.removeItem(getSyncStorageKey(address));
  log(`Reset sync progress for ${address}`, "success");
  updateSyncProgressInfo();
}

async function fullResync() {
  const address = addressInput.value.trim();
  if (!address) {
    setStatus("Please enter an address", "error");
    return;
  }

  // Reset progress first
  localStorage.removeItem(getSyncStorageKey(address));
  log(`Reset sync progress for full resync`, "info");
  updateSyncProgressInfo();

  // Then start sync
  await syncAddress();
}

// Initialize wallet
async function initWallet(address: string): Promise<OneSatWallet> {
  const chain = chainSelect.value as Chain;
  const onesatUrl = indexerUrlInput.value.trim();

  log(`Initializing wallet for chain: ${chain}`);
  log(`1Sat API URL: ${onesatUrl}`);

  // Generate a random key for testing
  const rootKey = PrivateKey.fromRandom();
  const identityKey = rootKey.toPublicKey().toString();

  // Create IDB storage with required options
  const storageProvider = new StorageIdb({
    chain,
    feeModel: { model: "sat/kb", value: 1 },
    commissionSatoshis: 0,
  });

  // Migrate storage before first access (initializes the IndexedDB database)
  await storageProvider.migrate("1sat-wallet", identityKey);

  // Initialize the storage manager with the identity key
  storage = new WalletStorageManager(identityKey, storageProvider);

  const walletInstance = new OneSatWallet({
    rootKey,
    storage,
    chain,
    owners: new Set([address]),
    onesatUrl,
  });

  // Set up event listeners on the services
  let outputCount = 0;

  walletInstance.services.on("sync:start", (event) => {
    log(`Sync started for ${event.address} from score ${event.fromScore}`, "info");
    setStatus("Syncing...", "syncing");
    setProgress(0, "Starting sync...");
    outputCount = 0;
    stopBtn.disabled = false;
  });

  walletInstance.services.on("sync:output", (event) => {
    outputCount++;
    const outpoint = event.output.outpoint;
    const spent = event.output.spendTxid ? " (spent)" : "";
    log(`Output ${outputCount}: ${outpoint}${spent}`, "tx");
    setProgress(0, `Processing output ${outputCount} (score: ${event.output.score.toFixed(0)})`);
  });

  walletInstance.services.on("sync:error", (event) => {
    log(`Error syncing ${event.address}: ${event.error.message}`, "error");
    setStatus(`Error: ${event.error.message}`, "error");
    stopBtn.disabled = true;
    isSyncing = false;
    syncBtn.disabled = false;
  });

  walletInstance.services.on("sync:complete", (event) => {
    log(`Sync complete for ${event.address}. Processed ${outputCount} outputs.`, "success");
    setStatus(`Sync complete! Processed ${outputCount} outputs.`, "success");
    setProgress(100, "Complete!");
    isSyncing = false;
    syncBtn.disabled = false;
    stopBtn.disabled = true;
  });

  walletInstance.services.on("sync:skipped", (event) => {
    log(`SKIPPED ${event.outpoint}: ${event.reason}`, "info");
  });

  walletInstance.services.on("sync:parsed", (event) => {
    const included = event.outputs.filter(o => o.included);

    if (included.length > 0) {
      for (const out of included) {
        const indexers = Object.keys(out.indexerData).join(", ") || "none";
        log(`PARSED ${event.txid}_${out.vout} -> basket="${out.basket}" owner=${out.owner} indexers=[${indexers}]`, "success");
      }
    } else {
      log(`EXCLUDED ${event.txid} - no outputs included`, "error");
    }

    log(`TX ${event.txid}: ${event.internalizedCount}/${event.outputs.length} outputs internalized`, "info");
  });

  return walletInstance;
}

// Sync address
async function syncAddress() {
  const address = addressInput.value.trim();
  if (!address) {
    setStatus("Please enter an address", "error");
    return;
  }

  // Stop any existing sync before starting a new one
  if (isSyncing && wallet) {
    log("Stopping existing sync...", "info");
    wallet.services.stopSync(addressInput.value.trim());
  }

  isSyncing = true;
  syncBtn.disabled = true;
  logsBox.innerHTML = "";

  try {
    log(`Starting sync for address: ${address}`);
    wallet = await initWallet(address);
    stopBtn.disabled = false;
    // syncAddress runs in background via SSE - completion handled by sync:complete event
    wallet.syncAddress(address);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Sync failed: ${message}`, "error");
    setStatus(`Sync failed: ${message}`, "error");
    console.error("Sync error:", error);
    isSyncing = false;
    syncBtn.disabled = false;
  }
}

// Clear storage
async function clearStorage() {
  const chain = chainSelect.value;
  const dbName = `1sat-sync-test-${chain}`;

  try {
    // Clear localStorage sync keys
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("1sat:sync:")) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(key => localStorage.removeItem(key));

    // Delete IndexedDB
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(dbName);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });

    wallet = null;
    storage = null;
    log(`Cleared storage for ${chain}`, "success");
    setStatus("Storage cleared", "success");
    setProgress(0, "");
    dataDisplay.innerHTML = '<p class="placeholder">Storage cleared - sync again to see data</p>';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Failed to clear storage: ${message}`, "error");
  }
}

// List outputs
async function listOutputs() {
  if (!wallet) {
    dataDisplay.innerHTML = '<p class="placeholder">No wallet initialized. Click Sync first.</p>';
    return;
  }

  try {
    const result = await wallet.listOutputs({
      basket: "default",
      include: "entire transactions",
      limit: 100,
    });

    if (result.outputs.length === 0) {
      // Try with specific baskets
      const baskets = ["1sat", "bsv21", "lock"];
      let allOutputs: typeof result.outputs = [];

      for (const basket of baskets) {
        try {
          const basketResult = await wallet.listOutputs({
            basket,
            include: "entire transactions",
            limit: 100,
          });
          allOutputs = [...allOutputs, ...basketResult.outputs];
        } catch {
          // Basket might not exist
        }
      }

      if (allOutputs.length === 0) {
        dataDisplay.innerHTML = '<p class="placeholder">No outputs found in wallet</p>';
        return;
      }

      result.outputs = allOutputs;
    }

    let html = `<h3>Outputs (${result.outputs.length})</h3>`;
    html += '<div class="outputs-list">';

    for (const output of result.outputs) {
      const txid = output.outpoint.substring(0, 64);
      html += `
        <div class="data-item">
          <div class="data-item-header">
            <div class="data-item-info">
              <div><span class="label">Outpoint:</span><span class="value">${output.outpoint}</span></div>
            </div>
            <button class="parse-btn" onclick="parseAndShowModal('${txid}')">Parse TX</button>
          </div>
          <div><span class="label">Satoshis:</span><span class="value">${output.satoshis}</span></div>
          <div><span class="label">Spendable:</span><span class="value">${output.spendable}</span></div>
          ${output.tags?.length ? `<div><span class="label">Tags:</span>${output.tags.map(t => `<span class="tag-badge">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
        </div>
      `;
    }

    html += "</div>";
    dataDisplay.innerHTML = html;
    log(`Listed ${result.outputs.length} outputs`, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dataDisplay.innerHTML = `<p class="placeholder">Error listing outputs: ${escapeHtml(message)}</p>`;
    log(`Failed to list outputs: ${message}`, "error");
    console.error("List outputs error:", error);
  }
}

// List actions
async function listActions() {
  if (!wallet) {
    dataDisplay.innerHTML = '<p class="placeholder">No wallet initialized. Click Sync first.</p>';
    return;
  }

  try {
    const result = await wallet.listActions({
      labels: [],
      includeLabels: true,
      includeInputs: true,
      includeOutputs: true,
      limit: 50,
    });

    if (result.actions.length === 0) {
      dataDisplay.innerHTML = '<p class="placeholder">No actions found in wallet</p>';
      return;
    }

    let html = `<h3>Actions/Transactions (${result.actions.length})</h3>`;
    html += '<div class="actions-list">';

    for (const action of result.actions) {
      html += `
        <div class="data-item">
          <div class="data-item-header">
            <div class="data-item-info">
              <div><span class="label">TxID:</span><span class="value">${action.txid}</span></div>
            </div>
            <button class="parse-btn" onclick="parseAndShowModal('${action.txid}')">Parse TX</button>
          </div>
          <div><span class="label">Description:</span><span class="value">${escapeHtml(action.description)}</span></div>
          <div><span class="label">Status:</span><span class="value">${action.status}</span></div>
          <div><span class="label">Satoshis:</span><span class="value">${action.satoshis}</span></div>
          ${action.labels?.length ? `<div><span class="label">Labels:</span>${action.labels.map(l => `<span class="basket-badge">${escapeHtml(l)}</span>`).join("")}</div>` : ""}
          <div><span class="label">Inputs:</span><span class="value">${action.inputs?.length || 0}</span></div>
          <div><span class="label">Outputs:</span><span class="value">${action.outputs?.length || 0}</span></div>
        </div>
      `;
    }

    html += "</div>";
    dataDisplay.innerHTML = html;
    log(`Listed ${result.actions.length} actions`, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dataDisplay.innerHTML = `<p class="placeholder">Error listing actions: ${escapeHtml(message)}</p>`;
    log(`Failed to list actions: ${message}`, "error");
    console.error("List actions error:", error);
  }
}

// Show baskets summary
async function showBaskets() {
  if (!storage) {
    dataDisplay.innerHTML = '<p class="placeholder">No storage initialized. Sync an address first.</p>';
    return;
  }

  try {
    // Query storage directly for raw data
    const outputs = await storage.runAsStorageProvider(async (sp) => {
      return await sp.findOutputs({ partial: {} });
    });

    const txs = await storage.runAsStorageProvider(async (sp) => {
      return await sp.findTransactions({ partial: {} });
    });

    // Group outputs by basket
    const basketCounts = new Map<string, number>();
    const basketSatoshis = new Map<string, number>();

    for (const output of outputs) {
      const basket = output.basketId?.toString() || "unknown";
      basketCounts.set(basket, (basketCounts.get(basket) || 0) + 1);
      basketSatoshis.set(basket, (basketSatoshis.get(basket) || 0) + (output.satoshis || 0));
    }

    let html = `<h3>Storage Summary</h3>`;
    html += `
      <div class="data-item">
        <div><span class="label">Total Transactions:</span><span class="value">${txs.length}</span></div>
        <div><span class="label">Total Outputs:</span><span class="value">${outputs.length}</span></div>
      </div>
    `;

    html += `<h3>Baskets</h3>`;
    if (basketCounts.size === 0) {
      html += '<p class="placeholder">No baskets found</p>';
    } else {
      html += '<div class="baskets-list">';
      for (const [basket, count] of basketCounts) {
        const sats = basketSatoshis.get(basket) || 0;
        html += `
          <div class="data-item">
            <div><span class="basket-badge">${escapeHtml(basket)}</span></div>
            <div><span class="label">Outputs:</span><span class="value">${count}</span></div>
            <div><span class="label">Total Satoshis:</span><span class="value">${sats.toLocaleString()}</span></div>
          </div>
        `;
      }
      html += "</div>";
    }

    // Show raw output data
    html += `<h3>Raw Outputs</h3>`;
    html += '<div class="outputs-raw">';
    for (const output of outputs.slice(0, 20)) {
      html += `
        <div class="data-item">
          <pre>${escapeHtml(JSON.stringify(output, null, 2))}</pre>
        </div>
      `;
    }
    if (outputs.length > 20) {
      html += `<p class="placeholder">... and ${outputs.length - 20} more outputs</p>`;
    }
    html += "</div>";

    dataDisplay.innerHTML = html;
    log(`Found ${outputs.length} outputs in ${basketCounts.size} baskets`, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dataDisplay.innerHTML = `<p class="placeholder">Error querying storage: ${escapeHtml(message)}</p>`;
    log(`Failed to query storage: ${message}`, "error");
    console.error("Show baskets error:", error);
  }
}

// Parse single transaction
async function parseTx() {
  const txid = txidInput.value.trim();
  if (!txid) {
    setStatus("Please enter a transaction ID", "error");
    return;
  }

  if (txid.length !== 64) {
    setStatus("Invalid txid - must be 64 hex characters", "error");
    return;
  }

  logsBox.innerHTML = "";
  log(`Parsing transaction: ${txid}`, "info");
  setStatus("Parsing...", "syncing");

  try {
    // Initialize wallet if needed (with empty owner set for parsing)
    if (!wallet) {
      const address = addressInput.value.trim() || "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"; // dummy address
      wallet = await initWallet(address);
    }

    const result = await wallet.parseTransaction(txid);

    log(`Parse complete - ${result.outputs.length} owned outputs, ${result.outputDetails.length} total outputs`, "success");

    // Log each output detail
    for (const out of result.outputDetails) {
      const indexers = Object.keys(out.indexerData).join(", ") || "none";
      if (out.included) {
        log(`OUTPUT ${txid}_${out.vout} -> INCLUDED basket="${out.basket}" owner=${out.owner} indexers=[${indexers}]`, "success");
      } else {
        log(`OUTPUT ${txid}_${out.vout} -> EXCLUDED: ${out.excludeReason} indexers=[${indexers}]`, "error");
      }

      // Log detailed indexer data
      for (const [tag, data] of Object.entries(out.indexerData)) {
        log(`  [${tag}]: ${JSON.stringify(data)}`, "info");
      }
    }

    // Show summary if present
    if (result.summary) {
      log(`SUMMARY: ${JSON.stringify(result.summary, null, 2)}`, "info");
    }

    // Display in data section
    let html = `<h3>Parse Result for ${txid.slice(0, 8)}...${txid.slice(-8)}</h3>`;
    html += `<p><strong>Owned Outputs:</strong> ${result.outputs.length} / ${result.outputDetails.length}</p>`;

    html += '<div class="outputs-list">';
    for (const out of result.outputDetails) {
      const statusClass = out.included ? "included" : "excluded";
      html += `
        <div class="data-item ${statusClass}">
          <div><span class="label">Output:</span><span class="value">${txid}_${out.vout}</span></div>
          <div><span class="label">Status:</span><span class="value">${out.included ? "INCLUDED" : "EXCLUDED"}</span></div>
          ${out.owner ? `<div><span class="label">Owner:</span><span class="value">${out.owner}</span></div>` : ""}
          ${out.basket ? `<div><span class="label">Basket:</span><span class="basket-badge">${escapeHtml(out.basket)}</span></div>` : ""}
          ${out.excludeReason ? `<div><span class="label">Reason:</span><span class="value">${escapeHtml(out.excludeReason)}</span></div>` : ""}
          ${out.tags.length > 0 ? `<div><span class="label">Tags:</span>${out.tags.map(t => `<span class="tag-badge">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
          <div><span class="label">Indexers:</span><span class="value">${Object.keys(out.indexerData).join(", ") || "none"}</span></div>
          <div class="json-viewer"><pre>${escapeHtml(JSON.stringify(out.indexerData, null, 2))}</pre></div>
        </div>
      `;
    }
    html += "</div>";

    if (result.summary) {
      html += `<h3>Summary</h3><div class="json-viewer"><pre>${escapeHtml(JSON.stringify(result.summary, null, 2))}</pre></div>`;
    }

    dataDisplay.innerHTML = html;
    setStatus("Parse complete!", "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Parse failed: ${message}`, "error");
    setStatus(`Parse failed: ${message}`, "error");
    console.error("Parse error:", error);
  }
}

// Stop sync
function stopSync() {
  const address = addressInput.value.trim();
  if (!address || !wallet) {
    return;
  }

  log(`Stopping sync for ${address}...`, "info");
  wallet.stopSync(address);
  setStatus("Sync stopped", "error");
  isSyncing = false;
  syncBtn.disabled = false;
  stopBtn.disabled = true;
  updateSyncProgressInfo();
}

// Event listeners
syncBtn.addEventListener("click", syncAddress);
stopBtn.addEventListener("click", stopSync);
resyncBtn.addEventListener("click", fullResync);
resetProgressBtn.addEventListener("click", resetSyncProgress);
clearStorageBtn.addEventListener("click", clearStorage);
parseTxBtn.addEventListener("click", parseTx);
listOutputsBtn.addEventListener("click", listOutputs);
listActionsBtn.addEventListener("click", listActions);
showBasketsBtn.addEventListener("click", showBaskets);

// Update progress info when address changes
addressInput.addEventListener("input", updateSyncProgressInfo);

// Allow Enter key to trigger sync
addressInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    syncAddress();
  }
});

// Allow Enter key to trigger parse
txidInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    parseTx();
  }
});

// Modal functions
function showModal(title: string, content: string) {
  // Remove any existing modal
  closeModal();

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "parse-modal";
  overlay.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>${escapeHtml(title)}</h3>
        <button class="modal-close" onclick="document.getElementById('parse-modal')?.remove()">Close</button>
      </div>
      <div class="modal-body">
        <pre>${escapeHtml(content)}</pre>
      </div>
    </div>
  `;

  // Close on overlay click (not content)
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) {
      closeModal();
    }
  });

  // Close on Escape key
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      closeModal();
      document.removeEventListener("keydown", escHandler);
    }
  };
  document.addEventListener("keydown", escHandler);

  document.body.appendChild(overlay);
}

function closeModal() {
  document.getElementById("parse-modal")?.remove();
}

async function parseAndShowModal(txid: string) {
  if (!wallet) {
    log("No wallet initialized", "error");
    return;
  }

  try {
    log(`Parsing transaction ${txid}...`, "info");
    const result = await wallet.parseTransaction(txid);
    const jsonStr = JSON.stringify(result, null, 2);
    showModal(`Parse Result: ${txid}`, jsonStr);
    log(`Parse complete for ${txid}`, "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`Parse failed: ${message}`, "error");
    showModal(`Parse Error: ${txid}`, `Error: ${message}`);
  }
}

// Make parseAndShowModal available globally for onclick handlers
(window as unknown as { parseAndShowModal: typeof parseAndShowModal }).parseAndShowModal = parseAndShowModal;

// Initial log
log("1Sat Wallet Sync Tester initialized", "info");
log("Enter an address and click Sync to begin", "info");

// Initial progress info update
updateSyncProgressInfo();
