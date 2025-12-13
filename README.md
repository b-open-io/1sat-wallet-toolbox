# 1sat-wallet-toolbox

A BSV wallet library extending [@bsv/wallet-toolbox](https://github.com/bitcoin-sv/ts-sdk) with 1Sat Ordinals protocol support. Implements BRC-100 wallet interface with indexed transaction ingestion and address synchronization.

## Installation

```bash
bun add 1sat-wallet-toolbox
```

## Quick Start

```typescript
import { OneSatWallet, StorageIdb, WalletStorageManager } from "1sat-wallet-toolbox";
import { PrivateKey } from "@bsv/sdk";

// Create wallet with signing capability
const wallet = new OneSatWallet({
  rootKey: PrivateKey.fromWif("..."),
  storage: await WalletStorageManager.createWalletStorageManager(new StorageIdb("wallet")),
  chain: "main",
  owners: new Set(["1Address...", "1Another..."]),
});

// Sync wallet from the 1Sat indexer
await wallet.syncAll();

// Query outputs
const outputs = await wallet.listOutputs({ basket: "1sat" });
```

## Public Interface

### OneSatWallet

Main wallet class extending `Wallet` from `@bsv/wallet-toolbox`.

```typescript
import { OneSatWallet, StorageIdb, WalletStorageManager } from "1sat-wallet-toolbox";
import { PrivateKey } from "@bsv/sdk";

// Full signing mode
const wallet = new OneSatWallet({
  rootKey: PrivateKey.fromWif("..."),
  storage: await WalletStorageManager.createWalletStorageManager(new StorageIdb("wallet")),
  chain: "main",
  owners: new Set(["1Address...", "1Another..."]),
});

// Read-only mode (public key only)
const readOnlyWallet = new OneSatWallet({
  rootKey: "02abc123...", // public key hex
  storage: storageManager,
  chain: "main",
});
```

#### Constructor Args

| Property | Type | Description |
|----------|------|-------------|
| `rootKey` | `string \| PrivateKey` | Public key hex (read-only) or PrivateKey (full signing) |
| `storage` | `WalletStorageManager` | Storage backend for wallet data |
| `chain` | `"main" \| "test"` | Network |
| `owners` | `Set<string>` | Optional. Addresses to filter indexed outputs |
| `ordfsUrl` | `string` | Optional. OrdFS server URL (default: `https://ordfs.network`) |
| `onesatUrl` | `string` | Optional. 1Sat indexer URL (default: based on chain) |

#### Properties

| Property | Type | Description |
|----------|------|-------------|
| `readOnly` | `boolean` | True if instantiated with public key only |

#### Methods

##### `addOwner(address: string): void`
Add an address to the set of owned addresses for output filtering.

##### `ingestTransaction(tx, description, labels?, isBroadcasted?): Promise<InternalizeActionResult>`
Ingest a transaction by running it through indexers, then internalizing via BRC-100.

| Parameter | Type | Description |
|-----------|------|-------------|
| `tx` | `Transaction` | Transaction to ingest |
| `description` | `string` | Human-readable description |
| `labels` | `string[]` | Optional labels |
| `isBroadcasted` | `boolean` | Default `true`. Affects validation |

##### `broadcast(tx, description, labels?): Promise<InternalizeActionResult>`
Broadcast a transaction and ingest it into the wallet if successful.

| Parameter | Type | Description |
|-----------|------|-------------|
| `tx` | `Transaction` | Transaction to broadcast |
| `description` | `string` | Human-readable description |
| `labels` | `string[]` | Optional labels |

##### `syncAddress(address: string, limit?: number): Promise<void>`
Sync a single address from the 1Sat indexer. Fetches new outputs and spends, ingesting transactions as needed. Progress is persisted to localStorage.

##### `syncAll(): Promise<void>`
Sync all owner addresses in parallel.

##### `on(event, callback): void`
Subscribe to wallet events. See [Events](#events) section.

##### `off(event, callback): void`
Unsubscribe from wallet events.

##### BRC-100 Methods (inherited from Wallet)
- `createAction()` - Create and sign transactions
- `internalizeAction()` - Import external transactions
- `listOutputs()` - Query wallet outputs
- `listActions()` - Query transaction history
- See [@bsv/wallet-toolbox](https://github.com/bitcoin-sv/ts-sdk) for full interface

#### Events

Subscribe to sync events using the `on` method:

```typescript
wallet.on("sync:start", (event) => {
  console.log(`Starting sync for ${event.address} from score ${event.fromScore}`);
});

wallet.on("sync:progress", (event) => {
  console.log(`${event.address}: ${event.processed} processed, ${event.remaining} remaining`);
});

wallet.on("sync:tx", (event) => {
  console.log(`${event.address}: ${event.type} tx ${event.txid}`);
});

wallet.on("sync:error", (event) => {
  console.error(`${event.address}: ${event.error.message}`);
});

wallet.on("sync:complete", (event) => {
  console.log(`${event.address}: completed, ${event.processed} transactions`);
});
```

| Event | Payload | Description |
|-------|---------|-------------|
| `sync:start` | `{ address, fromScore }` | Sync started for an address |
| `sync:progress` | `{ address, processed, remaining, currentScore, done }` | Progress update |
| `sync:tx` | `{ address, txid, type }` | Transaction ingested (`type`: "output" or "spend") |
| `sync:error` | `{ address, error }` | Error during sync |
| `sync:complete` | `{ address, processed, finalScore }` | Sync completed |

---

### OneSatServices

WalletServices implementation for 1Sat ecosystem. Uses ordfs-server for blockchain data and OneSat API for broadcasting.

```typescript
import { OneSatServices } from "1sat-wallet-toolbox";

const services = new OneSatServices("main", "https://ordfs.network");
```

#### Constructor Args

| Parameter | Type | Description |
|-----------|------|-------------|
| `chain` | `"main" \| "test"` | Network |
| `ordfsUrl` | `string` | Optional. OrdFS server URL (default: `https://ordfs.network`) |
| `onesatUrl` | `string` | Optional. 1Sat API URL (default: based on chain) |
| `storage` | `WalletStorageManager` | Optional. Storage for caching |

#### Methods

| Method | Description |
|--------|-------------|
| `getRawTx(txid)` | Fetch raw transaction bytes |
| `getMerklePath(txid)` | Fetch merkle proof |
| `postBeef(beef, txids)` | Broadcast transaction(s) |
| `getHeight()` | Get current chain height |
| `getHeaderForHeight(height)` | Get block header |
| `getChainTracker()` | Get ChainTracker for SPV validation |
| `getBeefBytes(txid)` | Get BEEF bytes for transaction |
| `getBeefForTxid(txid)` | Get BEEF object for transaction |
| `getOrdfsMetadata(outpoint)` | Get inscription metadata |
| `getBsv21TokenByTxid(tokenId, txid)` | Get BSV21 token data |
| `getBsv21TokenDetails(tokenId)` | Get BSV21 token metadata (cached) |

---

### ReadOnlySigner

KeyDeriver implementation for read-only wallet mode. Throws on any signing operation.

```typescript
import { ReadOnlySigner } from "1sat-wallet-toolbox";

const signer = new ReadOnlySigner("02abc123..."); // public key hex
```

---

### Indexers

Transaction indexers that extract protocol-specific data for wallet storage. Each indexer identifies outputs by a **tag** (data identifier), optionally assigns a **basket** for output organization, and may add searchable **tags** for querying.

| Indexer | Tag | Basket | Tags | Description |
|---------|-----|--------|------|-------------|
| `FundIndexer` | `fund` | `fund` | - | Standard P2PKH outputs (>1 sat) |
| `LockIndexer` | `lock` | `lock` | - | Time-locked outputs |
| `InscriptionIndexer` | `insc` | - | - | 1Sat Ordinal inscriptions (preliminary data) |
| `OriginIndexer` | `origin` | `1sat` | `origin:{outpoint}`, `type:{category}`, `type:{base}`, `type:{full}` | Origin tracking via OrdFS |
| `Bsv21Indexer` | `bsv21` | `bsv21` | `id:{tokenId}`, `id:{tokenId}:{status}` | BSV21 token protocol |
| `OrdLockIndexer` | `list` | - | `ordlock` | OrdLock marketplace listings |
| `OpNSIndexer` | `opns` | `opns` | `name:{name}` | OPNS namespace protocol |
| `SigmaIndexer` | `sigma` | - | - | Sigma signatures |
| `MapIndexer` | `map` | - | - | MAP protocol data |
| `CosignIndexer` | `cosign` | - | - | Cosigner script data |

#### Baskets

Outputs are organized into baskets for querying via `listOutputs({ basket })`:

- **`fund`** - Standard funding UTXOs
- **`lock`** - Time-locked outputs
- **`1sat`** - 1Sat Ordinal outputs (non-token inscriptions)
- **`bsv21`** - BSV21 token outputs
- **`opns`** - OPNS namespace outputs

#### Tags

Tags enable filtered queries via `listOutputs({ tags })`. Tags are only added for owned outputs.

- **`origin:{outpoint}`** - Filter by origin outpoint
- **`type:{category}`** - Filter by content category (e.g., `type:image`, `type:text`)
- **`type:{base}`** - Filter by base MIME type without encoding (e.g., `type:image/png`)
- **`type:{full}`** - Filter by full MIME type including encoding (e.g., `type:image/png; charset=utf-8`)
- **`id:{tokenId}`** - Filter BSV21 by token ID
- **`id:{tokenId}:{status}`** - Filter BSV21 by token ID and status (`valid`, `invalid`, `pending`)
- **`ordlock`** - Filter for OrdLock listings
- **`name:{name}`** - Filter OPNS by name

---

### TransactionParser

Runs indexers over transactions to extract basket/tags for wallet-toolbox storage.

```typescript
import { TransactionParser, FundIndexer, OriginIndexer } from "1sat-wallet-toolbox";

const parser = new TransactionParser(
  [new FundIndexer(owners, "mainnet"), new OriginIndexer(owners, "mainnet", services)],
  owners,
  services
);

const result = await parser.parse(transaction, true);
// result.outputs: ParsedOutput[] with vout, basket, tags, customInstructions
```

---

## Project Status

### Completed

- [x] OneSatWallet extending wallet-toolbox Wallet
- [x] Read-only mode via public key
- [x] OneSatServices (WalletServices implementation)
- [x] All indexers migrated from yours-wallet
- [x] TransactionParser for indexed ingestion
- [x] `ingestTransaction()` method
- [x] `syncAddress()` / `syncAll()` synchronization
- [x] Event system for sync progress
- [x] `broadcast()` method
- [x] `getChainTracker()` implementation

### TODO

- [ ] Implement remaining OneSatServices methods:
  - [ ] `getBsvExchangeRate()`
  - [ ] `getFiatExchangeRate()`
  - [ ] `getStatusForTxids()`
  - [ ] `isUtxo()`
  - [ ] `getUtxoStatus()`
  - [ ] `getScriptHashHistory()`
  - [ ] `hashToHeader()`
  - [ ] `nLockTimeIsFinal()`
- [ ] Improve basket/tag extraction in TransactionParser
- [ ] Tests
- [ ] Integration with yours-wallet

## Development

```bash
bun install
bun run build
bun run lint
bun test
```
