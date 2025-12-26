# Sync Queue Design

## Overview

This document outlines the design for a queue-based sync system that decouples SSE ingestion from transaction processing, enabling background processing, parallelization, and resumability across app restarts.

## Goals

- **Fast initial sync**: Queue outpoints from SSE stream without blocking on network/DB
- **Resumability**: Queue persists, processing continues on next launch
- **Background processing**: User isn't blocked waiting for sync to complete
- **Parallelization**: Process multiple transactions concurrently within batches

## Architecture

### Two-Stage Pipeline

1. **Ingest stage**: SSE stream dumps records into a local queue as fast as possible
2. **Processing stage**: Background worker(s) pull from queue and process

### Queue Storage

The queue storage is independent of wallet-toolbox's storage. We define our own interface with two implementations:

- **Browser**: IndexedDB (native, simple, no dependencies)
- **Node/Bun**: SQLite via `better-sqlite3` (works in both Node and Bun)

### Multi-Tenant Isolation

Each wallet gets its own isolated store, identified by an `accountId` provided by the caller:

```typescript
// Browser: separate IndexedDB database per account
// Database name: `sync-queue-${accountId}`
const queue = new IndexedDbSyncQueue(accountId);

// Node/Bun: separate SQLite file per account
// File path: `${dataDir}/sync-queue-${accountId}.db`
const queue = SqliteSyncQueue.create(accountId, dataDir, Database);
```

The `accountId` can be any unique string - an address, pubkey, hash, or any identifier that makes sense for the application.

## Data Structures

### SyncState

```typescript
interface SyncState {
  lastQueuedScore: number;  // highest score received from SSE, used to resume stream
  lastSyncedAt?: number;    // timestamp of last sync
}
```

### SyncQueueItem

```typescript
interface SyncQueueItem {
  id: string;              // unique per record: `${outpoint}:${score}`
  outpoint: string;        // txid_vout format
  score: number;           // ordering from SSE stream
  spendTxid?: string;      // if this is a spend event
  status: 'pending' | 'processing' | 'done' | 'failed';
  attempts: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}
```

### SyncQueueStorage Interface

```typescript
interface SyncQueueStorage {
  // Queue operations
  enqueue(items: Array<{ outpoint: string; score: number; spendTxid?: string }>): Promise<void>;
  claim(count?: number): Promise<SyncQueueItem[]>;
  complete(id: string): Promise<void>;
  completeMany(ids: string[]): Promise<void>;
  fail(id: string, error: string): Promise<void>;
  
  // Lookup
  getByTxid(txid: string): Promise<SyncQueueItem[]>;
  
  // Stats
  getStats(): Promise<{ pending: number; processing: number; done: number; failed: number }>;
  
  // Sync state
  getState(): Promise<SyncState>;
  setState(state: Partial<SyncState>): Promise<void>;
  
  // Maintenance
  clear(): Promise<void>;
  close(): Promise<void>;
}
```

## SSE Message Handling

For a given outpoint, there can be two SSE messages:

1. **Creation message** (at score X): First time we see this outpoint
2. **Spend message** (at score Y, where Y > X): When the output is spent

If syncing from scratch and output is already spent, the creation message arrives with `spendTxid` populated.

Each message becomes a separate queue record with id `${outpoint}:${score}`.

## Processing Logic

### Processing Rules

1. **Creation with spendTxid populated**: Skip (historical, already spent)
2. **Creation without spendTxid**: Ingest the transaction
3. **Spend event for output we have**: Mark it spent
4. **Spend event for output we don't have**: Skip

### Batch Processing Flow

1. `claim(batchSize)` - atomically mark items as 'processing'
2. For each claimed item, extract txid from outpoint
3. `getByTxid(txid)` - get ALL queue records for this txid (including spends)
4. Capture those record IDs
5. Ingest transaction with spend context from all records
6. `completeMany(capturedIds)` - mark exactly those records complete

### Multi-Output Transaction Handling

When ingesting a transaction:
- `ingestTransaction()` processes all outputs of a tx
- Before ingesting, we query the queue for all items with that txid
- This tells us which outputs are already spent (have spendTxid)
- We can skip saving those, or save them as already spent

### Race Condition Handling

If a new spend event arrives during processing:
- It gets enqueued as a new record
- But we only complete the record IDs we captured before ingesting
- The new spend event remains pending, processed in a later batch (becomes no-op since output already marked spent)

## Parallelization

Within a batch, we can parallelize because:
- Creations insert new outputs (no dependencies between different txids)
- Spends mark existing outputs (independent per outpoint)
- Same txid handled by first claimer; others become no-ops

No strict ordering required since:
- Unspent creations are independent
- Spends only mark outputs (output either exists from prior processing, or we skip)

### Concurrency Model

Processing uses a simple claim-and-group approach with `Promise.all()`:

1. Claim N items from queue (e.g., 20)
2. Group claimed items by txid
3. `Promise.all()` to process each unique txid in parallel
4. Complete all items from the batch
5. Repeat until queue is empty

```
claim(20) → group by txid → [txidA: 15 items, txidB: 3 items, txidC: 2 items]
                          ↓
          Promise.all([process(txidA), process(txidB), process(txidC)])
                          ↓
                    claim next batch
```

The batch size controls concurrency. If all 20 claimed items belong to one large tx, we process one tx. If they're 20 different txs, we process 20 in parallel.

In browsers, the browser's connection limit (typically 6 per origin) naturally throttles network requests. For Node/Bun, the batch size itself provides the throttle.

## Failure Handling

- Retry with exponential backoff
- Most failures are transient (network, unconfirmed tx waiting for merkle path)
- After exhausting retries, mark as `failed`
- Failed items don't block progress
- Failed items may resolve later (tx gets mined, server provides proof)
- On next sync, if item doesn't reappear in SSE stream, it was rolled back by server

## Progress & Events

### Events Emitted During Processing

- `queue:item:processing` - starting to process an item
- `queue:item:complete` - item finished  
- `queue:item:failed` - item failed
- `queue:empty` - queue drained, sync caught up

### Determining Sync State

- "Syncing": queue has pending items
- "Synced": queue is empty
- "X items failed": stuck items exist

`getStats()` provides counts for UI or debugging.

## SSE Stream Behavior

- Stream catches up to current, server sends `done` event
- Client reconnects to stay live for new transactions
- `lastQueuedScore` used as `fromScore` parameter when resuming
- SSE is essentially always running; queue depth indicates work remaining

### Reorg Protection

The `score` field is `blockHeight.blockIndex` as a decimal (e.g., `800123.045` = block 800123, tx index 45).

To handle reorgs while disconnected, we maintain a 6-block safety window:

```typescript
const blockHeight = Math.floor(output.score);
const currentHeight = await this.services.getHeight();
if (blockHeight <= currentHeight - 6) {
  await queue.setState({ lastQueuedScore: output.score });
}
```

Items in the last 6 blocks get queued and processed, but `lastQueuedScore` doesn't advance past the safe window. On reconnect, we re-fetch those recent blocks. Duplicates are no-ops since we check if the transaction is already ingested.

## Integration with OneSatWallet

### Ownership

`OneSatWallet` owns the queue instance. It derives the pubkey from `keyDeriver` and creates the appropriate queue implementation.

### Unified Sync Method

`syncAddress()` is removed. `syncAll()` is renamed to `sync()` and becomes the single public sync method.

### Sync Lifecycle

When `sync()` is called:
1. Get `lastQueuedScore` from queue state
2. Open SSE connection with `fromScore`
3. SSE delivers outpoints → `queue.enqueue()`
4. Processing loop runs concurrently, claiming and processing batches
5. When SSE disconnects or `stopSync()` is called, processing drains remaining queue
6. Emit `sync:complete` when queue is empty and SSE is done

### Queue Creation

The caller creates the queue with an account identifier and passes it to the wallet:

```typescript
// Browser
const queue = new IndexedDbSyncQueue(accountId);
const wallet = new OneSatWallet({ ..., syncQueue: queue });

// Node/Bun
const queue = SqliteSyncQueue.create(accountId, dataDir, Database);
const wallet = new OneSatWallet({ ..., syncQueue: queue });
```

If no queue is provided, `sync()` will throw an error.

## File Structure

```
src/
  sync/
    types.ts                # SyncQueueStorage interface, SyncQueueItem, SyncState
    IndexedDbSyncQueue.ts   # Browser implementation
    SqliteSyncQueue.ts      # Node/Bun implementation
    index.ts                # Exports
```

## Maintenance Operations

### clear()

Resets the queue to initial state:
1. Deletes all queue items
2. Resets `lastQueuedScore` to 0

Next sync opens SSE with `fromScore=0` and receives full history.

Use cases:
- User wants a clean resync
- Data corruption recovery
- Debugging

## Implementation Status

- [x] Types (`src/sync/types.ts`)
- [x] IndexedDB implementation (`src/sync/IndexedDbSyncQueue.ts`)
- [x] SQLite implementation (`src/sync/SqliteSyncQueue.ts`)
- [x] Integration with OneSatWallet
- [x] Text content extraction for inscriptions (stored in `customInstructions`, truncated to 1000 chars)
- [ ] Tests
