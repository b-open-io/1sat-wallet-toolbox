import {
  Beef,
  type InternalizeActionResult,
  type InternalizeOutput,
  KeyDeriver,
  type PrivateKey,
  Transaction,
} from "@bsv/sdk";
import { Wallet, type WalletStorageManager } from "@bsv/wallet-toolbox/mobile";
import type { Chain } from "@bsv/wallet-toolbox/mobile/out/src/sdk/types";
import { Bsv21Indexer } from "./indexers/Bsv21Indexer";
import { CosignIndexer } from "./indexers/CosignIndexer";
import { FundIndexer } from "./indexers/FundIndexer";
import { InscriptionIndexer } from "./indexers/InscriptionIndexer";
import { LockIndexer } from "./indexers/LockIndexer";
import { MapIndexer } from "./indexers/MapIndexer";
import { OpNSIndexer } from "./indexers/OpNSIndexer";
import { OrdLockIndexer } from "./indexers/OrdLockIndexer";
import { OriginIndexer } from "./indexers/OriginIndexer";
import { SigmaIndexer } from "./indexers/SigmaIndexer";
import { TransactionParser } from "./indexers/TransactionParser";
import type { Indexer, ParseContext } from "./indexers/types";
import { OneSatServices, type SyncOutput } from "./services/OneSatServices";
import { ReadOnlySigner } from "./signers/ReadOnlySigner";

/**
 * Result of ingestTransaction including parse context for debugging
 */
export interface IngestResult extends InternalizeActionResult {
  parseContext: ParseContext;
  internalizedCount: number;
}

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

  /**
   * Indexers to use for parsing transactions.
   * If not provided, default indexers will be used.
   */
  indexers?: Indexer[];

  /**
   * Custom 1Sat API URL (default: based on chain - mainnet or testnet)
   */
  onesatUrl?: string;

  /**
   * Automatically start syncing all owner addresses on construction.
   */
  autoSync?: boolean;
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
  readonly services: OneSatServices;
  private owners: Set<string>;

  constructor(args: OneSatWalletArgs) {
    const isReadOnly = typeof args.rootKey === "string";

    const keyDeriver = isReadOnly
      ? new ReadOnlySigner(args.rootKey as string)
      : new KeyDeriver(args.rootKey as PrivateKey);

    const services = new OneSatServices(
      args.chain,
      args.onesatUrl,
      args.storage,
    );
    const network = args.chain === "main" ? "mainnet" : "testnet";
    const owners = args.owners || new Set<string>();

    super({
      chain: args.chain,
      keyDeriver,
      storage: args.storage,
      services,
    });

    this.isReadOnly = isReadOnly;
    this.services = services;
    this.owners = owners;

    // Use provided indexers or create defaults
    const indexers = args.indexers ?? [
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

    if (args.autoSync) {
      this.syncAll();
    }
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
   * Parse a transaction through indexers without internalizing.
   *
   * This is useful for debugging/testing to see what the indexers produce
   * without actually storing the transaction in the wallet.
   *
   * @param txid - Transaction ID to fetch and parse
   * @param isBroadcasted - Whether this transaction has been broadcast
   * @returns ParseContext with all indexer data
   */
  async parseTransaction(
    txid: string,
    isBroadcasted = true,
  ): Promise<ParseContext> {
    // Try to get raw tx from storage first, fall back to network BEEF
    const rawTxResult = await this.services.getRawTx(txid);
    let tx: Transaction;

    if (rawTxResult.rawTx) {
      tx = Transaction.fromBinary(rawTxResult.rawTx);
    } else {
      // Fall back to fetching BEEF from network
      const beef = await this.services.beef.getBeef(txid);
      tx = Transaction.fromBEEF(Array.from(beef));
    }

    // Load source transactions for all inputs
    for (const input of tx.inputs) {
      if (!input.sourceTransaction) {
        const sourceResult = await this.services.getRawTx(input.sourceTXID!);
        if (sourceResult.rawTx) {
          input.sourceTransaction = Transaction.fromBinary(sourceResult.rawTx);
        } else {
          // Fall back to BEEF from network
          const beefBytes = await this.services.beef.getBeef(input.sourceTXID!);
          input.sourceTransaction = Transaction.fromBEEF(Array.from(beefBytes));
        }
      }
    }

    // Run through indexers
    return this.parser.parse(tx, isBroadcasted);
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
   * @returns Result including parse details for all outputs
   */
  async ingestTransaction(
    tx: Transaction,
    description: string,
    labels?: string[],
    isBroadcasted = true,
  ): Promise<IngestResult> {
    // Load source transactions for inputs that don't have them
    for (const input of tx.inputs) {
      if (!input.sourceTransaction && input.sourceTXID) {
        const beefBytes = await this.services.beef.getBeef(input.sourceTXID);
        input.sourceTransaction = Transaction.fromBEEF(Array.from(beefBytes));
      }
    }

    // Run through indexers
    const ctx = await this.parser.parse(tx, isBroadcasted);

    // Build InternalizeOutput array from owned txos
    // Filter to only outputs owned by addresses in our set
    const outputs: InternalizeOutput[] = [];
    for (const txo of ctx.txos) {
      if (txo.owner && this.owners.has(txo.owner)) {
        // Collect tags from all indexer data
        const tags: string[] = [];
        for (const indexData of Object.values(txo.data)) {
          if (indexData.tags) {
            tags.push(...indexData.tags);
          }
        }
        outputs.push({
          outputIndex: txo.outpoint.vout,
          protocol: "basket insertion" as const,
          insertionRemittance: {
            basket: txo.basket || "default",
            tags,
          },
        });
      }
    }

    // Skip if no outputs to internalize
    if (outputs.length === 0) {
      return {
        accepted: true,
        parseContext: ctx,
        internalizedCount: 0,
      };
    }

    // Debug: try to parse and verify the BEEF we're about to send
    const beefBytes = tx.toAtomicBEEF(false);
    try {
      const testTx = Transaction.fromAtomicBEEF(beefBytes);
      console.log("BEEF validation passed, txid:", testTx.id("hex"));

      // Test verify with our chain tracker
      const ab = Beef.fromBinary(beefBytes);
      console.log("atomicTxid:", ab.atomicTxid);
      const chainTracker = await this.services.getChainTracker();
      const txValid = await ab.verify(chainTracker, false);
      console.log("verify result:", txValid);
      if (!txValid) {
        console.log("BEEF log:", ab.toLogString());
      }
    } catch (e) {
      console.error("BEEF validation failed:", e);
      console.log("Transaction inputs:", tx.inputs.length);
      for (let i = 0; i < tx.inputs.length; i++) {
        const input = tx.inputs[i];
        console.log(
          `  Input ${i}: sourceTXID=${input.sourceTXID}, hasSourceTx=${!!input.sourceTransaction}, hasMerklePath=${!!input.sourceTransaction?.merklePath}`,
        );
      }
      throw e;
    }

    // Call parent's internalizeAction
    const result = await this.internalizeAction({
      tx: beefBytes,
      outputs,
      description,
      labels,
    });

    return {
      ...result,
      parseContext: ctx,
      internalizedCount: outputs.length,
    };
  }

  /**
   * Broadcast a transaction and ingest it into the wallet if successful.
   *
   * @param tx - Transaction to broadcast
   * @param description - Human-readable description for the transaction
   * @param labels - Optional labels for the transaction
   * @returns The internalize result if successful
   * @throws Error if broadcast fails
   */
  async broadcast(
    tx: Transaction,
    description: string,
    labels?: string[],
  ): Promise<InternalizeActionResult> {
    const txid = tx.id("hex");
    const beef = new Beef();
    beef.mergeTransaction(tx);

    const results = await this.services.postBeef(beef, [txid]);
    const result = results[0];

    if (result.status !== "success") {
      const errorMsg = result.error?.message || "Broadcast failed";
      throw new Error(`Broadcast failed for ${txid}: ${errorMsg}`);
    }

    return this.ingestTransaction(tx, description, labels, true);
  }

  /**
   * Sync a single address from the 1Sat indexer using Server-Sent Events.
   * Runs in the background - use stopSync() or close() to stop.
   *
   * @param address - The address to sync
   */
  syncAddress(address: string): void {
    // Track txids seen during this sync session to avoid redundant DB lookups
    const seenTxids = new Set<string>();

    this.services.syncAddress(
      address,
      async (addr: string, output: SyncOutput) => {
        const txid = output.outpoint.substring(0, 64);

        // Check if we've already processed this txid in this session
        if (seenTxids.has(txid)) {
          this.services.emit("sync:skipped", {
            address: addr,
            outpoint: output.outpoint,
            reason: "already processed in this session",
          });
          // Still need to check spend txid
          if (output.spendTxid && !seenTxids.has(output.spendTxid)) {
            await this.processSpendTx(addr, output, seenTxids);
          }
          return;
        }

        const vout = Number.parseInt(output.outpoint.substring(65), 10);
        const hasOutput = await this.storage.runAsStorageProvider(
          async (sp) => {
            const outputs = await sp.findOutputs({ partial: { txid, vout } });
            return outputs.length > 0;
          },
        );

        if (!hasOutput) {
          if (output.spendTxid) {
            // Already spent and we don't have the output - skip
            seenTxids.add(txid);
            this.services.emit("sync:skipped", {
              address: addr,
              outpoint: output.outpoint,
              reason: "already spent, skipping historical output",
            });
            return;
          }
          // Unspent - fetch and ingest
          const beef = await this.services.beef.getBeef(txid);
          const tx = Transaction.fromBEEF(Array.from(beef));
          if (tx) {
            const result = await this.ingestTransaction(tx, "1sat-sync");
            seenTxids.add(txid);
            this.services.emit("sync:parsed", {
              address: addr,
              txid,
              parseContext: result.parseContext,
              internalizedCount: result.internalizedCount,
            });
          }
        } else {
          seenTxids.add(txid);
          if (output.spendTxid) {
            await this.processSpendTx(addr, output, seenTxids);
          } else {
            this.services.emit("sync:skipped", {
              address: addr,
              outpoint: output.outpoint,
              reason: "already have output in storage",
            });
          }
        }
      },
    );
  }

  /**
   * Process a spend transaction during sync
   */
  private async processSpendTx(
    addr: string,
    output: SyncOutput,
    seenTxids: Set<string>,
  ): Promise<void> {
    if (!output.spendTxid || seenTxids.has(output.spendTxid)) {
      return;
    }

    const hasSpend = await this.storage.runAsStorageProvider(async (sp) => {
      const txs = await sp.findTransactions({
        partial: { txid: output.spendTxid },
      });
      return txs.length > 0;
    });

    if (!hasSpend) {
      const beef = await this.services.beef.getBeef(output.spendTxid);
      const tx = Transaction.fromBEEF(Array.from(beef));
      if (tx) {
        const result = await this.ingestTransaction(tx, "1sat-sync");
        seenTxids.add(output.spendTxid);
        this.services.emit("sync:parsed", {
          address: addr,
          txid: output.spendTxid,
          parseContext: result.parseContext,
          internalizedCount: result.internalizedCount,
        });
      }
    } else {
      seenTxids.add(output.spendTxid); // Already in DB
      this.services.emit("sync:skipped", {
        address: addr,
        outpoint: output.outpoint,
        reason: "already have spend tx in storage",
      });
    }
  }

  /**
   * Stop syncing a specific address.
   */
  stopSync(address: string): void {
    this.services.stopSync(address);
  }

  /**
   * Close the wallet and cleanup all active sync connections.
   */
  close(): void {
    this.services.close();
  }

  /**
   * Start syncing all owner addresses.
   */
  syncAll(): void {
    for (const addr of this.owners) {
      this.syncAddress(addr);
    }
  }
}
