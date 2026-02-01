# Device ID Implementation - Session Kickoff

## Context

We diagnosed a sync corruption issue in the BRC-100 wallet sync protocol. The root cause and fix are documented in `docs/plans/2025-01-30-fullsync-diagnosis.md`.

**Read that document first** - it contains the full analysis and implementation details.

## Problem Summary

Multiple wallet instances (same identity key, different devices) share the same `SyncState` on the server. `SyncState` contains ID mappings (`syncMap`) that translate between local database IDs and server IDs. When devices share these mappings, records get associated with wrong local IDs, corrupting data like `customInstructions`.

## The Fix

Add a `deviceId` field to isolate `SyncState` per device:
- **User data** remains shared across devices (the point of sync)
- **SyncState/ID mappings** become per-device (prevents corruption)

## Implementation Tasks

### PR 1: go-wallet-toolbox (server) - Do this first

Repository: `/Users/davidcase/Source/1sat/go-wallet-toolbox`

1. Add `DeviceID` field to `RequestSyncChunkArgs`:
   - File: `pkg/wdk/storage_request_sync_chunk_args.go`
   - Add: `DeviceID string json:"deviceId,omitempty"`

2. Add `DeviceID` column to `SyncState` model:
   - File: `pkg/internal/storage/database/models/sync_state.go`
   - Add field with `gorm:"type:varchar(64);not null;default:'';uniqueIndex:idx_user_storage_device"`
   - Update existing index from `idx_user_storage_key` to `idx_user_storage_device`

3. Update `FindSyncState` to include deviceID:
   - File: `pkg/internal/storage/repo/sync_state.go`
   - Change signature to accept `deviceID string`
   - Add `device_id` to WHERE clause

4. Update `CreateSyncState` to include deviceID:
   - Same file, include deviceID in model creation

5. Find all callers of `FindSyncState` and update them to pass deviceID from request args

6. Database migration (if using GORM AutoMigrate, may handle automatically)

### PR 2: wallet-toolbox (client library)

Repository: `/Users/davidcase/Source/1sat/wallet-toolbox`

1. Add `deviceId?: string` to `RequestSyncChunkArgs` interface:
   - File: `src/sdk/WalletStorage.interfaces.ts`

2. Add `deviceId` to `StorageClient`:
   - File: `src/storage/remoting/StorageClient.ts`
   - Add constructor parameter: `deviceId?: string`
   - Store as instance property
   - Include in all sync request calls

### PR 3: 1sat-wallet-toolbox (wrapper)

Repository: `/Users/davidcase/Source/1sat/1sat-wallet-toolbox`

1. Add `deviceId?: string` to `WebWalletConfig`:
   - File: `src/wallet/factory.ts`

2. Pass `deviceId` to `StorageClient` constructor:
   - Same file, around line 176

## Key Points

- **Backwards compatible**: Empty `deviceId` defaults to `""` - existing clients keep working
- **Application manages deviceId**: The wallet doesn't generate it; apps (yours-wallet, sweep-ui) pass it in
- **No data migration needed**: Existing data stays as-is; fix prevents future corruption
- **Corrupted data recovery is separate**: See `docs/plans/2025-01-30-data-salvage.md`

## Testing

After implementation:
1. Create two wallet instances with same identity key but different device IDs
2. Instance A creates transaction, syncs to server
3. Instance B syncs - should get A's transaction with B's own ID mappings
4. Verify no data corruption between instances

## Start Here

```bash
# Read the full diagnosis document
cat /Users/davidcase/Source/1sat/1sat-wallet-toolbox/docs/plans/2025-01-30-fullsync-diagnosis.md
```

Then start with PR 1 (go-wallet-toolbox) since the server needs to accept the new field before clients can send it.
