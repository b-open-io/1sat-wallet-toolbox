# OneSatService Consolidation Design

## Overview

This document outlines the plan to refactor `OneSatServices` in 1sat-wallet-toolbox to:
1. Mirror all 1sat-stack API routes with a clear, organized API
2. Move arcade and chaintracks TypeScript client code here (then delete from original repos)
3. Maintain `WalletServices` interface compatibility

## Route Mapping

Based on actual 1sat-stack implementation:

| Prefix | Capability | Description | Code From |
|--------|------------|-------------|-----------|
| `/capabilities` | - | Server feature discovery | New |
| `/chaintracks/*` | `chaintracks` | Block/chain data | go-chaintracks/ts-client |
| `/beef/*` | `beef` | Raw tx, BEEF, proofs | Current OneSatServices |
| `/arcade/*` | `arcade` | Broadcast & status | arcade/ts-client |
| `/indexer/*` | `indexer` | Indexer operations | New |
| `/txo/*` | `txo` | TXO lookup | New |
| `/owner/*` | `owner` | Owner queries | Current OneSatServices |
| `/ordfs/*` | `ordfs` | Content & metadata | Current OneSatServices |
| `/content/*` | (part of ordfs) | Root-level content | Current OneSatServices |
| `/bsv21/*` | `bsv21` | Token queries | Current OneSatServices |
| `/sse/*` | `pubsub` | SSE subscriptions | New |
| `/overlay/*` | `overlay` | Overlay engine (GASP) | New |

**Note:** The server currently uses `/sse` with capability `pubsub`. Future versions may rename to `/sub` with capability `sub` for consistency.

## File Structure

```
src/services/
  OneSatServices.ts      # Main facade (refactor existing)
  types.ts               # All type definitions
  errors.ts              # Error classes
  client/
    BaseClient.ts        # Shared HTTP utilities, timeout, error handling
    ChaintracksClient.ts # /chaintracks/* routes (move from go-chaintracks/ts-client)
    BeefClient.ts        # /beef/* routes
    ArcadeClient.ts      # /arcade/* routes (move from arcade/ts-client)
    IndexerClient.ts     # /indexer/* routes
    TxoClient.ts         # /txo/* routes
    OwnerClient.ts       # /owner/* routes
    OrdfsClient.ts       # /ordfs/* routes
    Bsv21Client.ts       # /bsv21/* routes
    SseClient.ts         # /sse/* routes (SSE subscriptions)
```

## Type Definitions (`src/services/types.ts`)

### From arcade/ts-client (move here)
```typescript
export type Status =
  | 'UNKNOWN' | 'RECEIVED' | 'SENT_TO_NETWORK'
  | 'ACCEPTED_BY_NETWORK' | 'SEEN_ON_NETWORK'
  | 'DOUBLE_SPEND_ATTEMPTED' | 'REJECTED' | 'MINED' | 'IMMUTABLE';

export interface TransactionStatus {
  txid: string;
  txStatus: Status;
  timestamp: string;
  blockHash?: string;
  blockHeight?: number;
  merklePath?: string;
  extraInfo?: string;
  competingTxs?: string[];
}

export interface SubmitOptions {
  callbackUrl?: string;
  callbackToken?: string;
  fullStatusUpdates?: boolean;
  skipFeeValidation?: boolean;
  skipScriptValidation?: boolean;
}

export interface Policy {
  maxscriptsizepolicy: number;
  maxtxsigopscountspolicy: number;
  maxtxsizepolicy: number;
  miningFee: { satoshis: number; bytes: number };
}

export interface ClientOptions {
  timeout?: number;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}
```

### From go-chaintracks/ts-client (move here)
```typescript
export interface BlockHeader {
  height: number;
  hash: string;
  version: number;
  prevHash: string;
  merkleRoot: string;
  time: number;
  bits: number;
  nonce: number;
}
```

### Existing (Keep)
```typescript
export interface SyncOutput {
  outpoint: string;
  score: number;
  spendTxid?: string;
}

export interface OrdfsMetadata {
  outpoint: string;
  origin?: string;
  sequence: number;
  contentType: string;
  contentLength: number;
  parent?: string;
  map?: Record<string, unknown>;
}

export interface Bsv21TokenDetails {
  id: string;
  txid: string;
  vout: number;
  op: string;
  amt: string;
  sym?: string;
  dec: number;
  icon?: string;
}
```

### New Types
```typescript
// Server capabilities - which services are enabled
// These match the actual capability names returned by 1sat-stack /capabilities endpoint
export type Capability =
  | 'beef'
  | 'pubsub'      // SSE subscriptions (route: /sse)
  | 'txo'
  | 'owner'       // Owner queries (route: /owner)
  | 'indexer'     // Indexer operations (route: /indexer)
  | 'bsv21'
  | 'ordfs'
  | 'chaintracks' // Block headers (route: /chaintracks)
  | 'arcade'      // TX broadcast (route: /arcade)
  | 'overlay';    // Overlay engine (route: /overlay)

export interface Txo {
  outpoint: string;
  height?: number;
  idx?: number;
  satoshis: number;
  owners?: string[];
  events?: string[];
  data?: Record<string, unknown>;
  spend?: string;
  score: number;
}

export interface OwnerBalance {
  confirmed: number;
  unconfirmed: number;
  total: number;
}

export interface QueryOptions {
  tags?: string[];
  script?: boolean;
  spend?: boolean;
  from?: number;
  limit?: number;
  rev?: boolean;
}
```

## Client Implementations

### BaseClient (`src/services/client/BaseClient.ts`)

Shared utilities ported from arcade client:

```typescript
export class BaseClient {
  protected baseUrl: string;
  protected timeout: number;
  protected fetchFn: typeof fetch;

  constructor(baseUrl: string, options: ClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeout = options.timeout ?? 30000;
    this.fetchFn = options.fetch ?? fetch;
  }

  protected async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await this.parseError(response);
        throw error;
      }

      return response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  protected async requestBinary(path: string, init?: RequestInit): Promise<Uint8Array> {
    // Similar to request but returns ArrayBuffer
  }

  private async parseError(response: Response): Promise<Error> {
    try {
      const data = await response.json();
      return new HttpError(response.status, data.message || response.statusText, data);
    } catch {
      const text = await response.text();
      return new HttpError(response.status, text || response.statusText);
    }
  }
}
```

### ChaintracksClient (`src/services/client/ChaintracksClient.ts`)

Move from go-chaintracks/ts-client, implements `ChainTracker`:

```typescript
export class ChaintracksClient extends BaseClient implements ChainTracker {
  async currentHeight(): Promise<number> {
    const tip = await this.getTip();
    return tip.height;
  }

  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    const header = await this.getHeaderByHeight(height);
    return header.merkleRoot === root;
  }

  async getTip(): Promise<BlockHeader> {
    return this.request<BlockHeader>('/tip');
  }

  async getHeaderByHeight(height: number): Promise<BlockHeader> {
    return this.request<BlockHeader>(`/header/height/${height}`);
  }

  async getHeaderByHash(hash: string): Promise<BlockHeader> {
    return this.request<BlockHeader>(`/header/hash/${hash}`);
  }

  async getHeaders(height: number, count: number): Promise<BlockHeader[]> {
    const binary = await this.requestBinary(`/headers?height=${height}&count=${count}`);
    return this.parseHeaders(binary, height);
  }

  async getHeaderBytes(height: number): Promise<number[]> {
    const binary = await this.requestBinary(`/headers?height=${height}&count=1`);
    return Array.from(binary);
  }

  subscribeTip(callback: (header: BlockHeader) => void): () => void {
    // EventSource subscription to /tip/stream
  }
}
```

### ArcadeClient (`src/services/client/ArcadeClient.ts`)

Move from arcade/ts-client:

```typescript
export class ArcadeClient extends BaseClient {
  async submitTransaction(rawTx: Uint8Array, options?: SubmitOptions): Promise<TransactionStatus> {
    return this.request('/tx', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.buildSubmitHeaders(options),
      },
      body: JSON.stringify({ rawTx: bytesToHex(rawTx) }),
    });
  }

  async submitTransactions(rawTxs: Uint8Array[], options?: SubmitOptions): Promise<TransactionStatus[]> {
    return this.request('/txs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.buildSubmitHeaders(options),
      },
      body: JSON.stringify(rawTxs.map(tx => ({ rawTx: bytesToHex(tx) }))),
    });
  }

  async getStatus(txid: string): Promise<TransactionStatus> {
    return this.request(`/tx/${txid}`);
  }

  async getPolicy(): Promise<Policy> {
    return this.request('/policy');
  }

  subscribe(callbackToken?: string): SSESubscription<TransactionStatus> {
    // AsyncIterable SSE subscription
  }

  private buildSubmitHeaders(options?: SubmitOptions): Record<string, string> {
    const headers: Record<string, string> = {};
    if (options?.callbackUrl) headers['X-CallbackUrl'] = options.callbackUrl;
    if (options?.callbackToken) headers['X-CallbackToken'] = options.callbackToken;
    if (options?.fullStatusUpdates) headers['X-FullStatusUpdates'] = 'true';
    if (options?.skipFeeValidation) headers['X-SkipFeeValidation'] = 'true';
    if (options?.skipScriptValidation) headers['X-SkipScriptValidation'] = 'true';
    return headers;
  }
}
```

### BeefClient (`src/services/client/BeefClient.ts`)

```typescript
export class BeefClient extends BaseClient {
  async getRaw(txid: string): Promise<Uint8Array> {
    return this.requestBinary(`/${txid}/raw`);
  }

  async getBeef(txid: string): Promise<Uint8Array> {
    return this.requestBinary(`/${txid}`);
  }

  async getProof(txid: string): Promise<MerkleProof> {
    return this.request(`/${txid}/proof`);
  }
}
```

### IdxClient (`src/services/client/IdxClient.ts`)

```typescript
export class IdxClient extends BaseClient {
  async parse(rawTx: Uint8Array): Promise<Txo[]> {
    return this.request('/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: rawTx,
    });
  }

  async ingest(txid: string): Promise<void> {
    await this.request(`/${txid}/ingest`, { method: 'POST' });
  }

  async getTxos(txid: string): Promise<Txo[]> {
    return this.request(`/${txid}/txos`);
  }
}
```

### TxoClient (`src/services/client/TxoClient.ts`)

```typescript
export class TxoClient extends BaseClient {
  async get(outpoint: string, opts?: QueryOptions): Promise<Txo> {
    const params = this.buildQueryParams(opts);
    return this.request(`/${outpoint}${params}`);
  }

  async getBatch(outpoints: string[], opts?: QueryOptions): Promise<Txo[]> {
    return this.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outpoints, ...opts }),
    });
  }

  async getSpend(outpoint: string): Promise<string | null> {
    return this.request(`/${outpoint}/spend`);
  }

  async getSpends(outpoints: string[]): Promise<Record<string, string | null>> {
    return this.request('/spends', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outpoints }),
    });
  }
}
```

### OwnerClient (`src/services/client/OwnerClient.ts`)

```typescript
export class OwnerClient extends BaseClient {
  async getTxos(owner: string, opts?: QueryOptions): Promise<Txo[]> {
    const params = this.buildQueryParams(opts);
    return this.request(`/${owner}/txos${params}`);
  }

  async getUtxos(owner: string, opts?: QueryOptions): Promise<Txo[]> {
    const params = this.buildQueryParams(opts);
    return this.request(`/${owner}/utxos${params}`);
  }

  async getBalance(owner: string): Promise<OwnerBalance> {
    return this.request(`/${owner}/balance`);
  }

  async sync(owner: string, from?: number): Promise<SyncResponse> {
    const params = from ? `?from=${from}` : '';
    return this.request(`/${owner}/sync${params}`);
  }

  syncStream(owner: string, from?: number): SSESubscription<SyncOutput> {
    const params = from ? `?from=${from}` : '';
    return new SSESubscription(`${this.baseUrl}/${owner}/sync/stream${params}`);
  }
}
```

### OrdfsClient (`src/services/client/OrdfsClient.ts`)

```typescript
export class OrdfsClient extends BaseClient {
  async getContent(path: string): Promise<Uint8Array> {
    return this.requestBinary(`/${path}`);
  }

  async getMetadata(outpoint: string): Promise<OrdfsMetadata> {
    return this.request(`/metadata/${outpoint}`);
  }

  async stream(outpoint: string): AsyncIterable<Uint8Array> {
    // Streaming content for large files
  }
}
```

### Bsv21Client (`src/services/client/Bsv21Client.ts`)

```typescript
export class Bsv21Client extends BaseClient {
  private cache = new Map<string, Bsv21TokenDetails>();

  async getTokenDetails(tokenId: string): Promise<Bsv21TokenDetails> {
    const cached = this.cache.get(tokenId);
    if (cached) return cached;

    const details = await this.request<Bsv21TokenDetails>(`/${tokenId}`);
    this.cache.set(tokenId, details);
    return details;
  }

  async getTokenByTxid(tokenId: string, txid: string): Promise<Bsv21TransactionData> {
    return this.request(`/${tokenId}/tx/${txid}`);
  }

  async getBalance(tokenId: string, lockType: string, address: string): Promise<bigint> {
    return this.request(`/${tokenId}/${lockType}/${address}/balance`);
  }

  async getUnspent(tokenId: string, lockType: string, address: string): Promise<Txo[]> {
    return this.request(`/${tokenId}/${lockType}/${address}/unspent`);
  }

  async getHistory(tokenId: string, lockType: string, address: string): Promise<Txo[]> {
    return this.request(`/${tokenId}/${lockType}/${address}/history`);
  }
}
```

## OneSatServices Facade

The main `OneSatServices` class delegates to route clients while maintaining backward compatibility:

```typescript
export class OneSatServices implements WalletServices, ChainTracker {
  readonly chain: Chain;
  readonly baseUrl: string;

  // Route clients (public for direct access)
  readonly chaintracks: ChaintracksClient;
  readonly beef: BeefClient;
  readonly arcade: ArcadeClient;
  readonly indexer: IndexerClient;
  readonly txo: TxoClient;
  readonly owner: OwnerClient;
  readonly ordfs: OrdfsClient;
  readonly bsv21: Bsv21Client;
  readonly sse: SseClient;

  // Internal state
  private storage?: WalletStorageManager;
  private listeners: { [K in keyof OneSatServicesEvents]?: Set<EventCallback<OneSatServicesEvents[K]>> } = {};
  private activeSyncs = new Map<string, SSESubscription<SyncOutput>>();

  constructor(chain: Chain, baseUrl?: string, storage?: WalletStorageManager) {
    this.chain = chain;
    this.baseUrl = baseUrl || (chain === 'main'
      ? 'https://api.1sat.app'
      : 'https://testnet.api.1sat.app');
    this.storage = storage;

    const opts: ClientOptions = { timeout: 30000 };
    this.chaintracks = new ChaintracksClient(`${this.baseUrl}/chaintracks`, opts);
    this.beef = new BeefClient(`${this.baseUrl}/beef`, opts);
    this.arcade = new ArcadeClient(`${this.baseUrl}/arcade`, opts);
    this.indexer = new IndexerClient(`${this.baseUrl}/indexer`, opts);
    this.txo = new TxoClient(`${this.baseUrl}/txo`, opts);
    this.owner = new OwnerClient(`${this.baseUrl}/owner`, opts);
    this.ordfs = new OrdfsClient(`${this.baseUrl}/ordfs`, opts);
    this.bsv21 = new Bsv21Client(`${this.baseUrl}/bsv21`, opts);
    this.sse = new SseClient(`${this.baseUrl}/sse`, opts);
  }

  // ===== Server Discovery =====

  async getCapabilities(): Promise<Capability[]> {
    const response = await fetch(`${this.baseUrl}/capabilities`);
    return response.json();
  }

  // ===== ChainTracker interface (direct implementation) =====

  async currentHeight(): Promise<number> {
    return this.chaintracks.currentHeight();
  }

  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    return this.chaintracks.isValidRootForHeight(root, height);
  }

  // ===== WalletServices interface =====

  async getChainTracker(): Promise<ChainTracker> {
    return this; // OneSatServices now implements ChainTracker directly
  }

  async getHeaderForHeight(height: number): Promise<number[]> {
    return this.chaintracks.getHeaderBytes(height);
  }

  async getHeight(): Promise<number> {
    return this.chaintracks.currentHeight();
  }

  async getRawTx(txid: string, useServices?: string): Promise<GetRawTxResult> {
    // Check storage first
    if (this.storage) {
      const rawTx = await this.storage.runAsStorageProvider(async (sp) => {
        return await sp.getRawTxOfKnownValidTransaction(txid);
      });
      if (rawTx) return { txid, name: 'storage', rawTx };
    }
    // Fallback to network
    const rawTx = await this.beef.getRaw(txid);
    return { txid, name: '1sat', rawTx: Array.from(rawTx) };
  }

  async getMerklePath(txid: string, useServices?: string): Promise<GetMerklePathResult> {
    const proof = await this.beef.getProof(txid);
    return { txid, name: '1sat', merklePath: MerklePath.fromBinary(proof) };
  }

  async postBeef(beef: Beef, txids: string[]): Promise<PostBeefResult[]> {
    const status = await this.arcade.submitTransaction(beef.toBinary());
    return txids.map(txid => ({
      txid,
      name: '1sat',
      status: status.txStatus === 'MINED' ? 'success' : 'sending',
    }));
  }

  // ... other WalletServices methods ...

  // ===== Backward-compatible sync methods =====

  syncAddress(address: string, handler: SyncOutputHandler): void {
    // Port existing implementation using this.owner.syncStream()
  }

  stopSync(address: string): void {
    const subscription = this.activeSyncs.get(address);
    subscription?.close();
    this.activeSyncs.delete(address);
  }

  // ===== Event emitter (existing pattern) =====

  on<K extends keyof OneSatServicesEvents>(event: K, callback: EventCallback<OneSatServicesEvents[K]>): void {
    // Keep existing implementation
  }

  off<K extends keyof OneSatServicesEvents>(event: K, callback: EventCallback<OneSatServicesEvents[K]>): void {
    // Keep existing implementation
  }

  emit<K extends keyof OneSatServicesEvents>(event: K, data: OneSatServicesEvents[K]): void {
    // Keep existing implementation
  }

  // ===== Cleanup =====

  close(): void {
    for (const subscription of this.activeSyncs.values()) {
      subscription.close();
    }
    this.activeSyncs.clear();
  }
}
```

## Usage Examples

### Direct Route Access (New)
```typescript
const services = new OneSatServices('main');

// Check server capabilities
const caps = await services.getCapabilities();
if (caps.includes('bsv21')) {
  // BSV21 token operations available
}

// Block operations (route: /chaintracks)
const tip = await services.chaintracks.getTip();
const header = await services.chaintracks.getHeaderByHeight(850000);

// BEEF operations (route: /beef) - raw tx, proofs
const rawTx = await services.beef.getRaw(txid);
const beefData = await services.beef.getBeef(txid);

// Broadcast (route: /arcade)
const status = await services.arcade.submitTransaction(rawTx, {
  callbackUrl: 'https://example.com/callback',
  callbackToken: 'my-token',
});

// Owner queries (route: /owner)
const utxos = await services.owner.getUtxos(address);
const balance = await services.owner.getBalance(address);

// SSE sync (via owner route)
for await (const output of services.owner.syncStream(address)) {
  console.log('New output:', output);
}

// Token queries (route: /bsv21)
const tokenDetails = await services.bsv21.getTokenDetails(tokenId);
const tokenBalance = await services.bsv21.getBalance(tokenId, 'p2pkh', address);
```

### WalletServices Interface (Existing, Preserved)
```typescript
const services = new OneSatServices('main', undefined, storageManager);

// These all still work
const result = await services.getRawTx(txid);
const tracker = await services.getChainTracker();
const height = await tracker.currentHeight();
await services.postBeef(beef, txids);
```

## Migration Checklist

### Client Implementation
- [x] Create `src/services/types.ts` with consolidated types
- [x] Create `src/services/client/BaseClient.ts`
- [x] Create `src/services/client/ChaintracksClient.ts` (replaces go-chaintracks/ts-client)
- [x] Create `src/services/client/BeefClient.ts`
- [x] Create `src/services/client/ArcadeClient.ts` (replaces arcade/ts-client)
- [x] Create `src/services/client/TxoClient.ts`
- [x] Create `src/services/client/OwnerClient.ts`
- [x] Create `src/services/client/OrdfsClient.ts`
- [x] Create `src/services/client/Bsv21Client.ts`
- [x] Refactor `src/services/OneSatServices.ts`
- [x] Update `src/index.ts` exports
- [x] Remove `@bsv-blockchain/chaintracks-client` dependency (no longer needed)
- [ ] Delete go-chaintracks/ts-client (can be done now)
- [ ] Delete arcade/ts-client (can be done now)
- [ ] Update tests

### Not Implemented (low priority)
- [ ] Create `src/services/client/IndexerClient.ts` - for /api/indexer/* routes
- [ ] Create `src/services/client/SseClient.ts` - for /api/sse/* general pubsub

### Route Updates (COMPLETED)
- [x] Update `/block` to `/chaintracks` for ChaintracksClient
- [x] Update `/arc` to `/arcade` for transaction broadcast
- [x] Update `/own` to `/owner` for sync endpoint
- [x] Update `/bsv21/token/:tokenId` to `/bsv21/:tokenId`
- [x] Update `/bsv21/tx/:txid` to `/bsv21/:tokenId/tx/:txid`

### Future 1sat-stack changes (NOT YET IMPLEMENTED)
The following changes are planned but not yet implemented in 1sat-stack:
- [ ] Rename `/sse` route prefix to `/sub`
- [ ] Rename capability from `pubsub` to `sub`

These will require coordinated updates to both 1sat-stack and this client library.
