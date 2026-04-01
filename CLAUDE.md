# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
bun install          # Install dependencies
bun run build        # Build library (Bun bundler + TypeScript declarations)
bun run lint         # Check linting with Biome
bun run lint:fix     # Auto-fix lint issues
bun test             # Run tests with Bun test runner
bun run tester       # Build and run browser tester app
```

## Architecture

This is `@1sat/wallet-toolbox`, a BSV wallet library extending `@bsv/wallet-toolbox` with 1Sat Ordinals protocol support.

### Core Components

**OneSatWallet** (`src/OneSatWallet.ts`)
- Main wallet class extending `Wallet` from `@bsv/wallet-toolbox/mobile`
- Supports both full signing mode (PrivateKey) and read-only mode (public key hex)
- Runs transactions through indexers pipeline, then internalizes via BRC-100
- Queue-based sync with SSE streaming from 1Sat API
- Event emitter for sync progress (`sync:start`, `sync:progress`, `sync:complete`, `sync:error`)

**OneSatServices** (`src/services/OneSatServices.ts`)
- Implements `WalletServices` interface from wallet-toolbox
- Facade coordinating specialized API clients
- Default mainnet: `https://api.1sat.app`, testnet: `https://testnet.api.1sat.app`

**API Clients** (`src/services/client/`)
- `BaseClient` - Shared HTTP with timeout/error handling
- `ChaintracksClient` - Block headers, chain tracking (`/api/chaintracks/*`)
- `BeefClient` - Raw transactions, BEEF proofs (`/api/beef/*`)
- `ArcadeClient` - Transaction broadcasting (`/api/arcade/*`)
- `TxoClient` - Transaction output queries (`/api/txo/*`)
- `OwnerClient` - Address queries, SSE sync (`/api/owner/*`)
- `OrdfsClient` - Inscription metadata (`/api/ordfs/*`)
- `Bsv21Client` - BSV21 token data (`/api/bsv21/*`)

### Indexers (`src/indexers/`)

Transaction indexers extract protocol-specific data. Each output gets a **tag** (identifier) and optionally a **basket** (for `listOutputs`).

| Indexer | Tag | Basket | Purpose |
|---------|-----|--------|---------|
| FundIndexer | `fund` | `fund` | Standard P2PKH (>1 sat) |
| LockIndexer | `lock` | `lock` | Time-locked outputs |
| InscriptionIndexer | `insc` | - | 1Sat Ordinal inscriptions |
| OriginIndexer | `origin` | `1sat` | Origin tracking via OrdFS |
| Bsv21Indexer | `bsv21` | `bsv21` | BSV21 token protocol |
| OrdLockIndexer | `list` | - | OrdLock marketplace listings |
| OpNSIndexer | `opns` | `opns` | OPNS namespace protocol |
| SigmaIndexer | `sigma` | - | Sigma signatures |
| MapIndexer | `map` | - | MAP protocol data |
| CosignIndexer | `cosign` | - | Cosigner script data |

### Sync Queue (`src/sync/`)

Background sync processing with storage adapters:
- `IndexedDbSyncQueue` - Browser IndexedDB storage
- `SqliteSyncQueue` - SQLite for Node/Bun environments

### Data Flow

1. `syncAll()` opens SSE stream to `/api/owner/{address}/history`
2. Stream items enqueued to `SyncQueueStorage`
3. Queue processor fetches BEEF, runs indexers, internalizes to wallet
4. Scores track sync progress per address (persisted to prevent re-sync)

## Key Dependencies

- `@bsv/sdk` - Core BSV transaction/crypto primitives
- `@bsv/wallet-toolbox` - BRC-100 wallet interface
- `@bopen-io/ts-templates` - Script template parsing

## Browser Target

The build targets browser with Buffer polyfill. Entry point (`src/index.ts`) ensures `globalThis.Buffer` is available before any other imports.

## Example Apps

### sweep-ui (`examples/sweep-ui/`)

Browser-based tool for sweeping UTXOs from legacy wallets to BRC-100 wallets.

**Development:**
```bash
# Start dev server persistently (survives shell session)
cd examples/sweep-ui && nohup bun run dev > /tmp/sweep-ui.log 2>&1 &

# Check if running
lsof -i :5173

# View logs
tail -f /tmp/sweep-ui.log

# Stop server
pkill -f "vite.*sweep-ui" || kill $(lsof -t -i :5173)
```

**Important:** Always use `nohup` when starting dev servers in background. Plain `&` will die when the shell session ends.

**Features:**
- TanStack Query infinite pagination for fetching all UTXOs
- Multi-state dialog flow (idle → loading → results → preview)
- Real-time totals as pages are fetched
- BSV price from WhatsOnChain API
- USD/BSV/sats balance display

**Note:** Uses `file:../..` dependency which requires Vite dedupe config to avoid multiple React copies.
