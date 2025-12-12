import { Wallet, WalletStorageManager } from "@bsv/wallet-toolbox";
import {
  PrivateKey,
  KeyDeriver,
  Beef,
  Transaction,
  type InternalizeActionResult,
  type InternalizeOutput,
} from "@bsv/sdk";
import { ReadOnlySigner } from "./signers/ReadOnlySigner";
import { OneSatServices } from "./services/OneSatServices";
import { TransactionParser } from "./indexers/TransactionParser";
import { FundIndexer } from "./indexers/FundIndexer";
import { LockIndexer } from "./indexers/LockIndexer";
import { InscriptionIndexer } from "./indexers/InscriptionIndexer";
import { SigmaIndexer } from "./indexers/SigmaIndexer";
import { MapIndexer } from "./indexers/MapIndexer";
import { OriginIndexer } from "./indexers/OriginIndexer";
import { Bsv21Indexer } from "./indexers/Bsv21Indexer";
import { OrdLockIndexer } from "./indexers/OrdLockIndexer";
import { OpNSIndexer } from "./indexers/OpNSIndexer";
import { CosignIndexer } from "./indexers/CosignIndexer";
import type { Indexer } from "./indexers/types";
import type { Chain } from "@bsv/wallet-toolbox/out/src/sdk/types";

interface SyncOutput {
  outpoint: string;
  score: number;
  spendTxid?: string;
}

interface SyncResponse {
  outputs: SyncOutput[];
  nextScore: number;
  done: boolean;
}

export interface SyncStartEvent {
  address: string;
  fromScore: number;
}

export interface SyncProgressEvent {
  address: string;
  processed: number;
  remaining: number;
  currentScore: number;
  done: boolean;
}

export interface SyncTxEvent {
  address: string;
  txid: string;
  type: "output" | "spend";
}

export interface SyncErrorEvent {
  address: string;
  error: Error;
}

export interface SyncCompleteEvent {
  address: string;
  processed: number;
  finalScore: number;
}

export interface OneSatWalletEvents {
  "sync:start": SyncStartEvent;
  "sync:progress": SyncProgressEvent;
  "sync:tx": SyncTxEvent;
  "sync:error": SyncErrorEvent;
  "sync:complete": SyncCompleteEvent;
}

type EventCallback<T> = (event: T) => void;

export interface OneSatWalletArgs {
  /**
   * Either a public key hex string (read-only mode) or a PrivateKey (full signing).
   */
  rootKey: string | PrivateKey;

  /**
   * The storage manager for the wallet.
   */
  storage: WalletStorageManager;

  /**
   * Network: 'main' or 'test'
   */
  chain: Chain;

  /**
   * Addresses owned by this wallet, used for filtering indexed outputs.
   */
  owners?: Set<string>;
}

/**
 * OneSatWallet extends the BRC-100 Wallet with 1Sat-specific indexing and services.
 *
 * Can be instantiated with either:
 * - A public key (read-only mode for queries)
 * - A private key (full signing capability)
 */
export class OneSatWallet extends Wallet {
  private readonly isReadOnly: boolean;
  private readonly parser: TransactionParser;
  private readonly oneSatServices: OneSatServices;
  private owners: Set<string>;
  private listeners: {
    [K in keyof OneSatWalletEvents]?: Set<EventCallback<OneSatWalletEvents[K]>>;
  } = {};

  constructor(args: OneSatWalletArgs) {
    const isReadOnly = typeof args.rootKey === "string";

    const keyDeriver = isReadOnly
      ? new ReadOnlySigner(args.rootKey as string)
      : new KeyDeriver(args.rootKey as PrivateKey);

    const services = new OneSatServices(args.chain);
    const network = args.chain === "main" ? "mainnet" : "testnet";
    const owners = args.owners || new Set<string>();

    super({
      chain: args.chain,
      keyDeriver,
      storage: args.storage,
      services,
    });

    this.isReadOnly = isReadOnly;
    this.oneSatServices = services;
    this.owners = owners;

    // Build indexers - order matters for dependency resolution
    const indexers: Indexer[] = [
      new FundIndexer(owners, network),
      new LockIndexer(owners, network),
      new InscriptionIndexer(owners, network),
      new SigmaIndexer(owners, network),
      new MapIndexer(owners, network),
      new OriginIndexer(owners, network, services),
      new Bsv21Indexer(owners, network, services),
      new OrdLockIndexer(owners, network),
      new OpNSIndexer(owners, network),
      new CosignIndexer(owners, network),
    ];

    this.parser = new TransactionParser(indexers, owners, services);
  }

  /**
   * Returns true if this wallet was created with only a public key.
   * Read-only wallets can query but not sign transactions.
   */
  get readOnly(): boolean {
    return this.isReadOnly;
  }

  /**
   * Add an address to the set of owned addresses.
   * Outputs to these addresses will be indexed.
   */
  addOwner(address: string): void {
    this.owners.add(address);
  }

  /**
   * Subscribe to wallet events.
   */
  on<K extends keyof OneSatWalletEvents>(
    event: K,
    callback: EventCallback<OneSatWalletEvents[K]>
  ): void {
    if (!this.listeners[event]) {
      this.listeners[event] = new Set() as typeof this.listeners[K];
    }
    this.listeners[event]!.add(callback as never);
  }

  /**
   * Unsubscribe from wallet events.
   */
  off<K extends keyof OneSatWalletEvents>(
    event: K,
    callback: EventCallback<OneSatWalletEvents[K]>
  ): void {
    this.listeners[event]?.delete(callback);
  }

  private emit<K extends keyof OneSatWalletEvents>(
    event: K,
    data: OneSatWalletEvents[K]
  ): void {
    for (const cb of this.listeners[event] ?? []) {
      cb(data);
    }
  }

  /**
   * Ingest a transaction by running it through indexers and then internalizing.
   *
   * This is the main entry point for adding external transactions to the wallet.
   * The indexers extract basket, tags, and custom instructions which are then
   * passed to the underlying wallet's internalizeAction.
   *
   * @param tx - Transaction or BEEF to ingest
   * @param description - Human-readable description
   * @param labels - Optional labels for the transaction
   * @param isBroadcasted - Whether this transaction has been broadcast (affects validation)
   */
  async ingestTransaction(
    tx: Transaction | number[],
    description: string,
    labels?: string[],
    isBroadcasted = true
  ): Promise<InternalizeActionResult> {
    // Convert to Transaction if needed
    const transaction =
      tx instanceof Transaction ? tx : Transaction.fromBinary(tx);

    // Run through indexers
    const parseResult = await this.parser.parse(transaction, isBroadcasted);

    // Build InternalizeOutput array from parsed results
    const outputs: InternalizeOutput[] = parseResult.outputs.map((parsed) => {
      if (parsed.basket === "") {
        // Empty basket = default wallet payment
        return {
          outputIndex: parsed.vout,
          protocol: "wallet payment" as const,
          paymentRemittance: {
            derivationPrefix: "",
            derivationSuffix: "",
            senderIdentityKey: this.identityKey,
          },
        };
      }
      // Non-empty basket = basket insertion
      return {
        outputIndex: parsed.vout,
        protocol: "basket insertion" as const,
        insertionRemittance: {
          basket: parsed.basket,
          tags: parsed.tags,
          customInstructions: parsed.customInstructions
            ? JSON.stringify(parsed.customInstructions)
            : undefined,
        },
      };
    });

    // Skip if no outputs to internalize
    if (outputs.length === 0) {
      return { accepted: true };
    }

    // Build BEEF for the transaction
    const beef = new Beef();
    beef.mergeTransaction(transaction);

    // Call parent's internalizeAction
    return this.internalizeAction({
      tx: beef.toBinaryAtomic(transaction.id("hex")),
      outputs,
      description,
      labels,
    });
  }

  /**
   * Sync a single address from the 1Sat indexer.
   * Fetches new outputs and spends, ingesting transactions as needed.
   *
   * @param address - The address to sync
   * @param limit - Max outputs per page (default 100)
   */
  async syncAddress(address: string, limit = 100): Promise<void> {
    const storageKey = `1sat:sync:${address}`;
    let from = Number(localStorage.getItem(storageKey) || "0");
    let totalProcessed = 0;

    this.emit("sync:start", { address, fromScore: from });

    try {
      while (true) {
        const url = `${this.oneSatServices.onesatBaseUrl}/v5/own/${address}/sync?from=${from}&limit=${limit}`;
        const resp = await fetch(url);
        if (!resp.ok) {
          throw new Error(`Sync failed: ${resp.statusText}`);
        }

        const data: SyncResponse = await resp.json();
        let pageProcessed = 0;

        for (const output of data.outputs) {
          const [txid] = output.outpoint.split("_");

          const hasTx = await this.storage.runAsStorageProvider(async (sp) => {
            const txs = await sp.findTransactions({ partial: { txid } });
            return txs.length > 0;
          });

          if (!hasTx) {
            if (output.spendTxid) {
              // Already spent and we don't have the creating tx - skip
              localStorage.setItem(storageKey, output.score.toString());
              pageProcessed++;
              totalProcessed++;
              continue;
            }
            // Unspent - fetch and ingest
            const beef = await this.oneSatServices.getBeefForTxid(txid);
            const tx = beef.findTxid(txid)?.tx;
            if (tx) {
              await this.ingestTransaction(tx, "sync");
              this.emit("sync:tx", { address, txid, type: "output" });
            }
          } else if (output.spendTxid) {
            // We have the output, check if we have the spend
            const hasSpend = await this.storage.runAsStorageProvider(async (sp) => {
              const txs = await sp.findTransactions({ partial: { txid: output.spendTxid } });
              return txs.length > 0;
            });

            if (!hasSpend) {
              const beef = await this.oneSatServices.getBeefForTxid(output.spendTxid);
              const tx = beef.findTxid(output.spendTxid)?.tx;
              if (tx) {
                await this.ingestTransaction(tx, "sync");
                this.emit("sync:tx", { address, txid: output.spendTxid, type: "spend" });
              }
            }
          }

          localStorage.setItem(storageKey, output.score.toString());
          pageProcessed++;
          totalProcessed++;

          this.emit("sync:progress", {
            address,
            processed: totalProcessed,
            remaining: data.outputs.length - pageProcessed,
            currentScore: output.score,
            done: data.done && pageProcessed === data.outputs.length,
          });
        }

        if (data.done) {
          break;
        }
        from = data.nextScore;
      }

      this.emit("sync:complete", {
        address,
        processed: totalProcessed,
        finalScore: from,
      });
    } catch (error) {
      this.emit("sync:error", {
        address,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
  }

  /**
   * Sync all owner addresses in parallel.
   */
  async syncAll(): Promise<void> {
    await Promise.all([...this.owners].map((addr) => this.syncAddress(addr)));
  }
}
