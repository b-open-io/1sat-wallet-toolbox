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

import {
  ArcadeClient,
  BeefClient,
  Bsv21Client,
  ChaintracksClient,
  OrdfsClient,
  OwnerClient,
  TxoClient,
} from "./client";
import type { Capability, ClientOptions, SyncOutput } from "./types";
import type { ParseContext } from "../indexers/types";

export type { SyncOutput };

export interface OneSatServicesEvents {
  "sync:start": { address: string; fromScore: number };
  "sync:output": { address: string; output: SyncOutput };
  "sync:skipped": { address: string; outpoint: string; reason: string };
  "sync:parsed": {
    address: string;
    txid: string;
    parseContext: ParseContext;
    internalizedCount: number;
  };
  "sync:error": { address: string; error: Error };
  "sync:complete": { address: string };
}

type SyncOutputHandler = (address: string, output: SyncOutput) => Promise<void>;
type EventCallback<T> = (event: T) => void;

/**
 * WalletServices implementation for 1Sat ecosystem.
 *
 * Uses the unified 1Sat API at api.1sat.app for:
 * - Block headers and chain tracking (/api/chaintracks/*)
 * - Raw transactions and proofs (/api/beef/*)
 * - Transaction broadcasting (/api/arcade/*)
 * - BSV21 token data (/api/bsv21/*)
 * - Transaction outputs (/api/txo/*)
 * - Owner queries and sync (/api/owner/*)
 * - Content serving (/api/ordfs/*, /content/*)
 */
export class OneSatServices implements WalletServices, ChainTracker {
  chain: Chain;
  readonly baseUrl: string;

  // Route clients (public for direct access)
  readonly chaintracks: ChaintracksClient;
  readonly beef: BeefClient;
  readonly arcade: ArcadeClient;
  readonly txo: TxoClient;
  readonly owner: OwnerClient;
  readonly ordfs: OrdfsClient;
  readonly bsv21: Bsv21Client;

  private storage?: WalletStorageManager;
  private activeSyncs = new Map<string, () => void>();
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
        ? "https://api.1sat.app/api"
        : "https://testnet.api.1sat.app/api");
    this.storage = storage;

    const opts: ClientOptions = { timeout: 30000 };
    this.chaintracks = new ChaintracksClient(
      `${this.baseUrl}/chaintracks`,
      opts,
    );
    this.beef = new BeefClient(`${this.baseUrl}/beef`, opts);
    this.arcade = new ArcadeClient(`${this.baseUrl}/arcade`, opts);
    this.txo = new TxoClient(`${this.baseUrl}/txo`, opts);
    this.owner = new OwnerClient(`${this.baseUrl}/owner`, opts);
    this.ordfs = new OrdfsClient(`${this.baseUrl}/ordfs`, opts);
    this.bsv21 = new Bsv21Client(`${this.baseUrl}/bsv21`, opts);
  }

  // ===== Server Discovery =====

  /**
   * Get list of enabled capabilities from the server
   */
  async getCapabilities(): Promise<Capability[]> {
    const response = await fetch(`${this.baseUrl}/capabilities`);
    if (!response.ok) {
      throw new Error(`Failed to fetch capabilities: ${response.statusText}`);
    }
    return response.json();
  }

  // ===== Event Emitter =====

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

  // ===== Sync Methods =====

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
    this.emit("sync:start", { address, fromScore: from });

    const queue: SyncOutput[] = [];
    let processing = false;
    let done = false;

    const processQueue = async () => {
      if (processing) return;
      processing = true;

      while (queue.length > 0) {
        if (!this.activeSyncs.has(address)) return; // stopped
        const output = queue.shift();
        if (!output) continue;
        try {
          this.emit("sync:output", { address, output });
          await handler(address, output);
          this.setSyncProgress(address, output.score);
        } catch (error) {
          this.activeSyncs.delete(address);
          this.emit("sync:error", {
            address,
            error: error instanceof Error ? error : new Error(String(error)),
          });
          return;
        }
      }

      processing = false;

      if (done) {
        this.activeSyncs.delete(address);
        this.emit("sync:complete", { address });
      }
    };

    const unsubscribe = this.owner.sync(
      address,
      (output) => {
        queue.push(output);
        processQueue();
      },
      from,
      () => {
        done = true;
        processQueue();
      },
      (error) => {
        this.activeSyncs.delete(address);
        this.emit("sync:error", { address, error });
      },
    );

    this.activeSyncs.set(address, unsubscribe);
  }

  stopSync(address: string): void {
    const unsubscribe = this.activeSyncs.get(address);
    if (unsubscribe) {
      unsubscribe();
      this.activeSyncs.delete(address);
    }
  }

  close(): void {
    for (const unsubscribe of this.activeSyncs.values()) {
      unsubscribe();
    }
    this.activeSyncs.clear();
    this.chaintracks.close();
  }

  // ===== ChainTracker Interface =====

  async currentHeight(): Promise<number> {
    return this.chaintracks.currentHeight();
  }

  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    return this.chaintracks.isValidRootForHeight(root, height);
  }

  // ===== WalletServices Interface =====

  async getChainTracker(): Promise<ChainTracker> {
    return this;
  }

  async getHeaderForHeight(height: number): Promise<number[]> {
    return this.chaintracks.getHeaderBytes(height);
  }

  async getHeight(): Promise<number> {
    return this.chaintracks.currentHeight();
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
      const rawTx = await this.beef.getRaw(txid);
      return {
        txid,
        name: "1sat-api",
        rawTx: Array.from(rawTx),
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
      const proofBytes = await this.beef.getProof(txid);
      const merklePath = MerklePath.fromBinary(Array.from(proofBytes));

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

        const status = await this.arcade.submitTransaction(
          beefTx.tx.toBinary(),
        );

        if (
          status.txStatus === "MINED" ||
          status.txStatus === "SEEN_ON_NETWORK" ||
          status.txStatus === "ACCEPTED_BY_NETWORK"
        ) {
          results.push({
            name: "1sat-api",
            status: "success",
            txidResults: [
              {
                txid: status.txid || txid,
                status: "success",
              },
            ],
          });
        } else if (
          status.txStatus === "REJECTED" ||
          status.txStatus === "DOUBLE_SPEND_ATTEMPTED"
        ) {
          results.push({
            name: "1sat-api",
            status: "error",
            error: new WalletError(
              status.txStatus,
              status.extraInfo || "Transaction rejected",
            ),
            txidResults: [
              {
                txid,
                status: "error",
                data: status,
              },
            ],
          });
        } else {
          // Still processing - report as success since tx was accepted
          results.push({
            name: "1sat-api",
            status: "success",
            txidResults: [
              {
                txid: status.txid || txid,
                status: "success",
              },
            ],
          });
        }
      } catch (error) {
        results.push({
          name: "1sat-api",
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

  async getBeefForTxid(txid: string): Promise<Beef> {
    const beefBytes = await this.beef.getBeef(txid);
    return Beef.fromBinary(Array.from(beefBytes));
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
