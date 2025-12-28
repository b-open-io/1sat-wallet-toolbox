# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
