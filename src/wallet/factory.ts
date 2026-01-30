/**
 * Factory for creating web wallets.
 *
 * This consolidates the common wallet setup used by both yours-wallet
 * (browser extension) and 1sat-website (React app).
 */

import { KeyDeriver, PrivateKey, type WalletInterface } from "@bsv/sdk";
import type { sdk as toolboxSdk } from "@bsv/wallet-toolbox";
import {
  Monitor,
  type PermissionsManagerConfig,
  Services,
  StorageClient,
  StorageIdb,
  StorageProvider,
  Wallet,
  WalletPermissionsManager,
  WalletStorageManager,
  type sdk as mobileToolboxSdk,
} from "@bsv/wallet-toolbox-mobile/out/src/index.client.js";
import { OneSatServices } from "../services/OneSatServices";
import { type FullSyncResult, type FullSyncStage, fullSync } from "./fullSync";

type Chain = "main" | "test";
type WalletServices = toolboxSdk.WalletServices;
type MobileWalletServices = mobileToolboxSdk.WalletServices;

// Default database name for IndexedDB storage
const DEFAULT_DATABASE_NAME = "wallet";

// Default timeout for remote storage connection
const DEFAULT_REMOTE_STORAGE_TIMEOUT = 5000;

// Default fee model (100 sat/kb matches yours-wallet and 1sat-indexer minimum)
const DEFAULT_FEE_MODEL = { model: "sat/kb" as const, value: 100 };

/**
 * Configuration for creating a web wallet.
 */
export interface WebWalletConfig {
  /** Private key - can be PrivateKey instance, WIF string, or hex string */
  privateKey: PrivateKey | string;
  /** Network: 'main' or 'test' */
  chain: Chain;
  /** Admin originator that bypasses permission checks (e.g., chrome-extension://id or https://wallet.example.com) */
  adminOriginator: string;
  /** Permission configuration for WalletPermissionsManager */
  permissionsConfig: PermissionsManagerConfig;
  /** Fee model. Default: { model: 'sat/kb', value: 100 } */
  feeModel?: { model: "sat/kb"; value: number };
  /** Remote storage URL. If provided, attempts to connect for cloud backup. */
  remoteStorageUrl?: string;
  /** Device ID for sync isolation. Each device should have a unique ID to prevent sync corruption. */
  deviceId?: string;
  /** Callback when a transaction is broadcasted (called after remote sync if connected) */
  onTransactionBroadcasted?: (txid: string) => void;
  /** Callback when a transaction is proven (called after remote sync if connected) */
  onTransactionProven?: (txid: string, blockHeight: number) => void;
}

/**
 * Result of wallet creation.
 */
export interface WebWalletResult {
  /** Wallet instance with permission management */
  wallet: WalletPermissionsManager;
  /** Underlying wallet without permission checks (for trusted contexts like sweep-ui) */
  rawWallet: Wallet;
  /** 1Sat services for API access */
  services: OneSatServices;
  /** Monitor for transaction lifecycle (not started - call monitor.startTasks() when ready) */
  monitor: Monitor;
  /** Cleanup function - stops monitor, destroys wallet */
  destroy: () => Promise<void>;
  /** Full sync with remote backup (only available if remoteStorageUrl was provided and connected) */
  fullSync?: (onProgress?: (stage: FullSyncStage, message: string) => void) => Promise<FullSyncResult>;
  /** Storage manager (for debugging/diagnostics) */
  storage: WalletStorageManager;
  /** Remote storage client (for debugging/diagnostics, undefined if not connected) */
  remoteStorage?: StorageClient;
}

/**
 * Parse a private key from various input formats.
 * Supports PrivateKey instance, WIF string, or hex string.
 */
function parsePrivateKey(input: PrivateKey | string): PrivateKey {
  if (input instanceof PrivateKey) {
    return input;
  }

  // Try WIF first (starts with 5, K, L for mainnet or c for testnet)
  if (/^[5KLc][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(input)) {
    return PrivateKey.fromWif(input);
  }

  // Try hex (64 characters)
  if (/^[0-9a-fA-F]{64}$/.test(input)) {
    return new PrivateKey(input);
  }

  // Last resort - try WIF anyway
  try {
    return PrivateKey.fromWif(input);
  } catch {
    throw new Error(
      "Invalid private key format. Expected PrivateKey instance, WIF string, or 64-char hex string.",
    );
  }
}

/**
 * Create a web wallet with storage, services, permissions, and monitor.
 *
 * @example
 * ```typescript
 * const { wallet, services, monitor, destroy } = await createWebWallet({
 *   privateKey: identityWif,
 *   chain: 'main',
 *   adminOriginator: 'https://wallet.example.com',
 *   permissionsConfig: DEFAULT_PERMISSIONS_CONFIG,
 * });
 *
 * // Wire up monitor callbacks
 * monitor.onTransactionProven = async (status) => console.log('Proven:', status.txid);
 *
 * // Start monitor when ready
 * monitor.startTasks();
 * ```
 */
export async function createWebWallet(
  config: WebWalletConfig,
): Promise<WebWalletResult> {
  const { chain, adminOriginator, permissionsConfig } = config;
  const feeModel = config.feeModel ?? DEFAULT_FEE_MODEL;

  // 1. Parse private key and create KeyDeriver
  const privateKey = parsePrivateKey(config.privateKey);
  const identityPubKey = privateKey.toPublicKey().toString();
  const keyDeriver = new KeyDeriver(privateKey);

  // 2. Create fallback services and OneSatServices
  const fallbackServices = new Services(chain);
  const oneSatServices = new OneSatServices(
    chain,
    undefined,
    fallbackServices as unknown as WalletServices,
  );

  // 3. Create local storage
  const storageOptions = StorageProvider.createStorageBaseOptions(chain);
  storageOptions.feeModel = feeModel;
  const localStorage = new StorageIdb(storageOptions);
  await localStorage.migrate(DEFAULT_DATABASE_NAME, identityPubKey);

  // 4. Create storage manager with local-only storage initially (empty backups)
  const storage = new WalletStorageManager(identityPubKey, localStorage, []);
  await storage.makeAvailable();

  // 5. Create the underlying Wallet FIRST (needed for StorageClient signing)
  const underlyingWallet = new Wallet({
    chain,
    keyDeriver,
    storage,
    services: oneSatServices as unknown as MobileWalletServices,
  });

  // 6. Attempt remote storage connection AFTER wallet exists
  let remoteClient: StorageClient | undefined;
  if (config.remoteStorageUrl) {
    console.log(
      `[createWebWallet] Attempting remote storage connection to ${config.remoteStorageUrl}`,
    );
    try {
      // Create StorageClient with the REAL wallet (not a temp wallet)
      // StorageClient captures the wallet at construction for signing requests
      // deviceId isolates sync state per device to prevent ID mapping corruption
      remoteClient = new StorageClient(
        underlyingWallet as unknown as WalletInterface,
        config.remoteStorageUrl,
        config.deviceId,
      );
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Remote storage connection timeout")),
          DEFAULT_REMOTE_STORAGE_TIMEOUT,
        ),
      );
      await Promise.race([remoteClient.makeAvailable(), timeoutPromise]);

      // Add remote storage to the existing storage manager using public API
      await storage.addWalletStorageProvider(remoteClient);
      console.log("[createWebWallet] Remote storage connected successfully");
    } catch (err) {
      console.log(
        "[createWebWallet] Remote storage connection failed:",
        err instanceof Error ? err.message : err,
      );
      remoteClient = undefined;
    }
  }

  // Log storage state using public APIs
  const stores = storage.getStores();
  console.log("[createWebWallet] Storage state:", {
    activeKey: storage.getActiveStore(),
    backups: storage.getBackupStores(),
    conflictingActives: storage.getConflictingStores(),
    isActiveEnabled: storage.isActiveEnabled,
    allStores: stores.map(s => ({ name: s.storageName, key: s.storageIdentityKey.slice(0, 16) + "..." })),
  });

  // 7. Handle conflicting actives or sync to backups
  const conflictingStores = storage.getConflictingStores();
  const backupStores = storage.getBackupStores();

  if (conflictingStores.length > 0) {
    const localKey = storage.getActiveStore();
    console.log("[createWebWallet] Resolving conflicting actives...");
    try {
      await storage.setActive(localKey, (msg: string) => {
        console.log("[createWebWallet] Conflict resolution:", msg);
        return msg;
      });
      console.log("[createWebWallet] Conflict resolution complete");
    } catch (err: unknown) {
      console.log(
        "[createWebWallet] Conflict resolution failed:",
        err instanceof Error ? err.message : err,
      );
    }
  } else if (backupStores.length > 0) {
    // No conflicts - push local state to remote backup (fire-and-forget)
    console.log("[createWebWallet] Pushing local state to remote backup...");
    storage
      .updateBackups(undefined, (msg: string) => {
        console.log("[createWebWallet] Backup:", msg);
        return msg;
      })
      .then(() => {
        console.log("[createWebWallet] Backup complete");
      })
      .catch((err: unknown) => {
        console.log(
          "[createWebWallet] Backup failed:",
          err instanceof Error ? err.message : err,
        );
      });
  }

  // 8. Wrap with permissions manager
  const wallet = new WalletPermissionsManager(
    underlyingWallet,
    adminOriginator,
    permissionsConfig,
  );

  // 9. Create monitor (not started - consumer calls startTasks() when ready)
  const monitor = new Monitor({
    chain,
    services: oneSatServices as unknown as typeof fallbackServices,
    storage,
    chaintracks: oneSatServices.chaintracks,
    msecsWaitPerMerkleProofServiceReq: 500,
    taskRunWaitMsecs: 5000,
    abandonedMsecs: 300000,
    unprovenAttemptsLimitTest: 10,
    unprovenAttemptsLimitMain: 144,
  });
  monitor.addDefaultTasks();
  console.log("[createWebWallet] Monitor created with tasks:", monitor["_tasks"].map((t: { name: string }) => t.name));

  // Helper to sync to remote backup using public updateBackups API
  const syncToBackup = async (context: string): Promise<void> => {
    if (storage.getBackupStores().length > 0) {
      await storage.updateBackups(undefined, (msg: string) => {
        console.log(`[Monitor] ${context}:`, msg);
        return msg;
      });
    }
  };

  // 10. Wire up monitor callbacks - sync to remote first, then call user callbacks
  monitor.onTransactionBroadcasted = async (result) => {
    console.log("[Monitor] Transaction broadcasted:", result.txid);

    // Sync to remote backup first (if connected)
    if (remoteClient) {
      try {
        await syncToBackup("Backup after broadcast");
        console.log("[Monitor] Synced to backup after broadcast");
      } catch (err) {
        console.warn("[Monitor] Failed to sync after broadcast:", err);
      }
    }

    // Then call user callback (if provided)
    if (result.txid && config.onTransactionBroadcasted) {
      try {
        config.onTransactionBroadcasted(result.txid);
      } catch (err) {
        console.warn("[Monitor] User callback error after broadcast:", err);
      }
    }
  };

  monitor.onTransactionProven = async (status) => {
    console.log("[Monitor] Transaction proven:", status.txid, "block", status.blockHeight);

    // Sync to remote backup first (if connected)
    if (remoteClient) {
      try {
        await syncToBackup("Backup after confirmation");
        console.log("[Monitor] Synced to backup after confirmation");
      } catch (err) {
        console.warn("[Monitor] Failed to sync after confirmation:", err);
      }
    }

    // Then call user callback (if provided)
    if (config.onTransactionProven) {
      try {
        config.onTransactionProven(status.txid, status.blockHeight);
      } catch (err) {
        console.warn("[Monitor] User callback error after proven:", err);
      }
    }
  };

  // 11. Create cleanup function
  const destroy = async (): Promise<void> => {
    monitor.stopTasks();
    await monitor.destroy();
    await underlyingWallet.destroy();
  };

  // 12. Create fullSync function if remote storage is connected
  const fullSyncFn = remoteClient
    ? async (onProgress?: (stage: FullSyncStage, message: string) => void): Promise<FullSyncResult> => {
        return fullSync({
          storage,
          remoteStorage: remoteClient,
          identityKey: identityPubKey,
          onProgress,
        });
      }
    : undefined;

  return {
    wallet,
    rawWallet: underlyingWallet,
    services: oneSatServices,
    monitor,
    destroy,
    fullSync: fullSyncFn,
    storage,
    remoteStorage: remoteClient,
  };
}
