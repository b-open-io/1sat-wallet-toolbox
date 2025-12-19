import { Beef, Hash, MerklePath, Transaction, Utils } from "@bsv/sdk";
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

export type { SyncOutput };

/**
 * WalletServices implementation for 1Sat ecosystem.
 *
 * Provides access to 1Sat API clients and implements the WalletServices
 * interface required by wallet-toolbox.
 *
 * API Routes:
 * - /api/chaintracks/* - Block headers and chain tracking
 * - /api/beef/* - Raw transactions and proofs
 * - /api/arcade/* - Transaction broadcasting
 * - /api/bsv21/* - BSV21 token data
 * - /api/txo/* - Transaction outputs
 * - /api/owner/* - Address queries and sync
 * - /api/ordfs/* - Content/inscription serving
 */
export class OneSatServices implements WalletServices {
  chain: Chain;
  readonly baseUrl: string;
  private storage?: WalletStorageManager;

  // ===== API Clients =====
  readonly chaintracks: ChaintracksClient;
  readonly beef: BeefClient;
  readonly arcade: ArcadeClient;
  readonly txo: TxoClient;
  readonly owner: OwnerClient;
  readonly ordfs: OrdfsClient;
  readonly bsv21: Bsv21Client;

  constructor(chain: Chain, baseUrl?: string, storage?: WalletStorageManager) {
    this.chain = chain;
    this.baseUrl =
      baseUrl ||
      (chain === "main"
        ? "https://1sat.shruggr.cloud"
        : "https://testnet.api.1sat.app");
    this.storage = storage;

    const opts: ClientOptions = { timeout: 30000 };
    this.chaintracks = new ChaintracksClient(this.baseUrl, opts);
    this.beef = new BeefClient(this.baseUrl, opts);
    this.arcade = new ArcadeClient(this.baseUrl, opts);
    this.txo = new TxoClient(this.baseUrl, opts);
    this.owner = new OwnerClient(this.baseUrl, opts);
    this.ordfs = new OrdfsClient(this.baseUrl, opts);
    this.bsv21 = new Bsv21Client(this.baseUrl, opts);
  }

  // ===== Utility Methods =====

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

  /**
   * Close all client connections
   */
  close(): void {
    this.chaintracks.close();
  }

  // ===== WalletServices Interface (Required by wallet-toolbox) =====

  async getRawTx(txid: string, _useNext?: boolean): Promise<GetRawTxResult> {
    // This is a network-only call for the WalletServices interface.
    // Wallet should check storage before calling this.
    try {
      const beefBytes = await this.beef.getBeef(txid);
      const tx = Transaction.fromBEEF(Array.from(beefBytes));
      return { txid, name: "1sat-api", rawTx: Array.from(tx.toBinary()) };
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

  async getChainTracker(): Promise<ChaintracksClient> {
    return this.chaintracks;
  }

  async getHeaderForHeight(height: number): Promise<number[]> {
    return this.chaintracks.getHeaderBytes(height);
  }

  async getHeight(): Promise<number> {
    return this.chaintracks.currentHeight();
  }

  async getMerklePath(
    txid: string,
    _useNext?: boolean,
  ): Promise<GetMerklePathResult> {
    try {
      const proofBytes = await this.beef.getProof(txid);
      const merklePath = MerklePath.fromBinary(Array.from(proofBytes));
      return { name: "1sat-api", merklePath };
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
            txidResults: [{ txid: status.txid || txid, status: "success" }],
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
            txidResults: [{ txid, status: "error", data: status }],
          });
        } else {
          // Still processing - report as success since tx was accepted
          results.push({
            name: "1sat-api",
            status: "success",
            txidResults: [{ txid: status.txid || txid, status: "success" }],
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
          txidResults: [{ txid, status: "error" }],
        });
      }
    }

    return results;
  }

  async getBeefForTxid(txid: string): Promise<Beef> {
    const beefBytes = await this.beef.getBeef(txid);
    return Beef.fromBinary(Array.from(beefBytes));
  }

  hashOutputScript(script: string): string {
    const scriptBin = Utils.toArray(script, "hex");
    return Utils.toHex(Hash.hash256(scriptBin).reverse());
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

  // ===== WalletServices Interface (Not Yet Implemented) =====

  async getBsvExchangeRate(): Promise<number> {
    throw new Error("getBsvExchangeRate not yet implemented");
  }

  async getFiatExchangeRate(
    _currency: "USD" | "GBP" | "EUR",
    _base?: "USD" | "GBP" | "EUR",
  ): Promise<number> {
    throw new Error("getFiatExchangeRate not yet implemented");
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
}
