# OneSatWallet Interface

## Public API

### Inherited from wallet-toolbox `Wallet`
All standard BRC-100 wallet methods: `createAction`, `signAction`, `internalizeAction`, `abortAction`, `listActions`, `listOutputs`, `listCertificates`, `encrypt`, `decrypt`, `createSignature`, `verifySignature`, `getPublicKey`, etc.

### OneSatWallet Extensions

| Method/Property | Purpose |
|-----------------|---------|
| `readOnly` | True if wallet was created with only a public key |
| `services` | Access to OneSatServices (chaintracks, beef, arcade, txo, owner, ordfs, bsv21) |
| `addOwner(address)` | Add address to owned set for indexing |
| `loadTx(txid)` | Load transaction from storage or network |
| `parse(txid)` | Parse transaction through indexers without storing |
| `ingest(tx, description, labels?)` | Parse and internalize external transaction |
| `broadcast(tx, description, labels?)` | Broadcast transaction and ingest if successful |
| `syncAddress(address)` | Start SSE sync for address |
| `stopSync(address)` | Stop sync for address |
| `syncAll()` | Sync all owner addresses |
| `close()` | Cleanup all connections |
| `on(event, callback)` | Subscribe to wallet events |
| `off(event, callback)` | Unsubscribe from wallet events |

### Events

Subscribe via `wallet.on(event, callback)`:

| Event | Data |
|-------|------|
| `sync:start` | `{ address, fromScore }` |
| `sync:output` | `{ address, output }` |
| `sync:skipped` | `{ address, outpoint, reason }` |
| `sync:parsed` | `{ address, txid, parseContext, internalizedCount }` |
| `sync:error` | `{ address, error }` |
| `sync:complete` | `{ address }` |

## Design Decisions

1. **`services` is public** - Users can access API clients directly via `wallet.services.beef`, `wallet.services.bsv21`, etc.

2. **Client classes are exported** - Open source, users can extend them.

3. **Events live on wallet** - All sync events emitted from wallet, not services.

4. **Sync orchestration lives on wallet** - Queue management, progress tracking, and output processing all happen in wallet. Services just provide the raw SSE stream via `owner.sync()`.

5. **Method names are concise** - `parse()`, `ingest()`, `loadTx()`.

6. **`broadcast()` stays** - Combines broadcasting with ingesting.

## OneSatServices

Provides API clients and implements `WalletServices` + `ChainTracker` interfaces:

| Property | Purpose |
|----------|---------|
| `chaintracks` | Block headers, chain tracking |
| `beef` | Raw transactions, proofs, BEEF |
| `arcade` | Transaction broadcasting |
| `txo` | Transaction output queries |
| `owner` | Address queries and SSE sync stream |
| `ordfs` | Content/inscription serving |
| `bsv21` | BSV21 token data |

Services is a thin layer over the API clients with WalletServices interface methods (`getRawTx`, `getMerklePath`, `postBeef`, etc.) for wallet-toolbox compatibility.
