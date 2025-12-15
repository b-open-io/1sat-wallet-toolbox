import { Wallet, WalletStorageManager } from "@bsv/wallet-toolbox/mobile";
import type { Chain } from "@bsv/wallet-toolbox/mobile/out/src/sdk/types";
import {
  PrivateKey,
  KeyDeriver,
  Beef,
  Transaction,
  type InternalizeActionResult,
  type InternalizeOutput,
} from "@bsv/sdk";
import { ReadOnlySigner } from "./signers/ReadOnlySigner";
import { OneSatServices, type SyncOutput, type OneSatServicesEvents, type ParsedOutputInfo } from "./services/OneSatServices";
import { TransactionParser, type ParseResult } from "./indexers/TransactionParser";
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

/**
 * Result of ingestTransaction including parse details for debugging
 */
export interface IngestResult extends InternalizeActionResult {
  outputDetails: ParsedOutputInfo[];
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

    const services = new OneSatServices(args.chain, args.onesatUrl, args.storage);
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
   * @returns ParseResult with detailed output info
   */
  async parseTransaction(txid: string, isBroadcasted = true): Promise<ParseResult> {
    // Fetch the transaction
    const beef = await this.services.getBeefBytes(txid);
    const tx = Transaction.fromBEEF(beef);

    // Load source transactions for all inputs
    for (const input of tx.inputs) {
      if (!input.sourceTransaction) {
        input.sourceTransaction = Transaction.fromBEEF(
          await this.services.getBeefBytes(input.sourceTXID!)
        );
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
    isBroadcasted = true
  ): Promise<IngestResult> {
    // Convert to Transaction if needed

    for (const input of tx.inputs) {
      if (!input.sourceTransaction) {
        input.sourceTransaction = Transaction.fromBEEF(await this.services.getBeefBytes(input.sourceTXID!));
      }
    }
    // Run through indexers
    const parseResult = await this.parser.parse(tx, isBroadcasted);

    // Build InternalizeOutput array from parsed results
    // All synced outputs use basket insertion since we don't have derivation data
    const outputs: InternalizeOutput[] = parseResult.outputs.map((parsed) => {
      return {
        outputIndex: parsed.vout,
        protocol: "basket insertion" as const,
        insertionRemittance: {
          basket: parsed.basket || "default",
          tags: parsed.tags,
          customInstructions: parsed.customInstructions
            ? JSON.stringify(parsed.customInstructions)
            : undefined,
        },
      };
    });

    // Skip if no outputs to internalize
    if (outputs.length === 0) {
      return {
        accepted: true,
        outputDetails: parseResult.outputDetails,
        internalizedCount: 0,
      };
    }

    // Build BEEF for the transaction
    // const beef = new Beef();
    // beef.mergeTransaction(transaction);

    // Call parent's internalizeAction
    const result = await this.internalizeAction({
      tx: tx.toAtomicBEEF(false),
      outputs,
      description,
      labels,
    });

    return {
      ...result,
      outputDetails: parseResult.outputDetails,
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
    labels?: string[]
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
    this.services.syncAddress(address, async (addr: string, output: SyncOutput) => {
      const txid = output.outpoint.slice(0, 64);

      const hasTx = await this.storage.runAsStorageProvider(async (sp) => {
        const txs = await sp.findTransactions({ partial: { txid } });
        return txs.length > 0;
      });

      if (!hasTx) {
        if (output.spendTxid) {
          // Already spent and we don't have the creating tx - skip
          this.services.emit("sync:skipped", {
            address: addr,
            outpoint: output.outpoint,
            reason: "already spent, skipping historical output",
          });
          return;
        }
        // Unspent - fetch and ingest
        const beef = await this.services.getBeefBytes(txid);
        const tx = Transaction.fromBEEF(beef);
        if (tx) {
          const result = await this.ingestTransaction(tx, "1sat-sync");
          this.services.emit("sync:parsed", {
            address: addr,
            txid,
            outputs: result.outputDetails,
            internalizedCount: result.internalizedCount,
          });
        }
      } else if (output.spendTxid) {
        // We have the output, check if we have the spend
        const hasSpend = await this.storage.runAsStorageProvider(async (sp) => {
          const txs = await sp.findTransactions({ partial: { txid: output.spendTxid } });
          return txs.length > 0;
        });

        if (!hasSpend) {
          const beef = await this.services.getBeefBytes(output.spendTxid);
          const tx = Transaction.fromBEEF(beef);
          if (tx) {
            const result = await this.ingestTransaction(tx, "1sat-sync");
            this.services.emit("sync:parsed", {
              address: addr,
              txid: output.spendTxid,
              outputs: result.outputDetails,
              internalizedCount: result.internalizedCount,
            });
          }
        } else {
          this.services.emit("sync:skipped", {
            address: addr,
            outpoint: output.outpoint,
            reason: "already have spend tx in storage",
          });
        }
      } else {
        this.services.emit("sync:skipped", {
          address: addr,
          outpoint: output.outpoint,
          reason: "already have tx in storage",
        });
      }
    });
  }

  /**
   * Stop syncing a specific address.
   */
  stopSync(address: string): void {
    this.services.stopSync(address);
  }

  /**
   * Check if an address is currently syncing.
   */
  isSyncing(address: string): boolean {
    return this.services.isSyncing(address);
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
