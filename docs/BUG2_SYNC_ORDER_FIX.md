# Bug 2 Fix: Proper Sync Order (Pull Then Push)

## Problem Summary

Multi-device sync failed with "Result must be unique" errors because the sync order was wrong and included unnecessary conflict resolution logic.

## Root Cause

1. Sync state (`idMap`) tracks what you **RECEIVED**, not what you SENT
2. When Device A only pushes (never pulls), it has no ID mappings
3. Later, when Device A needs to merge FROM remote, it can't translate remote IDs to local IDs
4. The conflict resolution logic (`setActive()`) tried to re-sync data that was already there, causing errors

## The Fix

Proper bidirectional sync: **pull first, then push**. No conflict resolution needed.

```
1. Connect to remote
2. Pull from remote (syncFromReader) → builds idMap via natural key matching
3. Push to remote (updateBackups) → sends local changes
4. Done - data is synced on both sides
```

The "conflicting actives" check and `setActive()` logic was removed entirely. It was trying to merge data that was already synced, causing the errors.

## Changes Made

In `src/wallet/factory.ts`:

1. **Added push after pull** (lines 196-213):
   ```typescript
   // Bidirectional sync: pull first, then push
   console.log("[createWebWallet] Pulling from remote...");
   const pullResult = await storage.syncFromReader(identityPubKey, remoteClient);

   console.log("[createWebWallet] Pushing to remote...");
   await storage.updateBackups(undefined, ...);
   ```

2. **Removed conflict resolution block** - The ~50 lines of `setActive()` logic and fallback handling were removed. After proper bidirectional sync, there's nothing to "resolve".

## Why This Works

1. `syncFromReader` pulls data from remote
2. During pull, transactions are matched by `reference` (natural key)
3. `MergeEntity.merge` calls `updateSyncMap(idMap, remoteId, localId)`
4. Now `syncMap.transaction.idMap` has mappings
5. `updateBackups` pushes local changes to remote
6. Both sides have the same data - no conflicts

## Incremental Sync

This isn't expensive after the first sync:
- `syncFromReader` uses the `when` timestamp from sync_state
- Only pulls records newer than last sync
- `updateBackups` only pushes records newer than remote's last sync

## Related Issue: Bug 1 (Timestamp Ordering)

There's a separate issue where outputs can be permanently skipped due to timestamp ordering in chunk generation. See: `~/.claude/plans/synthetic-seeking-seal.md`

This fix addresses Bug 2 only.
