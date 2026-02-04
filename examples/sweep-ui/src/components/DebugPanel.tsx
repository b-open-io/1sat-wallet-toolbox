"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { WebWalletResult, FullSyncResult } from "@1sat/wallet-toolbox";

// Types for IDB inspection
interface TableStats {
  name: string;
  count: number;
  duplicates?: { key: string; count: number }[];
}

interface DbStats {
  name: string;
  version: number;
  tables: TableStats[];
}

interface DebugPanelProps {
  wallet: WebWalletResult | null;
  addLog: (msg: string) => void;
  /** Optional: separate destination wallet created from WIF */
  destWallet?: WebWalletResult | null;
  /** Callback to create destination wallet from WIF */
  onCreateDestWallet?: (wif: string) => Promise<void>;
  /** Callback to destroy destination wallet */
  onDestroyDestWallet?: () => Promise<void>;
  /** Whether destination wallet is being created */
  destWalletLoading?: boolean;
}

// Helper to check for duplicates by a specific index
async function findDuplicatesByIndex(
  db: IDBDatabase,
  storeName: string,
  indexName: string
): Promise<{ key: string; count: number }[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);

    try {
      const index = store.index(indexName);
      const keyCounts = new Map<string, number>();
      const request = index.openKeyCursor();

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          const key = String(cursor.key);
          keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
          cursor.continue();
        } else {
          // Done iterating
          const duplicates = Array.from(keyCounts.entries())
            .filter(([_, count]) => count > 1)
            .map(([key, count]) => ({ key, count }));
          resolve(duplicates);
        }
      };

      request.onerror = () => reject(request.error);
    } catch (e) {
      // Index doesn't exist
      resolve([]);
    }
  });
}

// Get all records from a store
async function getAllRecords(db: IDBDatabase, storeName: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Get store count
async function getStoreCount(db: IDBDatabase, storeName: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const request = store.count();

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Index configurations for duplicate checking
const INDEX_CONFIGS: Record<string, string[]> = {
  users: ["identityKey"],
  provenTxs: ["txid"],
  provenTxReqs: ["txid"],
  transactions: ["reference"],
  outputs: ["transactionId_vout_userId"],
  outputBaskets: ["name_userId"],
  txLabels: ["label_userId"],
  outputTags: ["tag_userId"],
  commissions: ["transactionId"],
  certificates: ["serialNumber_certifierId_type_subject"],
};

export function DebugPanel({
  wallet,
  addLog,
  destWallet,
  onCreateDestWallet,
  onDestroyDestWallet,
  destWalletLoading
}: DebugPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [dbStats, setDbStats] = useState<DbStats[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableRecords, setTableRecords] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [lastSyncResult, setLastSyncResult] = useState<FullSyncResult | null>(null);
  const [destWif, setDestWif] = useState("");
  const [activeTab, setActiveTab] = useState<"sync" | "dest" | "db">("sync");

  // Helper to log to both console and activity log
  const log = useCallback((msg: string) => {
    console.log(msg);
    addLog(msg);
  }, [addLog]);

  // Full Sync with remote
  const runFullSync = useCallback(async () => {
    if (!wallet?.fullSync) {
      log("[SYNC] Full sync not available (no remote storage connected)");
      return;
    }

    setLoading(true);
    setSyncStatus("Starting full sync...");
    setLastSyncResult(null);

    try {
      log("[SYNC] Starting full sync...");

      const result = await wallet.fullSync((stage, message) => {
        log(`[SYNC] [${stage}] ${message}`);
        setSyncStatus(`${stage}: ${message}`);
      });

      setLastSyncResult(result);
      setSyncStatus("Complete");
      log(`[SYNC] Full sync complete!`);
      log(`[SYNC]   Pushed: ${result.pushed.inserts} inserts, ${result.pushed.updates} updates`);
      log(`[SYNC]   Pulled: ${result.pulled.inserts} inserts, ${result.pulled.updates} updates`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSyncStatus(`Error: ${msg}`);
      log(`[SYNC] Full sync failed: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [wallet, log]);

  // Inspect WalletStorageManager internal state
  const inspectStorageState = useCallback(async () => {
    const targetWallet = destWallet || wallet;
    if (!targetWallet) {
      log("[DEBUG] No wallet available");
      return;
    }

    setLoading(true);
    try {
      log("[DEBUG] Inspecting WalletStorageManager state...");

      const storage = targetWallet.storage as unknown as {
        getActiveStore?: () => string;
        getBackupStores?: () => string[];
        getConflictingStores?: () => string[];
        getStores?: () => Array<{
          isActive: boolean;
          isEnabled: boolean;
          isBackup: boolean;
          isConflicting: boolean;
          storageIdentityKey: string;
          storageName: string;
        }>;
        isActiveEnabled?: boolean;
        getAuth?: () => Promise<{ userId: number; identityKey: string }>;
        runAsStorageProvider?: (fn: (sp: unknown) => Promise<void>) => Promise<void>;
      };

      const activeStore = storage.getActiveStore?.() || "none";
      const backupStores = storage.getBackupStores?.() || [];
      const conflictingStores = storage.getConflictingStores?.() || [];
      const allStores = storage.getStores?.() || [];

      log(`[DEBUG] Active: ${activeStore}`);
      log(`[DEBUG] Backups: ${JSON.stringify(backupStores)}`);
      log(`[DEBUG] Conflicts: ${JSON.stringify(conflictingStores)}`);
      log(`[DEBUG] isActiveEnabled: ${storage.isActiveEnabled}`);
      log(`[DEBUG] All stores: ${JSON.stringify(allStores.map(s => ({ name: s.storageName, key: s.storageIdentityKey.slice(0, 16) + "..." })))}`);

      if (storage.getAuth && storage.runAsStorageProvider) {
        const auth = await storage.getAuth();
        log(`[DEBUG] Auth: userId=${auth.userId}, identityKey=${auth.identityKey.slice(0, 16)}...`);

        await storage.runAsStorageProvider(async (sp: unknown) => {
          const provider = sp as {
            findSyncStates?: (args: { partial: { userId: number } }) => Promise<Array<{
              syncStateId: number;
              storageIdentityKey: string;
              storageName: string;
              status: string;
              when?: string;
              syncMap?: string;
            }>>;
          };
          if (provider.findSyncStates) {
            const syncStates = await provider.findSyncStates({ partial: { userId: auth.userId } });
            log(`[DEBUG] Found ${syncStates.length} sync states:`);
            for (const ss of syncStates) {
              log(`[DEBUG]   - ${ss.storageName} (${ss.storageIdentityKey?.slice(0, 16)}...)`);
              log(`[DEBUG]     status=${ss.status}, when=${ss.when || "undefined"}`);
              if (ss.syncMap) {
                try {
                  const map = JSON.parse(ss.syncMap);
                  const entities = Object.keys(map).filter(k => map[k]?.count > 0);
                  log(`[DEBUG]     syncMap entities with data: ${entities.join(", ") || "none"}`);
                } catch {
                  log(`[DEBUG]     syncMap: ${ss.syncMap.slice(0, 100)}...`);
                }
              }
            }
          }
        });
      }
    } catch (e) {
      log(`[DEBUG] Error inspecting storage: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [wallet, destWallet, log]);

  // Manual pull from remote (skip push)
  const manualPullFromRemote = useCallback(async () => {
    const targetWallet = destWallet || wallet;
    if (!targetWallet) {
      log("[PULL] No wallet available");
      return;
    }

    setLoading(true);
    try {
      log("[PULL] Starting manual pull from remote (no push)...");

      const storage = targetWallet.storage as unknown as {
        getAuth?: () => Promise<{ userId: number; identityKey: string }>;
        getBackupStores?: () => string[];
        syncFromReader?: (identityKey: string, remote: unknown) => Promise<{ inserts: number; updates: number; log?: string }>;
        _stores?: Array<{ storage: unknown; settings?: { storageIdentityKey: string } }>;
      };

      if (!storage?.getAuth || !storage?.syncFromReader) {
        log("[PULL] Storage methods not available");
        return;
      }

      const backupStoreKeys = storage.getBackupStores?.() || [];
      if (backupStoreKeys.length === 0) {
        log("[PULL] No remote backup connected");
        return;
      }

      const backupStore = storage._stores?.find(s =>
        s.settings?.storageIdentityKey && backupStoreKeys.includes(s.settings.storageIdentityKey)
      );
      if (!backupStore) {
        log("[PULL] Could not find backup store");
        return;
      }

      const auth = await storage.getAuth();
      log(`[PULL] Pulling with identityKey: ${auth.identityKey.slice(0, 16)}...`);

      const result = await storage.syncFromReader(auth.identityKey, backupStore.storage);
      log(`[PULL] Pull complete!`);
      log(`[PULL]   inserts: ${result.inserts}`);
      log(`[PULL]   updates: ${result.updates}`);
      if (result.log) {
        log(`[PULL]   log: ${result.log}`);
      }
    } catch (e) {
      log(`[PULL] Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [wallet, destWallet, log]);

  // Check what getSyncChunk returns from remote
  const checkRemoteSyncChunk = useCallback(async () => {
    const targetWallet = destWallet || wallet;
    if (!targetWallet) {
      log("[CHUNK] No wallet available");
      return;
    }

    setLoading(true);
    try {
      log("[CHUNK] Checking getSyncChunk from remote...");

      const storage = targetWallet.storage;
      const remoteStorage = targetWallet.remoteStorage as {
        getSyncChunk?: (args: unknown) => Promise<Record<string, unknown[]>>;
        getSettings?: () => { storageIdentityKey: string };
      } | undefined;

      if (!storage) {
        log("[CHUNK] No storage on wallet");
        return;
      }

      if (!remoteStorage) {
        log("[CHUNK] No remote storage connected");
        return;
      }

      if (!remoteStorage.getSyncChunk || !remoteStorage.getSettings) {
        log("[CHUNK] Remote storage missing required methods");
        return;
      }

      const auth = await storage.getAuth();
      const localSettings = storage.getSettings();
      const remoteSettings = remoteStorage.getSettings();

      const args = {
        identityKey: auth.identityKey,
        fromStorageIdentityKey: remoteSettings.storageIdentityKey,
        toStorageIdentityKey: localSettings.storageIdentityKey,
        since: undefined, // full pull
        maxRoughSize: 10000000,
        maxItems: 1000,
        offsets: [], // start from 0 for all entities
      };

      log(`[CHUNK] Requesting chunk with args:`);
      log(`[CHUNK]   identityKey: ${auth.identityKey.slice(0, 16)}...`);
      log(`[CHUNK]   from: ${remoteSettings.storageIdentityKey.slice(0, 16)}...`);
      log(`[CHUNK]   to: ${localSettings.storageIdentityKey.slice(0, 16)}...`);

      const chunk = await remoteStorage.getSyncChunk(args);

      // Summarize chunk contents
      const summary: Record<string, number> = {};
      for (const [key, value] of Object.entries(chunk)) {
        if (Array.isArray(value) && value.length > 0) {
          summary[key] = value.length;
        }
      }

      if (Object.keys(summary).length === 0) {
        log("[CHUNK] Remote returned EMPTY chunk - no data!");
      } else {
        log("[CHUNK] Remote chunk summary:");
        for (const [entity, count] of Object.entries(summary)) {
          log(`[CHUNK]   ${entity}: ${count} items`);
        }
      }
    } catch (e) {
      log(`[CHUNK] Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [wallet, destWallet, log]);

  // Create destination wallet from WIF
  const handleCreateDestWallet = useCallback(async () => {
    if (!destWif.trim() || !onCreateDestWallet) return;
    try {
      await onCreateDestWallet(destWif.trim());
    } catch (e) {
      log(`[DEST] Error creating wallet: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [destWif, onCreateDestWallet, log]);

  // List all IndexedDB databases
  const scanDatabases = useCallback(async () => {
    setLoading(true);
    log("[DEBUG] Scanning IndexedDB databases...");

    try {
      const dbs = await indexedDB.databases();
      log(`[DEBUG] Found ${dbs.length} databases: ${dbs.map(d => d.name).join(", ")}`);

      const stats: DbStats[] = [];

      for (const dbInfo of dbs) {
        if (!dbInfo.name) continue;

        try {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(dbInfo.name!, dbInfo.version);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });

          const tableStats: TableStats[] = [];

          for (const storeName of Array.from(db.objectStoreNames)) {
            const count = await getStoreCount(db, storeName);
            const tableInfo: TableStats = { name: storeName, count };

            // Check for duplicates using configured indexes
            const indexes = INDEX_CONFIGS[storeName] || [];
            for (const indexName of indexes) {
              const dups = await findDuplicatesByIndex(db, storeName, indexName);
              if (dups.length > 0) {
                tableInfo.duplicates = dups;
                log(`[DEBUG] DUPLICATES in ${dbInfo.name}.${storeName}.${indexName}: ${JSON.stringify(dups)}`);
              }
            }

            tableStats.push(tableInfo);
          }

          stats.push({
            name: dbInfo.name,
            version: dbInfo.version || 0,
            tables: tableStats,
          });

          db.close();
        } catch (e) {
          log(`[DEBUG] Error opening ${dbInfo.name}: ${e}`);
        }
      }

      setDbStats(stats);
      log("[DEBUG] Database scan complete");
    } catch (e) {
      log(`[DEBUG] Error scanning databases: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [log]);

  // View records in a specific table
  const viewTable = useCallback(async (dbName: string, tableName: string) => {
    setLoading(true);
    log(`[DEBUG] Loading records from ${dbName}.${tableName}...`);

    try {
      const dbInfo = dbStats.find(d => d.name === dbName);
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName, dbInfo?.version);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      const records = await getAllRecords(db, tableName);
      setTableRecords(records);
      setSelectedTable(`${dbName}.${tableName}`);
      log(`[DEBUG] Loaded ${records.length} records from ${dbName}.${tableName}`);

      db.close();
    } catch (e) {
      log(`[DEBUG] Error loading records: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [dbStats, log]);

  // Clear a specific database
  const clearDatabase = useCallback(async (dbName: string) => {
    if (!confirm(`Are you sure you want to delete database "${dbName}"? This cannot be undone.`)) {
      return;
    }

    log(`[DEBUG] Deleting database ${dbName}...`);

    try {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(dbName);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => log(`[DEBUG] Database deletion blocked - close other tabs`);
      });

      log(`[DEBUG] Database ${dbName} deleted`);
      await scanDatabases();
    } catch (e) {
      log(`[DEBUG] Error deleting database: ${e}`);
    }
  }, [log, scanDatabases]);

  // Backup a database by copying all data to a new database with -backup suffix
  const backupDatabase = useCallback(async (dbName: string) => {
    const backupName = `${dbName}-backup-${Date.now()}`;
    log(`[DEBUG] Backing up ${dbName} to ${backupName}...`);
    setLoading(true);

    try {
      // Open source database
      const dbInfo = dbStats.find(d => d.name === dbName);
      const sourceDb = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName, dbInfo?.version);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      const storeNames = Array.from(sourceDb.objectStoreNames);
      log(`[DEBUG] Found ${storeNames.length} stores to backup`);

      // Create backup database with same structure
      const backupDb = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(backupName, 1);
        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          // Recreate all object stores
          for (const storeName of storeNames) {
            const sourceStore = sourceDb.transaction(storeName, "readonly").objectStore(storeName);
            const newStore = db.createObjectStore(storeName, {
              keyPath: sourceStore.keyPath as string | null,
              autoIncrement: sourceStore.autoIncrement,
            });
            // Copy indexes
            for (const indexName of Array.from(sourceStore.indexNames)) {
              const index = sourceStore.index(indexName);
              newStore.createIndex(indexName, index.keyPath, {
                unique: index.unique,
                multiEntry: index.multiEntry,
              });
            }
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      // Copy all data from each store
      for (const storeName of storeNames) {
        const records = await getAllRecords(sourceDb, storeName);
        if (records.length > 0) {
          const tx = backupDb.transaction(storeName, "readwrite");
          const store = tx.objectStore(storeName);
          for (const record of records) {
            store.add(record);
          }
          await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
          log(`[DEBUG] Copied ${records.length} records from ${storeName}`);
        }
      }

      sourceDb.close();
      backupDb.close();
      log(`[DEBUG] Backup complete: ${backupName}`);
      await scanDatabases();
    } catch (e) {
      log(`[DEBUG] Error backing up database: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [dbStats, log, scanDatabases]);

  if (!expanded) {
    return (
      <Card className="fixed bottom-4 right-4 p-3 bg-black/90 border-yellow-500/50 z-50">
        <Button
          onClick={() => setExpanded(true)}
          size="sm"
          variant="outline"
          className="text-yellow-500 border-yellow-500/50"
        >
          🔧 Debug Panel
        </Button>
      </Card>
    );
  }

  const hasFullSync = !!wallet?.fullSync;
  const hasDestWallet = !!destWallet;

  return (
    <Card className="fixed bottom-4 right-4 w-[700px] max-h-[85vh] p-4 bg-black/95 border-yellow-500/50 z-50 overflow-hidden flex flex-col">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-yellow-500 font-bold m-0">🔧 Debug Panel</h3>
        <Button
          onClick={() => setExpanded(false)}
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
        >
          ✕
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-4 border-b border-border pb-2">
        <Button
          onClick={() => setActiveTab("sync")}
          size="sm"
          variant={activeTab === "sync" ? "default" : "ghost"}
          className="text-xs"
        >
          Sync Debug
        </Button>
        <Button
          onClick={() => setActiveTab("dest")}
          size="sm"
          variant={activeTab === "dest" ? "default" : "ghost"}
          className="text-xs"
        >
          Dest Wallet
        </Button>
        <Button
          onClick={() => setActiveTab("db")}
          size="sm"
          variant={activeTab === "db" ? "default" : "ghost"}
          className="text-xs"
        >
          Databases
        </Button>
      </div>

      {/* Sync Debug Tab */}
      {activeTab === "sync" && (
        <div className="flex-1 overflow-y-auto">
          {/* Remote Sync Section */}
          <div className="mb-4 p-3 bg-blue-950/30 border border-blue-500/30 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-blue-400">Remote Sync</span>
              {hasFullSync ? (
                <span className="text-xs text-green-500">● Connected</span>
              ) : (
                <span className="text-xs text-muted-foreground">○ No remote</span>
              )}
            </div>
            <div className="flex gap-2 items-center flex-wrap">
              <Button
                onClick={runFullSync}
                disabled={loading || !hasFullSync}
                size="sm"
                variant="outline"
                className={cn(
                  "text-xs",
                  hasFullSync ? "border-blue-500/50 text-blue-400" : "opacity-50"
                )}
              >
                {loading && syncStatus ? "Syncing..." : "Full Sync"}
              </Button>
              {syncStatus && (
                <span className={cn(
                  "text-xs",
                  syncStatus.startsWith("Error") ? "text-destructive" : "text-muted-foreground"
                )}>
                  {syncStatus}
                </span>
              )}
            </div>
            {lastSyncResult && (
              <div className="mt-2 text-xs text-muted-foreground">
                <div>↑ Pushed: {lastSyncResult.pushed.inserts} inserts, {lastSyncResult.pushed.updates} updates</div>
                <div>↓ Pulled: {lastSyncResult.pulled.inserts} inserts, {lastSyncResult.pulled.updates} updates</div>
              </div>
            )}
          </div>

          {/* Sync Investigation Tools */}
          <div className="mb-4 p-3 bg-purple-950/30 border border-purple-500/30 rounded-lg">
            <div className="text-sm font-semibold text-purple-400 mb-3">Sync Investigation</div>
            <div className="flex gap-2 flex-wrap">
              <Button
                onClick={inspectStorageState}
                disabled={loading || (!wallet && !destWallet)}
                size="sm"
                variant="outline"
                className="text-xs border-purple-500/50 text-purple-400"
              >
                Inspect Storage
              </Button>
              <Button
                onClick={manualPullFromRemote}
                disabled={loading || (!wallet && !destWallet)}
                size="sm"
                variant="outline"
                className="text-xs border-purple-500/50 text-purple-400"
              >
                Manual Pull (No Push)
              </Button>
              <Button
                onClick={checkRemoteSyncChunk}
                disabled={loading || (!wallet && !destWallet)}
                size="sm"
                variant="outline"
                className="text-xs border-purple-500/50 text-purple-400"
              >
                Check Remote Chunk
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-2">
              These tools help investigate why sync isn't working. Use with {hasDestWallet ? "destination" : "main"} wallet.
            </p>
          </div>
        </div>
      )}

      {/* Destination Wallet Tab */}
      {activeTab === "dest" && (
        <div className="flex-1 overflow-y-auto">
          <div className="mb-4 p-3 bg-green-950/30 border border-green-500/30 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-green-400">Destination Wallet (Fresh IDB)</span>
              {hasDestWallet ? (
                <span className="text-xs text-green-500">● Created</span>
              ) : (
                <span className="text-xs text-muted-foreground">○ Not created</span>
              )}
            </div>

            {!hasDestWallet ? (
              <>
                <p className="text-xs text-muted-foreground mb-3">
                  Create a fresh wallet with a new IDB database (simulates Chromium fresh install).
                  Uses the same remote storage URL as yours-wallet.
                </p>
                <div className="flex gap-2 items-center">
                  <Input
                    type="password"
                    placeholder="Destination WIF (starts with K, L, or 5)"
                    value={destWif}
                    onChange={(e) => setDestWif(e.target.value)}
                    className="flex-1 text-xs bg-black/30 font-mono"
                    disabled={destWalletLoading}
                  />
                  <Button
                    onClick={handleCreateDestWallet}
                    disabled={!destWif.trim() || !onCreateDestWallet || destWalletLoading}
                    size="sm"
                    className="text-xs bg-green-600 hover:bg-green-700"
                  >
                    {destWalletLoading ? "Creating..." : "Create"}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-xs text-muted-foreground mb-3">
                  Destination wallet active. Use Sync Debug tab to investigate sync behavior.
                </p>
                <Button
                  onClick={onDestroyDestWallet}
                  size="sm"
                  variant="outline"
                  className="text-xs border-destructive text-destructive"
                >
                  Destroy Wallet
                </Button>
              </>
            )}
          </div>

          {hasDestWallet && (
            <div className="p-3 bg-black/30 rounded-lg">
              <div className="text-xs font-semibold text-muted-foreground mb-2">Quick Actions</div>
              <div className="flex gap-2 flex-wrap">
                <Button
                  onClick={async () => {
                    if (!destWallet?.fullSync) return;
                    setLoading(true);
                    log("[DEST SYNC] Starting full sync...");
                    try {
                      const result = await destWallet.fullSync((stage, message) => {
                        log(`[DEST SYNC] [${stage}] ${message}`);
                      });
                      log(`[DEST SYNC] Complete: pushed ${result.pushed.inserts}/${result.pushed.updates}, pulled ${result.pulled.inserts}/${result.pulled.updates}`);
                    } catch (err) {
                      log(`[DEST SYNC] ERROR: ${err}`);
                      console.error("[DEST SYNC] Error:", err);
                    } finally {
                      setLoading(false);
                    }
                  }}
                  disabled={loading || !destWallet?.fullSync}
                  size="sm"
                  variant="outline"
                  className="text-xs"
                >
                  Full Sync (Dest)
                </Button>
                <Button
                  onClick={inspectStorageState}
                  disabled={loading}
                  size="sm"
                  variant="outline"
                  className="text-xs"
                >
                  Inspect Storage (Dest)
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Databases Tab */}
      {activeTab === "db" && (
        <div className="flex-1 overflow-y-auto">
          {/* Database Actions */}
          <div className="flex gap-2 mb-4 flex-wrap">
            <Button
              onClick={scanDatabases}
              disabled={loading}
              size="sm"
              variant="outline"
              className="text-xs"
            >
              {loading && !syncStatus ? "Scanning..." : "Scan Databases"}
            </Button>
          </div>

          {/* Database Stats */}
          {dbStats.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-muted-foreground mb-2">
                DATABASES ({dbStats.length})
              </div>
              {dbStats.map((db) => (
                <div key={db.name} className="mb-3 p-3 bg-black/50 rounded-lg">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-foreground">
                      {db.name} <span className="text-muted-foreground">v{db.version}</span>
                    </span>
                    <div className="flex gap-1">
                      <Button
                        onClick={() => backupDatabase(db.name)}
                        size="sm"
                        variant="ghost"
                        className="text-blue-400 text-xs h-6 px-2"
                        disabled={loading}
                      >
                        Backup
                      </Button>
                      <Button
                        onClick={() => clearDatabase(db.name)}
                        size="sm"
                        variant="ghost"
                        className="text-destructive text-xs h-6 px-2"
                      >
                        Delete
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-1">
                    {db.tables.map((table) => (
                      <div
                        key={table.name}
                        className={cn(
                          "flex justify-between items-center px-2 py-1 rounded cursor-pointer hover:bg-white/5",
                          table.duplicates && table.duplicates.length > 0 && "bg-destructive/20"
                        )}
                        onClick={() => viewTable(db.name, table.name)}
                      >
                        <span className="text-xs text-muted-foreground">{table.name}</span>
                        <span className="text-xs">
                          {table.count} records
                          {table.duplicates && table.duplicates.length > 0 && (
                            <span className="text-destructive ml-2">
                              ⚠ {table.duplicates.length} dup keys
                            </span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Table Records View */}
          {selectedTable && (
            <div className="mt-4 border-t border-border pt-4">
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-semibold text-muted-foreground">
                  {selectedTable} ({tableRecords.length} records)
                </span>
                <Button
                  onClick={() => setSelectedTable(null)}
                  size="sm"
                  variant="ghost"
                  className="text-xs h-6 px-2"
                >
                  Close
                </Button>
              </div>
              <div className="max-h-[200px] overflow-y-auto bg-black/50 rounded p-2">
                <pre className="text-[10px] text-muted-foreground whitespace-pre-wrap">
                  {JSON.stringify(tableRecords, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
