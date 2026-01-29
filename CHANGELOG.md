# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.57] - 2026-01-29

### Fixed

- Add empty `tags: []` to all outputs that don't track in wallet (external transfers, payments, fees)
- SDK requires tags array on all outputs, even if empty

## [0.0.56] - 2026-01-29

### Changed

- Force synchronous broadcast with `acceptDelayedBroadcast: false` on all API methods
- Transactions now broadcast immediately instead of being queued for async broadcast (5-10s delay)
- Provides immediate success/failure feedback to users

## [0.0.55] - 2026-01-28

### Changed

- Renamed `listOrdinals` to `getOrdinals` - now returns `{ outputs, BEEF }` instead of just outputs
- `getOrdinals` includes BEEF with each page for spending ordinals

## [0.0.41] - 2026-01-27

### Fixed

- **fullSync push direction** - `fullSync()` now performs a true full push by setting `args.since = undefined`, bypassing the timestamp filter that was causing old outputs to be skipped during push.

## [0.0.39] - 2026-01-27

### Fixed

- **Remote storage architecture** - Restructured factory to build storage completely before creating Wallet. Previously, the factory created the Wallet first, then attempted to hack the storage reference afterward. Now the correct order is: create local storage → attempt remote connection → create WalletStorageManager with both → create Wallet with final configuration.
- **Use public APIs** - Replaced type coercion hacks accessing private `_storage`, `_backups` properties with public `getBackupStores()`, `getConflictingStores()`, `getStores()`, `updateBackups()` methods.

## [0.0.38] - 2026-01-26

### Fixed

- **Remote backup sync authentication** - Use `updateBackups()` instead of `syncToWriter()` in monitor callbacks to properly handle BSV authentication headers.

## [0.0.37] - 2026-01-26

### Fixed

- **createWebWallet remote sync** - Monitor callbacks now always sync to remote backup first, then call user callbacks. Previously, consumers (like yours-wallet) that set their own monitor callbacks would overwrite the sync behavior, causing transactions to never be backed up to remote storage.

### Changed

- **WebWalletConfig callbacks** - Added `onTransactionBroadcasted` and `onTransactionProven` callback options. These are called AFTER remote sync completes, ensuring data is safely backed up before notifying consumers.

## [0.0.28] - 2026-01-25

### Added

- **sweepBsv21 skill** - Sweep BSV-21 tokens from external wallets into BRC-100 wallets
- **BSV21_PROTOCOL constant** - Protocol ID for BSV-21 key derivation
- **BSV21_FEE_SATS constant** - 1000 sat fee for overlay processing
- **BSV-21 sweep types** - `SweepBsv21Input`, `SweepBsv21Request`, `SweepBsv21Response`

### Changed

- **sendBsv21** - Now includes 1000 sat fee output to overlay fund address

## [0.0.27] - 2026-01-23

### Changed

- Store ordinal name in customInstructions instead of tag (SDK lowercases tags)

## [0.0.26] - 2026-01-23

### Fixed

- sweepOrdinals now includes `name:` tag on swept outputs
- ONESAT_PROTOCOL changed from '1sat' to 'onesat' (5+ char requirement)
- sweepOrdinals P2PKH lock uses derived address instead of raw pubkey
- ordfs content URLs use origin instead of outpoint

### Added

- `rawWallet` exposed in WebWalletResult for unpermissioned access

## [0.0.22] - 2026-01-22

### Added

- **sweepOrdinals skill** - New skill to sweep ordinals from external wallets into BRC-100 wallets
  - Each ordinal transferred to derived address via wallet key derivation
  - Outputs tagged and placed in `1sat` basket
- **Ordinal sweep types** - `SweepOrdinalInput`, `SweepOrdinalsRequest`, `SweepOrdinalsResponse`
- **sweep-ui ordinals section** - UI for browsing, selecting, and sweeping ordinals
  - Pagination for ordinal outputs
  - Metadata lookup via ordfs API
  - Thumbnail display for image ordinals
  - Multi-select with sweep confirmation

## [0.0.10] - 2026-01-14

### Added

- **Web wallet factory** - `createWebWallet()` consolidates wallet setup for web apps:
  - Storage creation (StorageIdb, WalletStorageManager)
  - OneSatServices with fallback Services
  - WalletPermissionsManager for dApp permission handling
  - Monitor for transaction lifecycle (not auto-started)
  - Cleanup function for resource disposal
- **New exports** - `WebWalletConfig`, `WebWalletResult` types

## [0.0.9] - 2026-01-08

### Added

- **OrdLock purchase/cancel** - Implemented OrdLock purchase and cancel operations for BRC-100 marketplace integration
- **Lock unlock** - Added Lock unlock functionality for time-locked outputs

### Changed

- **Updated dependencies** - Switched to npm packages for template dependencies

## [0.0.8] - 2025-12-28

### Changed

- **Updated template references** - Updated indexer imports to use @bopen-io/templates

## [0.0.7] - 2025-12-28

### Changed

- **Updated @bsv/sdk** - Updated to latest ts-sdk with OneSatWallet and OneSatServices improvements
- **Build target updated** - Updated tsconfig build target

### Fixed

- **Removed debug logs** - Cleaned up debug logging in OneSatWallet

## [0.0.6] - 2025-12-28

### Fixed

- **Transaction ingestion** - Fixed transaction ingestion in OneSatWallet

## [0.0.5] - 2025-12-27

### Fixed

- **Mark spends** - Fixed spend marking in OneSatWallet sync

## [0.0.4] - 2025-12-27

### Changed

- **API routes updated** - All clients now use `/1sat/*` routes instead of `/api/*`

### Fixed

- **Broadcast** - Fixed broadcast in OneSatServices

## [0.0.3] - 2025-12-27

### Added

- **Sync Queue System** - New queue-based sync architecture for background transaction processing:
  - `IndexedDbSyncQueue` - Browser implementation using IndexedDB
  - `SqliteSyncQueue` - Node/Bun implementation using SQLite
  - Decouples SSE ingestion from transaction processing
  - Enables resumability across app restarts
  - Multi-tenant isolation via `accountId`
  - Design documentation in `docs/SYNC_QUEUE_DESIGN.md`
- **OrdfsClient improvements**:
  - `getContent()` now returns response headers (content-type, origin, sequence)
  - Sequence number support for inscription versioning (`outpoint:seq`)
  - `previewHtml()` for base64-encoded HTML content
  - Dedicated content URL builder with format options
- **New exports**:
  - Sync queue types (`SyncQueueStorage`, `SyncQueueItem`, `SyncState`, etc.)
  - Re-exports from `@bsv/wallet-toolbox/mobile`: `WalletStorageManager`, `StorageProvider`, `StorageIdb`
  - Additional ORDFS types: `OrdfsContentOptions`, `OrdfsContentResponse`, `OrdfsResponseHeaders`

### Changed

- **OneSatWallet refactored** - Queue-based sync architecture with `SyncQueueStorage` integration
- **OwnerClient updated** - Server route changes
- **TxoClient updated** - Server route changes
- **OrdfsClient enhanced** - Additional metadata capabilities
- **IndexedOutput type simplified** - Removed `script`, `owners` fields; renamed `height`/`idx` to `blockHeight`/`blockIdx`
- **TxoQueryOptions streamlined** - Removed `tags` and `script` options
- **Indexer improvements** - Bsv21Indexer, InscriptionIndexer, OriginIndexer, MapIndexer, OrdLockIndexer updates

### Fixed

- **BSV21 token icon** - Fixed token icon display in Bsv21Indexer
- **OriginIndexer** - Fixed origin parsing edge cases

## [0.0.2] - 2025-12-19

### Added

- **Modular API Client Architecture** - New specialized clients in `src/services/client/`:
  - `BaseClient` - Shared HTTP utilities with timeout and error handling
  - `ChaintracksClient` - Block headers and chain tracking (`/1sat/chaintracks/*`)
  - `BeefClient` - Raw transactions and BEEF proofs (`/1sat/beef/*`)
  - `ArcadeClient` - Transaction broadcasting (`/1sat/arcade/*`)
  - `TxoClient` - Transaction output queries (`/1sat/txo/*`)
  - `OwnerClient` - Address queries with SSE sync (`/1sat/owner/*`)
  - `OrdfsClient` - Content and inscription metadata (`/1sat/ordfs/*`)
  - `Bsv21Client` - BSV21 token data (`/1sat/bsv21/*`)
- **Public client access** - Clients exposed as `readonly` properties on OneSatServices
  (e.g., `services.beef`, `services.owner`)
- **Architecture documentation** - Added `docs/INTERFACE_CLEANUP.md` and
  `docs/ONESAT_SERVICE_CONSOLIDATION.md`
- **npm support** - Added `package-lock.json` for npm compatibility alongside bun

### Changed

- **OneSatWallet refactored** - Enhanced sync, parsing, and state management
- **TransactionParser consolidated** - Parsing logic moved into OneSatWallet (internal, no API change)
- **OneSatServices simplified** - Now acts as facade coordinating specialized clients
- **All indexers updated** - Improved parsing logic and type safety
- **URL configuration** - Updated default service URLs

### Fixed

- **Biome lint compliance** - Applied formatting fixes across codebase
- **Dependency updates** - Updated to latest @bsv/sdk and @bsv/wallet-toolbox

## [0.0.1] - 2025-12-14

### Added

- Initial release
- OneSatWallet class with BRC-100 interface
- Read-only mode via public key
- OneSatServices (WalletServices implementation)
- 10 transaction indexers (Fund, Lock, Inscription, Origin, Bsv21, OrdLock, OpNS, Sigma, Map, Cosign)
- Address synchronization with SSE streaming
- Event system for sync progress
- Broadcast and ingest pipeline
