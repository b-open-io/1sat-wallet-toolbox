"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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

export function DebugPanel({ wallet, addLog }: DebugPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [dbStats, setDbStats] = useState<DbStats[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableRecords, setTableRecords] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [lastSyncResult, setLastSyncResult] = useState<FullSyncResult | null>(null);

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

      const result = await wallet.fullSync();

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

  return (
    <Card className="fixed bottom-4 right-4 w-[600px] max-h-[80vh] p-4 bg-black/95 border-yellow-500/50 z-50 overflow-hidden flex flex-col">
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

      {/* Sync Section */}
      <div className="mb-4 p-3 bg-blue-950/30 border border-blue-500/30 rounded-lg">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-blue-400">Remote Sync</span>
          {hasFullSync ? (
            <span className="text-xs text-green-500">● Connected</span>
          ) : (
            <span className="text-xs text-muted-foreground">○ No remote</span>
          )}
        </div>
        <div className="flex gap-2 items-center">
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
        <div className="flex-1 overflow-y-auto">
          <div className="text-xs font-semibold text-muted-foreground mb-2">
            DATABASES ({dbStats.length})
          </div>
          {dbStats.map((db) => (
            <div key={db.name} className="mb-3 p-3 bg-black/50 rounded-lg">
              <div className="flex justify-between items-center mb-2">
                <span className="text-sm font-medium text-foreground">
                  {db.name} <span className="text-muted-foreground">v{db.version}</span>
                </span>
                <Button
                  onClick={() => clearDatabase(db.name)}
                  size="sm"
                  variant="ghost"
                  className="text-destructive text-xs h-6 px-2"
                >
                  Delete
                </Button>
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
    </Card>
  );
}
