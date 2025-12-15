import {
  Beef,
  type ChainTracker,
  Hash,
  MerklePath,
  type Transaction,
  Utils,
} from "@bsv/sdk";
import type { WalletStorageManager } from "@bsv/wallet-toolbox/mobile";
import { WalletError } from "@bsv/wallet-toolbox/mobile/out/src/sdk/WalletError";
import type {
  BlockHeader,
  GetMerklePathResult,
  GetRawTxResult,
  GetScriptHashHistoryResult,
  GetStatusForTxidsResult,
  GetUtxoStatusOutputFormat,
  GetUtxoStatusResult,
  PostBeefResult,
  ServiceCallHistory,
  ServicesCallHistory,
  WalletServices,
} from "@bsv/wallet-toolbox/mobile/out/src/sdk/WalletServices.interfaces";
import type { Chain } from "@bsv/wallet-toolbox/mobile/out/src/sdk/types";
import type { TableOutput } from "@bsv/wallet-toolbox/mobile/out/src/storage/schema/tables/TableOutput";
import { HttpError } from "../errors";
import type { Bsv21TransactionData } from "../indexers/types";

export interface SyncOutput {
  outpoint: string;
  score: number;
  spendTxid?: string;
}

export interface ParsedOutputInfo {
  vout: number;
  owner?: string;
  basket?: string;
  tags: string[];
  indexerData: { [tag: string]: unknown };
  included: boolean;
  excludeReason?: string;
}

export interface OneSatServicesEvents {
  "sync:start": { address: string; fromScore: number };
  "sync:output": { address: string; output: SyncOutput };
  "sync:skipped": { address: string; outpoint: string; reason: string };
  "sync:parsed": {
    address: string;
    txid: string;
    outputs: ParsedOutputInfo[];
    internalizedCount: number;
  };
  "sync:error": { address: string; error: Error };
  "sync:complete": { address: string };
}

type SyncOutputHandler = (address: string, output: SyncOutput) => Promise<void>;
type EventCallback<T> = (event: T) => void;

/**
 * OrdFS metadata response structure
 */
export interface OrdfsMetadata {
  outpoint: string;
  origin?: string;
  sequence: number;
  contentType: string;
  contentLength: number;
  parent?: string;
  map?: { [key: string]: unknown };
}

/**
 * BSV21 token details from the overlay
 */
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

/**
 * WalletServices implementation for 1Sat ecosystem.
 *
 * Uses the unified 1Sat API at api.1sat.app for:
 * - Block headers and chain tracking (/block/*)
 * - Raw transactions and proofs (/tx/*)
 * - Transaction broadcasting (/arc/*)
 * - BSV21 token data (/bsv21/*)
 * - Transaction outputs (/txo/*)
 */
export class OneSatServices implements WalletServices {
  chain: Chain;
  readonly baseUrl: string;
  private bsv21TokenCache = new Map<string, Bsv21TokenDetails>();
  private chainTracker: ChainTracker | null = null;
  private storage?: WalletStorageManager;
  private activeSyncs = new Map<string, EventSource>();
  private syncHandlers = new Map<string, SyncOutputHandler>();
  private listeners: {
    [K in keyof OneSatServicesEvents]?: Set<
      EventCallback<OneSatServicesEvents[K]>
    >;
  } = {};

  constructor(chain: Chain, baseUrl?: string, storage?: WalletStorageManager) {
    this.chain = chain;
    this.baseUrl =
      baseUrl ||
      (chain === "main"
        ? "https://api.1sat.app"
        : "https://testnet.api.1sat.app");
    this.storage = storage;
  }

  on<K extends keyof OneSatServicesEvents>(
    event: K,
    callback: EventCallback<OneSatServicesEvents[K]>,
  ): void {
    if (!this.listeners[event]) {
      (
        this.listeners as Record<K, Set<EventCallback<OneSatServicesEvents[K]>>>
      )[event] = new Set();
    }
    (this.listeners[event] as Set<EventCallback<OneSatServicesEvents[K]>>).add(
      callback,
    );
  }

  off<K extends keyof OneSatServicesEvents>(
    event: K,
    callback: EventCallback<OneSatServicesEvents[K]>,
  ): void {
    (
      this.listeners[event] as
        | Set<EventCallback<OneSatServicesEvents[K]>>
        | undefined
    )?.delete(callback);
  }

  emit<K extends keyof OneSatServicesEvents>(
    event: K,
    data: OneSatServicesEvents[K],
  ): void {
    for (const cb of this.listeners[event] ?? []) {
      cb(data);
    }
  }

  private getSyncStorageKey(address: string): string {
    return `1sat:sync:${address}`;
  }

  getSyncProgress(address: string): number {
    return Number(localStorage.getItem(this.getSyncStorageKey(address)) || "0");
  }

  private setSyncProgress(address: string, score: number): void {
    localStorage.setItem(this.getSyncStorageKey(address), score.toString());
  }

  syncAddress(address: string, handler: SyncOutputHandler): void {
    this.stopSync(address);

    const from = this.getSyncProgress(address);
    this.syncHandlers.set(address, handler);
    this.emit("sync:start", { address, fromScore: from });

    const url = `${this.baseUrl}/owner/${address}/sync/stream?from=${from}`;
    const eventSource = new EventSource(url);
    this.activeSyncs.set(address, eventSource);

    const cleanup = () => {
      eventSource.close();
      this.activeSyncs.delete(address);
      this.syncHandlers.delete(address);
    };

    eventSource.onmessage = async (event) => {
      const output: SyncOutput = JSON.parse(event.data);
      const currentHandler = this.syncHandlers.get(address);

      this.emit("sync:output", { address, output });

      if (currentHandler) {
        try {
          await currentHandler(address, output);
          this.setSyncProgress(address, output.score);
        } catch (error) {
          // Handler threw - don't update progress, emit error
          this.emit("sync:error", {
            address,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      } else {
        // No handler, just update progress
        this.setSyncProgress(address, output.score);
      }
    };

    eventSource.addEventListener("done", () => {
      cleanup();
      this.emit("sync:complete", { address });
    });

    eventSource.addEventListener("error", () => {
      cleanup();
      this.emit("sync:error", {
        address,
        error: new Error("SSE connection error"),
      });
    });

    eventSource.onerror = () => {
      if (eventSource.readyState === EventSource.CLOSED) {
        cleanup();
        this.emit("sync:error", {
          address,
          error: new Error("SSE connection closed"),
        });
      }
    };
  }

  stopSync(address: string): void {
    const eventSource = this.activeSyncs.get(address);
    if (eventSource) {
      eventSource.close();
      this.activeSyncs.delete(address);
      this.syncHandlers.delete(address);
    }
  }

  isSyncing(address: string): boolean {
    return this.activeSyncs.has(address);
  }

  close(): void {
    for (const eventSource of this.activeSyncs.values()) {
      eventSource.close();
    }
    this.activeSyncs.clear();
    this.syncHandlers.clear();
  }

  async getChainTracker(): Promise<ChainTracker> {
    if (this.chainTracker) return this.chainTracker;

    const baseUrl = this.baseUrl;
    this.chainTracker = {
      currentHeight: async (): Promise<number> => {
        const resp = await fetch(`${baseUrl}/block/tip`);
        if (!resp.ok) throw new Error(`Failed to fetch tip: ${resp.status}`);
        const data = await resp.json();
        return data.height;
      },
      isValidRootForHeight: async (
        root: string,
        height: number,
      ): Promise<boolean> => {
        const resp = await fetch(`${baseUrl}/block/header/height/${height}`);
        if (!resp.ok) return false;
        const data = await resp.json();
        return data.merkleRoot === root;
      },
    };
    return this.chainTracker;
  }

  async getHeaderForHeight(height: number): Promise<number[]> {
    const resp = await fetch(
      `${this.baseUrl}/block/headers?height=${height}&count=1`,
    );
    if (!resp.ok) {
      throw new Error(
        `Failed to fetch header for height ${height}: ${resp.statusText}`,
      );
    }
    const arrayBuffer = await resp.arrayBuffer();
    return Array.from(new Uint8Array(arrayBuffer));
  }

  async getHeight(): Promise<number> {
    const resp = await fetch(`${this.baseUrl}/block/height`);
    if (!resp.ok) {
      throw new Error(`Failed to fetch chain height: ${resp.statusText}`);
    }
    const data = await resp.json();
    return data.height;
  }

  async getBsvExchangeRate(): Promise<number> {
    throw new Error("Exchange rate fetching not yet implemented");
  }

  async getFiatExchangeRate(
    _currency: "USD" | "GBP" | "EUR",
    _base?: "USD" | "GBP" | "EUR",
  ): Promise<number> {
    throw new Error("Fiat exchange rate not yet implemented");
  }

  async getRawTx(txid: string, _useNext?: boolean): Promise<GetRawTxResult> {
    // Check storage first
    if (this.storage) {
      const rawTx = await this.storage.runAsStorageProvider(async (sp) => {
        return await sp.getRawTxOfKnownValidTransaction(txid);
      });
      if (rawTx) {
        return {
          txid,
          name: "storage",
          rawTx,
        };
      }
    }

    // Fetch from network
    try {
      const resp = await fetch(`${this.baseUrl}/tx/${txid}`);
      if (!resp.ok) {
        return {
          txid,
          error: new WalletError(
            "FETCH_FAILED",
            `Failed to fetch transaction: ${resp.statusText}`,
          ),
        };
      }
      const arrayBuffer = await resp.arrayBuffer();
      const rawTx = Array.from(new Uint8Array(arrayBuffer));
      return {
        txid,
        name: "1sat-api",
        rawTx,
      };
    } catch (error) {
      return {
        txid,
        error: new WalletError(
          "NETWORK_ERROR",
          error instanceof Error ? error.message : "Unknown error",
        ),
      };
    }
  }

  async getMerklePath(
    txid: string,
    _useNext?: boolean,
  ): Promise<GetMerklePathResult> {
    try {
      const resp = await fetch(`${this.baseUrl}/tx/${txid}/proof`);
      if (!resp.ok) {
        return {
          name: "1sat-api",
          error: new WalletError(
            "FETCH_FAILED",
            `Failed to fetch merkle proof: ${resp.statusText}`,
          ),
        };
      }
      const arrayBuffer = await resp.arrayBuffer();
      const proofBytes = Array.from(new Uint8Array(arrayBuffer));
      const merklePath = MerklePath.fromBinary(proofBytes);

      return {
        name: "1sat-api",
        merklePath,
      };
    } catch (error) {
      return {
        name: "1sat-api",
        error: new WalletError(
          "NETWORK_ERROR",
          error instanceof Error ? error.message : "Unknown error",
        ),
      };
    }
  }

  async postBeef(beef: Beef, txids: string[]): Promise<PostBeefResult[]> {
    const results: PostBeefResult[] = [];

    for (const txid of txids) {
      try {
        const beefTx = beef.findTxid(txid);
        if (!beefTx?.tx) {
          results.push({
            name: "1sat-api",
            status: "error",
            error: new WalletError(
              "TX_NOT_FOUND",
              `Transaction ${txid} not found in BEEF`,
            ),
            txidResults: [
              {
                txid,
                status: "error",
                data: { detail: "Transaction not found in BEEF" },
              },
            ],
          });
          continue;
        }

        const resp = await fetch(`${this.baseUrl}/arc/tx`, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
          },
          body: new Uint8Array(beefTx.tx.toBinary()),
        });

        const body = await resp.json();

        if (resp.status === 200) {
          results.push({
            name: "1sat-api",
            status: "success",
            txidResults: [
              {
                txid: body.txid || txid,
                status: "success",
              },
            ],
          });
        } else {
          results.push({
            name: "1sat-api",
            status: "error",
            error: new WalletError(
              resp.status.toString(),
              body.error || resp.statusText,
            ),
            txidResults: [
              {
                txid,
                status: "error",
                data: body,
              },
            ],
          });
        }
      } catch (error) {
        results.push({
          name: "onesat-api",
          status: "error",
          error: new WalletError(
            "NETWORK_ERROR",
            error instanceof Error ? error.message : "Unknown error",
          ),
          txidResults: [
            {
              txid,
              status: "error",
            },
          ],
        });
      }
    }

    return results;
  }

  hashOutputScript(script: string): string {
    const scriptBin = Utils.toArray(script, "hex");
    return Utils.toHex(Hash.hash256(scriptBin).reverse());
  }

  async getStatusForTxids(
    _txids: string[],
    _useNext?: boolean,
  ): Promise<GetStatusForTxidsResult> {
    throw new Error("getStatusForTxids not yet implemented");
  }

  async isUtxo(_output: TableOutput): Promise<boolean> {
    throw new Error("isUtxo not yet implemented");
  }

  async getUtxoStatus(
    _output: string,
    _outputFormat?: GetUtxoStatusOutputFormat,
    _outpoint?: string,
    _useNext?: boolean,
  ): Promise<GetUtxoStatusResult> {
    throw new Error("getUtxoStatus not yet implemented");
  }

  async getScriptHashHistory(
    _hash: string,
    _useNext?: boolean,
  ): Promise<GetScriptHashHistoryResult> {
    throw new Error("getScriptHashHistory not yet implemented");
  }

  async hashToHeader(_hash: string): Promise<BlockHeader> {
    throw new Error("hashToHeader not yet implemented");
  }

  async nLockTimeIsFinal(
    _txOrLockTime: string | number[] | Transaction | number,
  ): Promise<boolean> {
    throw new Error("nLockTimeIsFinal not yet implemented");
  }

  async getBeefBytes(txid: string): Promise<number[]> {
    // Check storage first
    if (this.storage) {
      const txs = await this.storage.runAsStorageProvider(async (sp) => {
        return await sp.findTransactions({ partial: { txid } });
      });
      if (txs.length > 0 && txs[0].inputBEEF) {
        return txs[0].inputBEEF;
      }
    }

    // Fetch from network
    const resp = await fetch(`${this.baseUrl}/tx/${txid}/beef`);
    if (!resp.ok) {
      throw new Error(
        `Failed to fetch BEEF for txid ${txid}: ${resp.statusText}`,
      );
    }
    const arrayBuffer = await resp.arrayBuffer();
    return Array.from(new Uint8Array(arrayBuffer));
  }

  async getBeefForTxid(txid: string): Promise<Beef> {
    const beefBytes = await this.getBeefBytes(txid);
    return Beef.fromBinary(beefBytes);
  }

  /**
   * Get OrdFS metadata for an outpoint
   * @throws {HttpError} on HTTP errors (check status for specifics)
   */
  async getOrdfsMetadata(outpoint: string): Promise<OrdfsMetadata> {
    const resp = await fetch(`${this.baseUrl}/ordfs/metadata/${outpoint}`);
    if (!resp.ok) {
      throw new HttpError(
        resp.status,
        `TXO metadata fetch failed: ${resp.statusText}`,
      );
    }
    return await resp.json();
  }

  /**
   * Get BSV21 token data by txid from the overlay
   * @throws {HttpError} on HTTP errors (check status for specifics)
   */
  async getBsv21TokenByTxid(
    _tokenId: string,
    txid: string,
  ): Promise<Bsv21TransactionData> {
    const resp = await fetch(`${this.baseUrl}/bsv21/tx/${txid}`);
    if (!resp.ok) {
      throw new HttpError(
        resp.status,
        `BSV21 token fetch failed: ${resp.statusText}`,
      );
    }
    return await resp.json();
  }

  /**
   * Get BSV21 token details (metadata) by token ID
   * Results are cached since token details are immutable
   * @throws {HttpError} on HTTP errors (check status for specifics)
   */
  async getBsv21TokenDetails(tokenId: string): Promise<Bsv21TokenDetails> {
    const cached = this.bsv21TokenCache.get(tokenId);
    if (cached) return cached;

    const resp = await fetch(`${this.baseUrl}/bsv21/token/${tokenId}`);
    if (!resp.ok) {
      throw new HttpError(
        resp.status,
        `BSV21 token details fetch failed: ${resp.statusText}`,
      );
    }
    const details: Bsv21TokenDetails = await resp.json();
    this.bsv21TokenCache.set(tokenId, details);
    return details;
  }

  getServicesCallHistory(_reset?: boolean): ServicesCallHistory {
    const emptyHistory: ServiceCallHistory = {
      serviceName: "",
      historyByProvider: {},
    };

    return {
      version: 1,
      getMerklePath: { ...emptyHistory, serviceName: "getMerklePath" },
      getRawTx: { ...emptyHistory, serviceName: "getRawTx" },
      postBeef: { ...emptyHistory, serviceName: "postBeef" },
      getUtxoStatus: { ...emptyHistory, serviceName: "getUtxoStatus" },
      getStatusForTxids: { ...emptyHistory, serviceName: "getStatusForTxids" },
      getScriptHashHistory: {
        ...emptyHistory,
        serviceName: "getScriptHashHistory",
      },
      updateFiatExchangeRates: {
        ...emptyHistory,
        serviceName: "updateFiatExchangeRates",
      },
    };
  }
}
