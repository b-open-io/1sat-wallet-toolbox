/**
 * Full wallet synchronization with remote backup server.
 *
 * Performs a complete resync: push local → reset sync state → full pull from server.
 * This is a deliberate user action (not automatic) for recovering from sync issues.
 */

import type { WalletStorageManager } from "@bsv/wallet-toolbox-mobile/out/src/index.client.js";
import type { sdk as mobileToolboxSdk } from "@bsv/wallet-toolbox-mobile/out/src/index.client.js";
import { createSyncMap } from "@bsv/wallet-toolbox-mobile/out/src/storage/schema/entities/EntityBase.js";
import { EntitySyncState } from "@bsv/wallet-toolbox-mobile/out/src/storage/schema/entities/EntitySyncState.js";

type WalletStorageProvider = mobileToolboxSdk.WalletStorageProvider;

export type FullSyncStage = "pushing" | "resetting" | "pulling" | "complete";

export interface FullSyncOptions {
  /** Local storage manager */
  storage: WalletStorageManager;
  /** Remote backup storage provider (StorageClient) */
  remoteStorage: WalletStorageProvider;
  /** Identity key for the wallet */
  identityKey: string;
  /** Optional progress callback */
  onProgress?: (stage: FullSyncStage, message: string) => void;
}

export interface FullSyncResult {
  pushed: { inserts: number; updates: number };
  pulled: { inserts: number; updates: number };
}

/**
 * Perform a full sync with the remote backup server.
 *
 * Steps:
 * 1. Push all local data to remote backup
 * 2. Clear local syncMap / reset sync state
 * 3. Pull ALL data from server (not incremental)
 * 4. Rebuild complete server→client ID mappings
 *
 * @example
 * ```typescript
 * const result = await fullSync({
 *   storage,
 *   remoteStorage: remoteClient,
 *   identityKey: pubKey,
 *   onProgress: (stage, msg) => console.log(`[${stage}] ${msg}`)
 * });
 * console.log(`Pushed: ${result.pushed.inserts}/${result.pushed.updates}`);
 * console.log(`Pulled: ${result.pulled.inserts}/${result.pulled.updates}`);
 * ```
 */
export async function fullSync(
  options: FullSyncOptions,
): Promise<FullSyncResult> {
  const { storage, remoteStorage, identityKey, onProgress } = options;

  // Step 1: Push ALL local data to remote (bypassing timestamp filter)
  onProgress?.("pushing", "Pushing local data to remote...");

  const localSettings = storage.getSettings();
  const remoteSettings = await remoteStorage.makeAvailable();

  let pushInserts = 0;
  let pushUpdates = 0;
  let chunkCount = 0;

  for (;;) {
    // Get sync state from remote for proper offsets
    const ss = await EntitySyncState.fromStorage(
      remoteStorage,
      identityKey,
      localSettings,
    );
    const args = ss.makeRequestSyncChunkArgs(
      identityKey,
      remoteSettings.storageIdentityKey,
    );

    // KEY: Override since to undefined - includes ALL data regardless of timestamp
    args.since = undefined;

    // Get chunk from local storage
    const chunk = await storage.runAsSync(async (sync) =>
      sync.getSyncChunk(args),
    );

    // DEBUG CHECKPOINT 2: Log PUSH chunk contents
    const pushBaskets = chunk.outputBaskets || [];
    const pushOutputs = chunk.outputs || [];
    const pushTransactions = chunk.transactions || [];
    const push1SatOutputs = pushOutputs.filter((o) => o.satoshis === 1);

    console.log("=== CHECKPOINT 2: PUSH CHUNK ===");
    console.log("[PUSH] Chunk #:", chunkCount + 1);
    console.log("[PUSH] Transactions:", pushTransactions.length);
    for (const t of pushTransactions) {
      console.log(
        `  Tx: transactionId=${t.transactionId}, txid=${t.txid?.slice(0, 16) ?? "null"}..., status=${t.status}`,
      );
    }

    console.log("[PUSH] Output Baskets:", pushBaskets.length);
    for (const b of pushBaskets) {
      console.log(`  Basket: id=${b.basketId}, name="${b.name}"`);
    }

    console.log("[PUSH] Total Outputs:", pushOutputs.length);
    console.log(
      "[PUSH] Outputs with basketId:",
      pushOutputs.filter((o) => o.basketId != null).length,
    );
    console.log("[PUSH] 1-sat Outputs:", push1SatOutputs.length);
    console.log(
      "[PUSH] 1-sat with basketId:",
      push1SatOutputs.filter((o) => o.basketId != null).length,
    );

    for (const o of push1SatOutputs) {
      console.log(
        `  1sat Output: outputId=${o.outputId}, basketId=${o.basketId}, txid=${o.txid?.slice(0, 16)}...${o.vout}`,
      );
    }
    console.log("=== END CHECKPOINT 2 ===");

    // Send chunk to remote
    const chunkJson = JSON.stringify(chunk);
    console.log(`[PUSH] Chunk size: ${(chunkJson.length / 1024).toFixed(1)} KB`);
    console.log("[PUSH] Sending chunk to remote...");
    const result = await remoteStorage.processSyncChunk(args, chunk);
    console.log(
      `[PUSH] Server response: inserts=${result.inserts}, updates=${result.updates}, done=${result.done}`,
    );
    pushInserts += result.inserts;
    pushUpdates += result.updates;
    chunkCount++;

    onProgress?.(
      "pushing",
      `Chunk ${chunkCount}: ${result.inserts} inserts, ${result.updates} updates`,
    );

    if (result.done) break;
  }

  onProgress?.(
    "pushing",
    `Pushed ${pushInserts} inserts, ${pushUpdates} updates`,
  );

  // Step 2: Reset sync state to force full pull
  onProgress?.("resetting", "Resetting sync state...");

  const auth = await storage.getAuth();

  await storage.runAsStorageProvider(async (active) => {
    const syncStates = await active.findSyncStates({
      partial: {
        userId: auth.userId,
        storageIdentityKey: remoteSettings.storageIdentityKey,
      },
    });

    if (syncStates.length > 0) {
      const syncState = syncStates[0];
      await active.updateSyncState(syncState.syncStateId, {
        syncMap: JSON.stringify(createSyncMap()),
        when: undefined,
        status: "unknown",
      });
      onProgress?.("resetting", "Sync state reset complete");
    } else {
      onProgress?.("resetting", "No existing sync state found");
    }
  });

  // Step 3: Pull from remote (full pull due to reset state)
  onProgress?.("pulling", "Pulling all data from remote...");

  // DEBUG CHECKPOINT 3: Intercept PULL chunks from remote
  const originalGetSyncChunk = (
    remoteStorage as { getSyncChunk?: (...args: unknown[]) => Promise<unknown> }
  ).getSyncChunk?.bind(remoteStorage);
  if (originalGetSyncChunk) {
    (
      remoteStorage as { getSyncChunk: (...args: unknown[]) => Promise<unknown> }
    ).getSyncChunk = async function (args: unknown) {
      const chunk = (await originalGetSyncChunk(args)) as {
        outputBaskets?: Array<{ basketId: number; name: string }>;
        outputs?: Array<{
          satoshis: number;
          outputId: number;
          basketId?: number;
          txid?: string;
          vout: number;
        }>;
      };

      const pullBaskets = chunk.outputBaskets || [];
      const pullOutputs = chunk.outputs || [];
      const pull1SatOutputs = pullOutputs.filter((o) => o.satoshis === 1);

      console.log("=== CHECKPOINT 3: PULL CHUNK ===");
      console.log("[PULL] Output Baskets:", pullBaskets.length);
      for (const b of pullBaskets) {
        console.log(`  Basket: id=${b.basketId}, name="${b.name}"`);
      }

      console.log("[PULL] Total Outputs:", pullOutputs.length);
      console.log(
        "[PULL] Outputs with basketId:",
        pullOutputs.filter((o) => o.basketId != null).length,
      );
      console.log("[PULL] 1-sat Outputs:", pull1SatOutputs.length);
      console.log(
        "[PULL] 1-sat with basketId:",
        pull1SatOutputs.filter((o) => o.basketId != null).length,
      );

      for (const o of pull1SatOutputs) {
        console.log(
          `  1sat Output: outputId=${o.outputId}, basketId=${o.basketId}, txid=${o.txid?.slice(0, 16)}...${o.vout}`,
        );
      }
      console.log("=== END CHECKPOINT 3 ===");

      return chunk;
    };
  }

  const pullResult = await storage.syncFromReader(identityKey, remoteStorage);

  onProgress?.(
    "pulling",
    `Pulled ${pullResult.inserts} inserts, ${pullResult.updates} updates`,
  );

  // Step 4: Complete
  onProgress?.("complete", "Full sync complete");

  return {
    pushed: { inserts: pushInserts, updates: pushUpdates },
    pulled: { inserts: pullResult.inserts, updates: pullResult.updates },
  };
}
