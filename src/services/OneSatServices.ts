import { Beef, ChainTracker, Hash, MerklePath, Transaction, Utils } from "@bsv/sdk";
import type {
  WalletServices,
  GetRawTxResult,
  GetMerklePathResult,
  PostBeefResult,
  GetUtxoStatusResult,
  GetStatusForTxidsResult,
  GetScriptHashHistoryResult,
  BlockHeader,
  GetUtxoStatusOutputFormat,
  ServicesCallHistory,
  ServiceCallHistory,
} from "@bsv/wallet-toolbox/out/src/sdk/WalletServices.interfaces";
import type { Chain } from "@bsv/wallet-toolbox/out/src/sdk/types";
import { WalletError } from "@bsv/wallet-toolbox/out/src/sdk/WalletError";
import type { TableOutput } from "@bsv/wallet-toolbox/out/src/storage/schema/tables/TableOutput";
import type { Bsv21TransactionData } from "../indexers/types";

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
 * WalletServices implementation for 1Sat ecosystem.
 *
 * Data sources:
 * - ordfs-server - Block headers, merkle proofs, raw transactions
 * - OneSat API - Transaction broadcasting
 */
export class OneSatServices implements WalletServices {
  chain: Chain;
  private ordfsBaseUrl: string;
  readonly onesatBaseUrl: string;

  constructor(chain: Chain, ordfsUrl?: string) {
    this.chain = chain;
    this.ordfsBaseUrl = ordfsUrl || "https://ordfs.network";
    this.onesatBaseUrl =
      chain === "main"
        ? "https://ordinals.1sat.app"
        : "https://testnet.ordinals.gorillapool.io";
  }

  async getChainTracker(): Promise<ChainTracker> {
    throw new Error("ChainTracker not yet implemented");
  }

  async getHeaderForHeight(height: number): Promise<number[]> {
    const resp = await fetch(`${this.ordfsBaseUrl}/v2/block/${height}`);
    if (!resp.ok) {
      throw new Error(`Failed to fetch header for height ${height}: ${resp.statusText}`);
    }
    const arrayBuffer = await resp.arrayBuffer();
    return Array.from(new Uint8Array(arrayBuffer));
  }

  async getHeight(): Promise<number> {
    const resp = await fetch(`${this.ordfsBaseUrl}/v2/chain/height`);
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
    _base?: "USD" | "GBP" | "EUR"
  ): Promise<number> {
    throw new Error("Fiat exchange rate not yet implemented");
  }

  async getRawTx(txid: string, _useNext?: boolean): Promise<GetRawTxResult> {
    try {
      const resp = await fetch(`${this.ordfsBaseUrl}/v2/tx/${txid}`);
      if (!resp.ok) {
        return {
          txid,
          error: new WalletError("FETCH_FAILED", `Failed to fetch transaction: ${resp.statusText}`),
        };
      }
      const arrayBuffer = await resp.arrayBuffer();
      const rawTx = Array.from(new Uint8Array(arrayBuffer));
      return {
        txid,
        name: "ordfs-server",
        rawTx,
      };
    } catch (error) {
      return {
        txid,
        error: new WalletError(
          "NETWORK_ERROR",
          error instanceof Error ? error.message : "Unknown error"
        ),
      };
    }
  }

  async getMerklePath(txid: string, _useNext?: boolean): Promise<GetMerklePathResult> {
    try {
      const resp = await fetch(`${this.ordfsBaseUrl}/v2/tx/${txid}/proof`);
      if (!resp.ok) {
        return {
          name: "ordfs-server",
          error: new WalletError("FETCH_FAILED", `Failed to fetch merkle proof: ${resp.statusText}`),
        };
      }
      const arrayBuffer = await resp.arrayBuffer();
      const proofBytes = Array.from(new Uint8Array(arrayBuffer));
      const merklePath = MerklePath.fromBinary(proofBytes);

      return {
        name: "ordfs-server",
        merklePath,
      };
    } catch (error) {
      return {
        name: "ordfs-server",
        error: new WalletError(
          "NETWORK_ERROR",
          error instanceof Error ? error.message : "Unknown error"
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
            name: "onesat-api",
            status: "error",
            error: new WalletError("TX_NOT_FOUND", `Transaction ${txid} not found in BEEF`),
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

        const resp = await fetch(`${this.onesatBaseUrl}/v5/tx`, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
          },
          body: new Uint8Array(beefTx.tx.toBinary()),
        });

        const body = await resp.json();

        if (resp.status === 200) {
          results.push({
            name: "onesat-api",
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
            name: "onesat-api",
            status: "error",
            error: new WalletError(resp.status.toString(), body.error || resp.statusText),
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
            error instanceof Error ? error.message : "Unknown error"
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

  async getStatusForTxids(_txids: string[], _useNext?: boolean): Promise<GetStatusForTxidsResult> {
    throw new Error("getStatusForTxids not yet implemented");
  }

  async isUtxo(_output: TableOutput): Promise<boolean> {
    throw new Error("isUtxo not yet implemented");
  }

  async getUtxoStatus(
    _output: string,
    _outputFormat?: GetUtxoStatusOutputFormat,
    _outpoint?: string,
    _useNext?: boolean
  ): Promise<GetUtxoStatusResult> {
    throw new Error("getUtxoStatus not yet implemented");
  }

  async getScriptHashHistory(_hash: string, _useNext?: boolean): Promise<GetScriptHashHistoryResult> {
    throw new Error("getScriptHashHistory not yet implemented");
  }

  async hashToHeader(_hash: string): Promise<BlockHeader> {
    throw new Error("hashToHeader not yet implemented");
  }

  async nLockTimeIsFinal(_txOrLockTime: string | number[] | Transaction | number): Promise<boolean> {
    throw new Error("nLockTimeIsFinal not yet implemented");
  }

  async getBeefForTxid(txid: string): Promise<Beef> {
    const resp = await fetch(`${this.ordfsBaseUrl}/v2/tx/${txid}/beef`);
    if (!resp.ok) {
      throw new Error(`Failed to fetch BEEF for txid ${txid}: ${resp.statusText}`);
    }
    const arrayBuffer = await resp.arrayBuffer();
    const beefBytes = Array.from(new Uint8Array(arrayBuffer));
    return Beef.fromBinary(beefBytes);
  }

  /**
   * Get OrdFS metadata for an outpoint
   */
  async getOrdfsMetadata(outpoint: string): Promise<OrdfsMetadata> {
    const resp = await fetch(
      `${this.ordfsBaseUrl}/v2/metadata/${outpoint}?map=true&parent=true`
    );
    if (!resp.ok) throw new Error(`Failed to fetch OrdFS metadata: ${resp.statusText}`);
    return await resp.json();
  }

  /**
   * Get BSV21 token data by txid from the overlay
   */
  async getBsv21TokenByTxid(
    _tokenId: string,
    txid: string
  ): Promise<Bsv21TransactionData | undefined> {
    try {
      const resp = await fetch(`${this.onesatBaseUrl}/api/bsv21/tx/${txid}`);
      if (!resp.ok) return undefined;
      return await resp.json();
    } catch {
      return undefined;
    }
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
      getScriptHashHistory: { ...emptyHistory, serviceName: "getScriptHashHistory" },
      updateFiatExchangeRates: { ...emptyHistory, serviceName: "updateFiatExchangeRates" },
    };
  }
}
