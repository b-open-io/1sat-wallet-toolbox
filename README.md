# 1sat-wallet-toolbox

A BSV wallet library extending [@bsv/wallet-toolbox](https://github.com/bitcoin-sv/ts-sdk) with 1Sat Ordinals protocol support. Implements BRC-100 wallet interface with indexed transaction ingestion.

## Installation

```bash
bun add 1sat-wallet-toolbox
```

## Public Interface

### OneSatWallet

Main wallet class extending `Wallet` from `@bsv/wallet-toolbox`.

```typescript
import { OneSatWallet, StorageIdb } from "1sat-wallet-toolbox";
import { PrivateKey } from "@bsv/sdk";
import { WalletStorageManager } from "@bsv/wallet-toolbox";

// Full signing mode
const wallet = new OneSatWallet({
  identityKey: PrivateKey.fromWif("..."),
  storage: await WalletStorageManager.createWalletStorageManager(new StorageIdb("wallet")),
  chain: "main",
  owners: new Set(["1Address...", "1Another..."]),
});

// Read-only mode (public key only)
const readOnlyWallet = new OneSatWallet({
  identityKey: "02abc123...", // public key hex
  storage: storageManager,
  chain: "main",
});
```

#### Constructor Args

| Property | Type | Description |
|----------|------|-------------|
| `identityKey` | `string \| PrivateKey` | Public key hex (read-only) or PrivateKey (full signing) |
| `storage` | `WalletStorageManager` | Storage backend for wallet data |
| `chain` | `"main" \| "test"` | Network |
| `owners` | `Set<string>` | Optional. Addresses to filter indexed outputs |

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
| `tx` | `Transaction \| number[]` | Transaction or raw bytes |
| `description` | `string` | Human-readable description |
| `labels` | `string[]` | Optional labels |
| `isBroadcasted` | `boolean` | Default `true`. Affects validation |

##### BRC-100 Methods (inherited from Wallet)
- `createAction()` - Create and sign transactions
- `internalizeAction()` - Import external transactions
- `listOutputs()` - Query wallet outputs
- `listActions()` - Query transaction history
- See [@bsv/wallet-toolbox](https://github.com/bitcoin-sv/ts-sdk) for full interface

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

#### Methods

| Method | Description |
|--------|-------------|
| `getRawTx(txid)` | Fetch raw transaction bytes |
| `getMerklePath(txid)` | Fetch merkle proof |
| `postBeef(beef, txids)` | Broadcast transaction(s) |
| `getHeight()` | Get current chain height |
| `getHeaderForHeight(height)` | Get block header |
| `getBeefForTxid(txid)` | Get BEEF for transaction |
| `getOrdfsMetadata(outpoint)` | Get inscription metadata |
| `getBsv21TokenByTxid(tokenId, txid)` | Get BSV21 token data |

---

### ReadOnlySigner

KeyDeriver implementation for read-only wallet mode. Throws on any signing operation.

```typescript
import { ReadOnlySigner } from "1sat-wallet-toolbox";

const signer = new ReadOnlySigner("02abc123..."); // public key hex
```

---

### Indexers

Transaction indexers that extract protocol-specific data for wallet storage.

| Indexer | Tag | Description |
|---------|-----|-------------|
| `FundIndexer` | `fund` | Standard P2PKH outputs |
| `LockIndexer` | `lock` | Various lock scripts (P2PK, P2MS, etc.) |
| `InscriptionIndexer` | `insc` | 1Sat Ordinal inscriptions |
| `OriginIndexer` | `origin` | Origin tracking via OrdFS |
| `Bsv21Indexer` | `bsv21` | BSV21 token protocol |
| `OrdLockIndexer` | `list` | OrdLock listings |
| `OpNSIndexer` | `opns` | OPNS namespace protocol |
| `SigmaIndexer` | `sigma` | Sigma signatures |
| `MapIndexer` | `map` | MAP protocol data |
| `CosignIndexer` | `cosign` | Cosigner data |

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

### TODO

- [ ] **Sync mechanism** - Need to design wallet synchronization strategy
- [ ] Implement remaining OneSatServices methods:
  - [ ] `getChainTracker()`
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
