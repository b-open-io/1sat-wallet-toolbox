# fullSync Diagnosis Plan

## Executive Summary

**ROOT CAUSE IDENTIFIED:** Multiple wallet instances (same identity key) share the same `SyncState` on the server because `storageIdentityKey` is derived from the wallet's public key, not unique per device. This causes ID mappings from different local databases to be intermixed, corrupting record associations during sync.

**Recommended Fix:** Include a device identifier in the SyncState key (Fix Option 3). Each device should have its own SyncState with isolated ID mappings, preventing cross-device ID collision.

---

## Problem Statement

The fullSync process between BRC-100 wallets and remote backup storage has corrupted data:
- `customInstructions` associated with wrong output records
- Records that should have JSON now contain base64 data (data from different outputs)
- Tags appearing on wrong outputs
- 51 outputs with NULL `tx_id` (orphan records from failed transactions)

Multiple fullSync operations from different wallet instances have corrupted databases. The goal is to identify where data mapping goes wrong during sync.

## Repositories Involved

| Repo | Role | Controllable |
|------|------|--------------|
| `1sat-wallet-toolbox` | Defines `fullSync()` utility, consumes sync primitives | Yes |
| `yours-wallet` | Chrome extension wallet, consumes wallet factory | Yes |
| `wallet-toolbox` | Core BRC-100 wallet, Storage interface, sync primitives | PR contribution |
| `go-wallet-toolbox` | Go port, remote backup storage server | PR contribution |

## Architecture Understanding

### The fullSync Process

`fullSync()` in `1sat-wallet-toolbox/src/wallet/fullSync.ts` is a utility built on top of the sync primitives in `wallet-toolbox`.

**Three Stages:**

1. **PUSH** (Lines 71-119) - Local → Remote
   - Fetches local sync state from remote storage
   - Overrides `since` to `undefined` (forces ALL data regardless of timestamp)
   - Loops through chunks: `storage.runAsSync()` → `remoteStorage.processSyncChunk()`

2. **RESET** (Lines 122-145) - Clear sync state
   - Finds existing sync state for user/remote
   - Resets `syncMap = {}`, `when = undefined`, `status = "unknown"`
   - Forces full pull on next stage

3. **PULL** (Lines 148-155) - Remote → Local
   - Calls `storage.syncFromReader()` with remote storage as reader
   - Performs full pull because sync state was reset

### Key Data Structures

**SyncChunk** - Data packet for sync operations:
```typescript
interface SyncChunk {
  fromStorageIdentityKey: string
  toStorageIdentityKey: string
  userIdentityKey: string
  user?: TableUser
  provenTxs?: TableProvenTx[]
  transactions?: TableTransaction[]
  outputs?: TableOutput[]
  outputBaskets?: TableOutputBasket[]
  txLabels?: TableTxLabel[]
  outputTags?: TableOutputTag[]
  // ... other entities
}
```

**SyncState.syncMap** - Tracks ID mappings between storages:
```typescript
{
  idMap: {
    outputs: { [remoteId]: localId },
    transactions: { [remoteId]: localId },
    // ... per entity type
  },
  count: number,        // Offset for pagination
  maxUpdated_at: Date   // Last sync timestamp
}
```

**Entity Sync Order** (dependency order):
1. ProvenTxs
2. ProvenTxReqs
3. OutputBaskets
4. TxLabels
5. OutputTags
6. Transactions
7. TxLabelMaps
8. Commissions
9. Outputs (depends on Transactions)
10. OutputTagMaps (depends on Outputs, OutputTags)
11. Certificates
12. CertificateFields

### Remote Backup Server (Go)

`go-wallet-toolbox/pkg/storage/server.go` exposes JSON-RPC API:
- `GetSyncChunk` - Returns chunk of data for pulling
- `ProcessSyncChunk` - Receives and merges pushed data

Authentication via BSV signature middleware.

## Potential Failure Points

### 1. ID Mapping During Merge

When a chunk arrives, each entity is inserted (new) or updated (existing). The `syncMap.idMap` tracks: "remote ID 5 = local ID 10".

**Locations:**
- TS: `wallet-toolbox/src/storage/schema/entities/EntitySyncState.ts#L323-388`
- Go: `go-wallet-toolbox/pkg/storage/internal/sync/chunk_processor.go`

**Risk:** If insert fails silently or returns wrong ID, mapping is corrupted for all future syncs.

### 2. Entity Order Dependency

Outputs reference `transactionId` which must already be mapped from a prior entity in the chunk.

**Risk:** If transaction mapping is wrong, all outputs for that transaction get associated with wrong transaction.

### 3. The `since=undefined` Override

`1sat-wallet-toolbox/src/wallet/fullSync.ts#L95` forces `since=undefined`.

**Status:** Intentional behavior. This ensures fullSync pulls ALL user data from the server, including records created on other devices. Cross-device data sharing is a core use case.

### 4. Reset Phase Timing

Between PUSH and PULL, sync state is reset. No apparent locking mechanism.

**Risk:** Concurrent sync operations could interleave and corrupt state.

### 5. IndexedDB Transaction Boundaries

Known issues with IDB implementation breaking transaction boundaries (per user report).

**Risk:** Partial writes leave database in inconsistent state.

### 6. Field Transformation During Sync

`customInstructions` is supposedly passed through unchanged, but base64 data appearing instead of JSON suggests transformation or field swapping.

**Status:** Confirmed NOT the issue. `customInstructions` passes through unchanged in both TS and Go implementations. The corruption was caused by wrong record matching (shared SyncState), not field transformation.

## Audit Plan

### Audit 1: ID Mapping Integrity

**Question:** When an output is inserted/updated, does the ID mapping correctly track remote → local?

| Repository | File | Check |
|------------|------|-------|
| wallet-toolbox | `src/storage/schema/entities/EntitySyncState.ts` | `mergeSyncMap()` L206-216 |
| wallet-toolbox | `src/storage/methods/processSyncChunk.ts` | Insert/update return values |
| go-wallet-toolbox | `pkg/storage/internal/sync/chunk_processor.go` | Go equivalent logic |

### Audit 2: Output ↔ Transaction Association

**Question:** When outputs sync, do they correctly reference their parent transaction?

| Repository | File | Check |
|------------|------|-------|
| wallet-toolbox | `src/storage/schema/tables/TableOutput.ts` | `transactionId` FK resolution |
| wallet-toolbox | `src/storage/methods/processSyncChunk.ts` | Uses mapped ID or raw ID? |
| go-wallet-toolbox | `pkg/storage/internal/sync/chunk_processor.go` | Same for Go |

### Audit 3: customInstructions Field Flow

**Question:** Does customInstructions pass through unchanged?

| Repository | File | Check |
|------------|------|-------|
| wallet-toolbox | `src/storage/methods/createAction.ts#L393` | Initial storage |
| wallet-toolbox | `src/storage/schema/entities/EntityOutput.ts` | Serialization |
| go-wallet-toolbox | `pkg/storage/internal/sync/chunk_processor.go#L378` | Pass-through? |
| go-wallet-toolbox | `pkg/wdk/types.go` | Type definition |

### Audit 4: Concurrent Sync Safety

**Question:** Can two sync operations interleave?

| Repository | File | Check |
|------------|------|-------|
| 1sat-wallet-toolbox | `src/wallet/fullSync.ts` | Locking mechanism? |
| wallet-toolbox | `src/storage/WalletStorageManager.ts` | Transaction isolation |

### Audit 5: IndexedDB Transaction Boundaries

**Question:** Are IDB operations atomic?

| Repository | File | Check |
|------------|------|-------|
| wallet-toolbox | `src/storage/idb/*.ts` | Transaction handling |
| wallet-toolbox | Git history | Recent IDB fixes |

## Code Analysis Findings (2025-01-30)

### Critical Discovery: Output Matching Criteria

**Both TypeScript and Go implementations match outputs by the same criteria:**

```
(user_id, transaction_id, vout)
```

**TypeScript** - `wallet-toolbox/src/storage/schema/entities/EntityOutput.ts#L240-244`:
```typescript
const transactionId = syncMap.transaction.idMap[ei.transactionId]
await storage.findOutputs({
  partial: { userId, transactionId, vout: ei.vout }
})
```

**Go** - `go-wallet-toolbox/pkg/internal/storage/repo/syncrepo/sync_output.go#L148`:
```go
Where("user_id = ? AND transaction_id = ? AND vout = ?", model.UserID, model.TransactionID, model.Vout)
```

### Transaction Matching Criteria

Transactions are matched by `(reference, userId)`, NOT by `txid`:

**TypeScript** - `wallet-toolbox/src/storage/schema/entities/EntityTransaction.ts#L245-250`:
```typescript
await storage.findTransactions({
  partial: { reference: ei.reference, userId }
})
```

### customInstructions Field Flow

**Confirmed: customInstructions is passed through unchanged in both implementations.**

- TS: Direct assignment in `mergeExisting` (line 280)
- Go: Direct field copy in `upsertOutput` (line 135)

**The corruption is NOT from field transformation - it's from wrong record matching.**

### Primary Hypothesis: Multi-Instance Record Bleed

When the **same wallet identity** is used from **multiple instances** (e.g., sweep-ui native BRC-100 wallet AND yours-wallet injected CWI), both sync to the same remote backup with the same identity key.

**Collision scenario:**

1. **Instance A** (sweep-ui native wallet) creates:
   - Transaction with `reference: "ref-abc"`, local `transactionId: 5`
   - Output with `vout: 0`, `customInstructions: '{"protocolID":[1,"onesat"],...}'` (ordinal)

2. **Instance A syncs to remote:**
   - Transaction A gets remote `transactionId: 100`
   - Output A gets stored with `(userId, transactionId:100, vout:0)`

3. **Instance B** (change output from different operation) creates:
   - Transaction with same `reference: "ref-abc"` (reused reference!), local `transactionId: 10`
   - Output with `vout: 0`, `customInstructions: '{"derivationPrefix":"base64..."}'` (change)

4. **Instance B syncs to remote:**
   - Transaction B matches existing by `(reference, userId)` → maps to same remote `transactionId: 100`
   - Output B has `(userId, transactionId→100, vout:0)` → **MATCHES OUTPUT A!**
   - Output A's `customInstructions` gets overwritten with Output B's data

### Why `updated_at` Check Doesn't Help

`mergeExisting` only updates if `ei.updated_at > this.updated_at` (line 270). But when two different outputs both claim `vout: 0` on the "same" transaction:
- The newer sync always wins
- The original output's data is lost

## ROOT CAUSE IDENTIFIED: Shared SyncState Across Devices

### The Discovery

**SyncState on the server is keyed by `(userId, storageIdentityKey)`:**

```go
// go-wallet-toolbox/pkg/internal/storage/database/models/sync_state.go
type SyncState struct {
    UserID             int    `gorm:"uniqueIndex:idx_user_storage_key"`
    StorageIdentityKey string `gorm:"uniqueIndex:idx_user_storage_key"`
    SyncMap            json.RawMessage  // Contains ID mappings
    // ...
}
```

**The `storageIdentityKey` is derived from the wallet's public key:**

```typescript
// 1sat-wallet-toolbox/src/wallet/factory.ts:153
await localStorage.migrate(DEFAULT_DATABASE_NAME, identityPubKey);
```

### The Problem

Every wallet instance with the same private key has the **same `storageIdentityKey`**.

When Instance A and Instance B (same wallet, different devices/browsers) both sync:
1. Both connect with identical `(userId, storageIdentityKey)`
2. Server retrieves the **SAME SyncState record** for both
3. Instance A creates mappings: `{A.localId:5 → remote:100}`
4. Instance B syncs using the **SAME syncMap** containing A's mappings
5. B's `localId:5` is a **DIFFERENT record** than A's `localId:5`
6. **B applies A's mappings to its own different records → corruption**

### Why This Causes Record Bleed

The `syncMap.idMap` tracks: "local ID X = remote ID Y"

But local IDs are auto-increment values **unique only within each local database**:
- Instance A: `transactionId: 5` → Transaction for "sweep ordinals"
- Instance B: `transactionId: 5` → Transaction for "send BSV" (completely different!)

When both share the same syncMap, the mappings become meaningless because they're mixing IDs from different databases.

### Design Assumption Violated

The sync protocol assumes:
> `storageIdentityKey` uniquely identifies a single client database

Reality:
> `storageIdentityKey` is derived from wallet key, so multiple clients share it

### Confirmed Findings

1. [x] Transaction references ARE randomly generated (not colliding)
2. [x] Multiple wallet instances DID sync with same identity (confirmed by user)
3. [x] `customInstructions` passes through unchanged (not a field transformation issue)
4. [x] **ROOT CAUSE: Shared SyncState causes ID mapping corruption**

## Proposed Fixes

### Fix Option 1: Use Globally Unique IDs for Matching

Use `(userId, txid, vout)` for output matching instead of `(userId, transactionId, vout)`.

**Pros:**
- `txid` is globally unique (on-chain hash)
- No ID remapping needed
- Works regardless of SyncState sharing

**Cons:**
- Only works for signed transactions (txid available)
- Unsigned outputs need fallback logic
- Doesn't solve the underlying multi-device problem

### Fix Option 2: Unique `storageIdentityKey` Per Device

Generate a random `storageIdentityKey` per device instead of deriving from wallet key.

**Pros:**
- Each device gets its own SyncState
- No ID mapping conflicts

**Cons:**
- Requires schema migration
- Changes sync semantics (each device is now a separate "storage")
- May complicate "restore from backup" scenarios

### Fix Option 3: Include Device Identifier in SyncState Key (Recommended)

Add a third key component (device UUID) to SyncState.

**Pros:**
- Backwards compatible with existing storageIdentityKey
- Explicit multi-device support
- Each device maintains isolated ID mappings
- Solves the root cause directly

**Cons:**
- Requires server-side changes
- Need to track device identifiers

## Recommended Fix: Device Identifier in SyncState

### Overview

The device ID is managed by the **application layer** (yours-wallet, sweep-ui), not the wallet itself. The local wallet doesn't need to know about device IDs - it's purely a concern of the remote storage connection.

**Key distinction:**
- **User data** (transactions, outputs, etc.) is shared across all devices for the same wallet
- **SyncState** (ID mappings) is isolated per device to prevent mapping corruption

This allows multiple devices to share wallet data while each device maintains its own translation table between local database IDs and server IDs.

**Flow:**
- Application generates and persists device ID (e.g., browser extension storage)
- Application passes device ID when creating remote storage connection
- Remote storage client includes device ID in all sync requests
- Server uses `(userId, storageIdentityKey, deviceID)` to look up SyncState

### Implementation Changes (Layer by Layer)

#### Layer 1: Application (yours-wallet, sweep-ui)

Generates UUID on first run, persists to application storage, passes to wallet factory.

```typescript
// Example: yours-wallet extension
const deviceId = await chrome.storage.local.get('deviceId')
  || crypto.randomUUID();
await chrome.storage.local.set({ deviceId });

const wallet = await createWebWallet({
  privateKey,
  chain: 'main',
  remoteStorageUrl: 'https://1sat.shruggr.cloud/1sat/wallet',
  deviceId,  // NEW
  // ...
});
```

#### Layer 2: 1sat-wallet-toolbox Factory

**File:** `1sat-wallet-toolbox/src/wallet/factory.ts#L41-L58`

```typescript
export interface WebWalletConfig {
  privateKey: PrivateKey | string;
  chain: Chain;
  adminOriginator: string;
  permissionsConfig: PermissionsManagerConfig;
  feeModel?: { model: "sat/kb"; value: number };
  remoteStorageUrl?: string;
  deviceId?: string;  // NEW
  // ...
}
```

**File:** `1sat-wallet-toolbox/src/wallet/factory.ts#L176-L178`

```typescript
remoteClient = new StorageClient(
  underlyingWallet as unknown as WalletInterface,
  config.remoteStorageUrl,
  config.deviceId  // NEW
);
```

#### Layer 3: wallet-toolbox StorageClient

**File:** `wallet-toolbox/src/storage/remoting/StorageClient.ts#L60-L71`

```typescript
export class StorageClient implements WalletStorageProvider {
  readonly endpointUrl: string
  readonly deviceId?: string  // NEW
  private readonly authClient: AuthFetch

  constructor(wallet: WalletInterface, endpointUrl: string, deviceId?: string) {
    this.authClient = new AuthFetch(wallet)
    this.endpointUrl = endpointUrl
    this.deviceId = deviceId  // NEW
  }
```

StorageClient includes `deviceId` in all `RequestSyncChunkArgs` when making sync calls.

#### Layer 4: wallet-toolbox Interfaces

**File:** `wallet-toolbox/src/sdk/WalletStorage.interfaces.ts#L478`

```typescript
export interface RequestSyncChunkArgs {
  fromStorageIdentityKey: string
  toStorageIdentityKey: string
  identityKey: string
  deviceId?: string  // NEW
  since?: Date
  maxRoughSize: number
  maxItems: number
  offsets: { name: string; offset: number }[]
}
```

#### Layer 5: go-wallet-toolbox Wire Types

**File:** `go-wallet-toolbox/pkg/wdk/storage_request_sync_chunk_args.go#L6-L30`

```go
type RequestSyncChunkArgs struct {
    FromStorageIdentityKey string     `json:"fromStorageIdentityKey"`
    ToStorageIdentityKey   string     `json:"toStorageIdentityKey"`
    IdentityKey            string     `json:"identityKey"`
    DeviceID               string     `json:"deviceId,omitempty"`  // NEW
    Since                  *time.Time `json:"since,omitempty"`
    MaxRoughSize           uint64     `json:"maxRoughSize"`
    MaxItems               uint64     `json:"maxItems"`
    Offsets                []SyncOffsets `json:"offsets"`
}
```

#### Layer 6: go-wallet-toolbox SyncState Model

**File:** `go-wallet-toolbox/pkg/internal/storage/database/models/sync_state.go#L11-L22`

```go
type SyncState struct {
    gorm.Model

    UserID             int    `gorm:"uniqueIndex:idx_user_storage_device"`
    StorageIdentityKey string `gorm:"type:varchar(130);not null;uniqueIndex:idx_user_storage_device"`
    DeviceID           string `gorm:"type:varchar(64);not null;default:'';uniqueIndex:idx_user_storage_device"` // NEW
    StorageName        string `gorm:"type:varchar(128);not null"`
    Status             wdk.SyncStatus
    RefNum             string `gorm:"not null;uniqueIndex"`
    SyncMap            json.RawMessage
    When               *time.Time
    Satoshis           *int64
}
```

#### Layer 7: go-wallet-toolbox Repository

**File:** `go-wallet-toolbox/pkg/internal/storage/repo/sync_state.go#L29-L50`

```go
func (s *SyncState) FindSyncState(ctx context.Context, userID int, storageIdentityKey string, deviceID string) (*entity.SyncState, error) {
    var model models.SyncState
    err = s.db.WithContext(ctx).
        Scopes(scopes.UserID(userID)).
        Where("storage_identity_key = ? AND device_id = ?", storageIdentityKey, deviceID).
        First(&model).Error
    // ...
}
```

### Backwards Compatibility

- Server accepts requests without `deviceId` (defaults to empty string `""`)
- Existing clients continue to work - all share one SyncState per user (current behavior)
- New clients with `deviceId` get isolated SyncState per device
- No breaking changes to existing deployments

### Database Migration

```sql
-- Add device_id column with default empty string
ALTER TABLE sync_states ADD COLUMN device_id VARCHAR(64) NOT NULL DEFAULT '';

-- Drop old index
DROP INDEX idx_user_storage_key;

-- Create new composite index
CREATE UNIQUE INDEX idx_user_storage_device ON sync_states(user_id, storage_identity_key, device_id);
```

### Testing Plan

1. Create two wallet instances with same identity key but different device IDs
2. Instance A syncs → creates SyncState with deviceId="A"
3. Instance B syncs → creates separate SyncState with deviceId="B"
4. Verify each maintains isolated ID mappings
5. Verify no cross-device data corruption
6. Verify old clients (no deviceId) still work with shared SyncState

## Next Steps

### Completed
1. [x] Trace `customInstructions` through TS sync code path
2. [x] Trace `customInstructions` through Go sync code path
3. [x] Identify where records could collide (output matching criteria)
4. [x] Investigate transaction `reference` field generation - **confirmed random/unique**
5. [x] Determine if multiple wallet instances synced same identity - **confirmed YES**
6. [x] **ROOT CAUSE FOUND: Shared SyncState due to storageIdentityKey derivation**
7. [x] Design device identifier implementation (documented above)

### Implementation Tasks

**PR 1: go-wallet-toolbox (server)** - ✅ COMPLETE (branch: `feat/device-id-sync-isolation`)
- [x] Add `DeviceID` field to `RequestSyncChunkArgs` struct
- [x] Add `DeviceID` field to `TableSyncState` API response type
- [x] Add `DeviceID` column to `SyncState` model with default `""`
- [x] Update `idx_user_storage_key` → `idx_user_storage_device` index
- [x] Update `FindSyncState` to include deviceID in WHERE clause
- [x] Update `CreateSyncState` to include deviceID
- [x] Update `FindOrInsertSyncStateAuth` signature (deviceID added as last param after storageName)
- [x] Update all callers: provider, client_gen, rpc_server, mocks, sync_to_writer
- [x] Database migration handled by GORM AutoMigrate (no manual migration needed)
- [x] All tests pass

**Files modified (14 total):**
- `pkg/wdk/storage_request_sync_chunk_args.go` - Added DeviceID to RequestSyncChunkArgs
- `pkg/wdk/table_sync_state.go` - Added DeviceID to TableSyncState
- `pkg/wdk/storage.interface.go` - Updated FindOrInsertSyncStateAuth signature
- `pkg/internal/storage/database/models/sync_state.go` - Added DeviceID column with new index
- `pkg/internal/storage/entity/sync_state.go` - Added DeviceID field and ToWDK mapping
- `pkg/internal/storage/repo/sync_state.go` - Updated FindSyncState, CreateSyncState, mapper
- `pkg/storage/internal/sync/repos.interface.go` - Updated interface
- `pkg/storage/internal/sync/find_or_insert_sync_state.go` - Added deviceID parameter
- `pkg/storage/internal/sync/chunk_processor.go` - Pass args.DeviceID to FindSyncState
- `pkg/storage/internal/sync/sync_to_writer.go` - Uses empty deviceID for server-to-server sync
- `pkg/storage/provider.go` - Updated implementation
- `pkg/storage/client_gen.go` - Updated client wrapper
- `pkg/storage/internal/server/rpc_storage_provider.gen.go` - Updated RPC server
- `pkg/internal/mocks/mock_wallet_storage_writer.go` - Updated mock

**PR 2: wallet-toolbox (client library)** - ✅ COMPLETE (branch: `fix/idb-transaction-auto-commit`)
- [x] Add `deviceId?: string` to `RequestSyncChunkArgs` interface in `WalletStorage.interfaces.ts`
- [x] Add `deviceId?: string` to `TableSyncState` interface
- [x] Add `deviceId?: string` to `StorageClient` constructor
- [x] Update `findOrInsertSyncStateAuth` signature (deviceId as last param)
- [x] Update `StorageReaderWriter`, `StorageMobile` implementations
- [x] Add Knex migration for existing databases
- [x] Add IndexedDB `deviceId` filter to `findSyncStates`

**Files modified (8 total):**
- `src/storage/schema/tables/TableSyncState.ts` - Added deviceId field
- `src/sdk/WalletStorage.interfaces.ts` - Added deviceId to RequestSyncChunkArgs and interface
- `src/storage/remoting/StorageClient.ts` - Accept deviceId in constructor
- `src/storage/remoting/StorageMobile.ts` - Same as StorageClient
- `src/storage/StorageReaderWriter.ts` - Include deviceId in sync state queries
- `src/storage/schema/entities/EntitySyncState.ts` - Updated fromStorage signature
- `src/storage/schema/KnexMigrations.ts` - Added migration + initial schema
- `src/storage/StorageIdb.ts` - Added deviceId filter

**PR 3: 1sat-wallet-toolbox (wrapper)** - ✅ COMPLETE (branch: `feat/device-id-sync-isolation`)
- [x] Add `deviceId?: string` to `WebWalletConfig` interface
- [x] Pass deviceId to `StorageClient` in factory
- [x] Update wallet-toolbox dependency to ^1.7.22-idb-fix.1

**Application Updates (yours-wallet, sweep-ui)** - NOT STARTED
- [ ] Generate and persist device UUID
- [ ] Pass deviceId when creating wallet

### Data Recovery
- [ ] Existing corrupted data will NOT be automatically fixed
- [ ] See `docs/plans/2025-01-30-data-salvage.md` for recovery plan

## Related Documents

- `1sat-wallet-toolbox/ORDINAL_TRANSFER_DEBUG.md` - Prior investigation
- `docs/plans/2025-01-30-data-salvage.md` - Recovery plan (depends on this diagnosis)
