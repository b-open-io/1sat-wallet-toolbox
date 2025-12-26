import {
  Beef,
  KeyDeriver,
  type PrivateKey,
  Random,
  Transaction,
  Utils,
} from "@bsv/sdk";
import {
  type StorageProvider,
  Wallet,
  type WalletStorageManager,
} from "@bsv/wallet-toolbox/mobile";
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
import { Outpoint } from "./indexers/Outpoint";
import { SigmaIndexer } from "./indexers/SigmaIndexer";
import type { Indexer, ParseContext, Txo } from "./indexers/types";
import { OneSatServices, type SyncOutput } from "./services/OneSatServices";
import { ReadOnlySigner } from "./signers/ReadOnlySigner";
import type { SyncQueueItem, SyncQueueStorage } from "./sync/types";

/** Number of blocks to wait before considering a score "safe" from reorgs */
const REORG_SAFE_DEPTH = 6;

/** Default batch size for queue processing */
const DEFAULT_BATCH_SIZE = 20;

/**
 * Result of ingestTransaction including parse context for debugging
 */
export interface IngestResult {
  parseContext: ParseContext;
  internalizedCount: number;
}

/**
 * Events emitted by OneSatWallet during sync operations
 */
export interface OneSatWalletEvents {
  /** Sync started */
  "sync:start": { addresses: string[] };
  /** Sync progress update */
  "sync:progress": { pending: number; done: number; failed: number };
  /** Sync complete (queue empty and stream done) */
  "sync:complete": Record<string, never>;
  /** Sync error */
  "sync:error": { message: string };
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

  /**
   * Sync queue storage for background processing.
   * If provided, enables queue-based sync via sync() method.
   */
  syncQueue?: SyncQueueStorage;

  /**
   * Batch size for queue processing (default: 20).
   */
  syncBatchSize?: number;
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
  private readonly indexers: Indexer[];
  readonly services: OneSatServices;
  private owners: Set<string>;
  private listeners: {
    [K in keyof OneSatWalletEvents]?: Set<EventCallback<OneSatWalletEvents[K]>>;
  } = {};

  // Queue-based sync
  private syncQueue: SyncQueueStorage | null = null;
  private syncBatchSize: number = DEFAULT_BATCH_SIZE;
  private syncRunning = false;
  private syncStopRequested = false;
  private activeQueueSync: (() => void) | null = null;

  // Separate stream/processor state for testing
  private sseStreamActive = false;
  private sseUnsubscribe: (() => void) | null = null;
  private processorActive = false;
  private processorStopRequested = false;
  private streamDone = false;

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
    this.indexers = args.indexers ?? [
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

    // Queue-based sync settings
    this.syncQueue = args.syncQueue ?? null;
    this.syncBatchSize = args.syncBatchSize ?? DEFAULT_BATCH_SIZE;

    if (args.autoSync) {
      this.sync();
    }
  }

  /**
   * Returns true if this wallet was created with only a public key.
   * Read-only wallets can query but not sign transactions.
   */
  get readOnly(): boolean {
    return this.isReadOnly;
  }

  // ===== Event Emitter =====

  /**
   * Subscribe to wallet events
   */
  on<K extends keyof OneSatWalletEvents>(
    event: K,
    callback: EventCallback<OneSatWalletEvents[K]>,
  ): void {
    if (!this.listeners[event]) {
      (this.listeners as Record<K, Set<EventCallback<OneSatWalletEvents[K]>>>)[
        event
      ] = new Set();
    }
    (this.listeners[event] as Set<EventCallback<OneSatWalletEvents[K]>>).add(
      callback,
    );
  }

  /**
   * Unsubscribe from wallet events
   */
  off<K extends keyof OneSatWalletEvents>(
    event: K,
    callback: EventCallback<OneSatWalletEvents[K]>,
  ): void {
    (
      this.listeners[event] as
        | Set<EventCallback<OneSatWalletEvents[K]>>
        | undefined
    )?.delete(callback);
  }

  /**
   * Emit a wallet event
   */
  private emit<K extends keyof OneSatWalletEvents>(
    event: K,
    data: OneSatWalletEvents[K],
  ): void {
    const callbacks = this.listeners[event] as
      | Set<EventCallback<OneSatWalletEvents[K]>>
      | undefined;
    if (callbacks) {
      for (const cb of callbacks) {
        cb(data);
      }
    }
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
   * @param tx - Transaction or txid to parse
   * @param isBroadcasted - Whether this transaction has been broadcast
   * @returns ParseContext with all indexer data
   */
  async parseTransaction(
    txOrTxid: Transaction | string,
    isBroadcasted = true,
  ): Promise<ParseContext> {
    // Load transaction if needed
    const tx =
      typeof txOrTxid === "string"
        ? await this.loadTransaction(txOrTxid)
        : txOrTxid;

    // Hydrate source transactions for inputs
    await this.hydrateSourceTransactions(tx);

    // Build context
    const ctx = this.buildParseContext(tx);

    // Parse all inputs (build ctx.spends)
    await this.parseInputs(ctx);

    // Run parse on each output with each indexer
    for (const txo of ctx.txos) {
      await this.runIndexersOnTxo(txo);
    }

    // Run summarize on each indexer
    for (const indexer of this.indexers) {
      const summary = await indexer.summarize(ctx, isBroadcasted);
      if (summary) {
        ctx.summary[indexer.tag] = summary;
      }
    }

    return ctx;
  }

  /**
   * Parse a single output without full transaction context.
   * Runs all indexers' parse() methods but NOT summarize().
   *
   * @param output - The TransactionOutput to parse
   * @param outpoint - The outpoint identifying this output
   * @returns Txo with all indexer data populated
   */
  async parseOutput(
    output: Transaction["outputs"][0],
    outpoint: Outpoint,
  ): Promise<Txo> {
    const txo: Txo = {
      output,
      outpoint,
      data: {},
    };

    await this.runIndexersOnTxo(txo);
    return txo;
  }

  /**
   * Load and parse a single output by outpoint.
   * Loads the transaction, extracts the output, and runs indexers on it.
   *
   * @param outpoint - Outpoint string (txid_vout)
   * @returns Txo with all indexer data populated
   */
  async loadTxo(outpoint: string): Promise<Txo> {
    const op = new Outpoint(outpoint);
    const tx = await this.loadTransaction(op.txid);
    const output = tx.outputs[op.vout];
    if (!output) {
      throw new Error(`Output ${op.vout} not found in transaction ${op.txid}`);
    }
    return this.parseOutput(output, op);
  }

  /**
   * Run all indexers on a single Txo and populate its data/owner/basket
   */
  async runIndexersOnTxo(txo: Txo): Promise<void> {
    for (const indexer of this.indexers) {
      const result = await indexer.parse(txo);
      if (result) {
        txo.data[indexer.tag] = {
          data: result.data,
          tags: result.tags,
          content: result.content,
        };
        if (result.owner) {
          txo.owner = result.owner;
        }
        if (result.basket) {
          txo.basket = result.basket;
        }
      }
    }
  }

  /**
   * Parse all inputs - run indexers on source outputs to populate ctx.spends
   */
  private async parseInputs(ctx: ParseContext): Promise<void> {
    for (const input of ctx.tx.inputs) {
      if (!input.sourceTransaction) continue;

      const sourceOutput =
        input.sourceTransaction.outputs[input.sourceOutputIndex];
      if (!sourceOutput) continue;

      const sourceTxid = input.sourceTransaction.id("hex");
      const sourceVout = input.sourceOutputIndex;

      // Create Txo for the spent output
      const spendTxo: Txo = {
        output: sourceOutput,
        outpoint: new Outpoint(sourceTxid, sourceVout),
        data: {},
      };

      // Run all indexers on the spent output
      await this.runIndexersOnTxo(spendTxo);

      // Add to spends
      ctx.spends.push(spendTxo);
    }
  }

  /**
   * Load a transaction by txid.
   * Checks storage first, falls back to beef service.
   *
   * @param txid - Transaction ID to load
   * @returns Transaction (without source transactions hydrated)
   */
  async loadTransaction(txid: string): Promise<Transaction> {
    // Check storage first
    const userId = await this.storage.getUserId();
    const existingTx = await this.storage.runAsStorageProvider(async (sp) => {
      const txs = await sp.findTransactions({ partial: { userId, txid } });
      return txs.length > 0 ? txs[0] : null;
    });

    if (existingTx?.rawTx) {
      return Transaction.fromBinary(existingTx.rawTx);
    }

    // Fall back to network
    const beefBytes = await this.services.beef.getBeef(txid);
    return Transaction.fromBEEF(Array.from(beefBytes));
  }

  /**
   * Load and attach source transactions for all inputs (1 level deep).
   * Modifies the transaction in place.
   */
  async hydrateSourceTransactions(tx: Transaction): Promise<void> {
    const loaded = new Map<string, Transaction>();

    for (const input of tx.inputs) {
      if (!input.sourceTransaction && input.sourceTXID) {
        if (!loaded.has(input.sourceTXID)) {
          loaded.set(
            input.sourceTXID,
            await this.loadTransaction(input.sourceTXID),
          );
        }
        input.sourceTransaction = loaded.get(input.sourceTXID);
      }
    }
  }

  /**
   * Build minimal parse context from transaction
   */
  buildParseContext(tx: Transaction): ParseContext {
    const txid = tx.id("hex");
    return {
      tx,
      txid,
      txos: tx.outputs.map((output, vout) => ({
        output,
        outpoint: new Outpoint(txid, vout),
        data: {},
      })),
      spends: [],
      summary: {},
      indexers: this.indexers,
    };
  }

  /**
   * Ingest a transaction by running it through indexers and writing directly to storage.
   *
   * This is the main entry point for adding external transactions to the wallet.
   * The indexers extract basket, tags, and custom instructions which are then
   * written directly to the wallet's storage.
   *
   * Unlike internalizeAction, this method also marks any wallet outputs that are
   * consumed as inputs in the transaction as spent (spentBy, spendable: false).
   *
   * @param tx - Transaction to ingest
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
    // Run through indexers (parseTransaction handles loading source txs)
    const ctx = await this.parseTransaction(tx, isBroadcasted);
    const txid = tx.id("hex");

    // Collect owned outputs
    const ownedTxos = ctx.txos.filter(
      (txo) => txo.owner && this.owners.has(txo.owner),
    );

    // Get userId from storage manager
    const userId = await this.storage.getUserId();

    // Write directly to storage within a transaction
    const internalizedCount = await this.storage.runAsStorageProvider(
      async (sp: StorageProvider) => {
        return await sp.transaction(async (trx) => {
          // Check if transaction already exists
          const existingTxs = await sp.findTransactions({
            partial: { userId, txid },
            trx,
          });

          let transactionId: number;
          let isNewTransaction = false;

          if (existingTxs.length > 0) {
            // Transaction already exists, use its ID
            transactionId = existingTxs[0].transactionId;
          } else {
            // Determine if this is an outgoing transaction (we're spending our own outputs)
            // by checking if any inputs spend our outputs
            let isOutgoing = false;
            let satoshisSpent = 0;

            for (const input of tx.inputs) {
              if (input.sourceTXID) {
                const spentOutputs = await sp.findOutputs({
                  partial: {
                    userId,
                    txid: input.sourceTXID,
                    vout: input.sourceOutputIndex,
                  },
                  trx,
                });
                if (spentOutputs.length > 0) {
                  isOutgoing = true;
                  satoshisSpent += spentOutputs[0].satoshis;
                }
              }
            }

            // Calculate satoshis received
            const satoshisReceived = ownedTxos.reduce(
              (sum, txo) => sum + (txo.output.satoshis || 0),
              0,
            );

            // Net satoshis: positive if receiving, negative if spending
            const satoshis = satoshisReceived - satoshisSpent;

            // Create transaction record
            const now = new Date();
            const reference = Utils.toBase64(Random(12));

            const newTx = {
              created_at: now,
              updated_at: now,
              transactionId: 0,
              userId,
              status: isBroadcasted
                ? ("completed" as const)
                : ("unproven" as const),
              reference,
              isOutgoing,
              satoshis,
              description,
              version: tx.version,
              lockTime: tx.lockTime,
              txid,
              rawTx: Array.from(tx.toBinary()),
            };

            transactionId = await sp.insertTransaction(newTx, trx);
            isNewTransaction = true;

            // Persist source transactions (inputs) so we don't have to fetch them again
            const txQueue = [...tx.inputs];
            for (const input of txQueue) {
              if (!input.sourceTransaction) continue;
              const sourceTxid = input.sourceTransaction.id("hex");

              // Check if already exists
              const existing = await sp.findTransactions({
                partial: { userId, txid: sourceTxid },
                trx,
              });
              if (existing.length > 0) continue;

              // Insert source transaction
              const sourceNow = new Date();
              const sourceRef = Utils.toBase64(Random(12));
              await sp.insertTransaction(
                {
                  created_at: sourceNow,
                  updated_at: sourceNow,
                  transactionId: 0,
                  userId,
                  status: "completed" as const,
                  reference: sourceRef,
                  isOutgoing: false,
                  satoshis: 0,
                  description: "source transaction",
                  version: input.sourceTransaction.version,
                  lockTime: input.sourceTransaction.lockTime,
                  txid: sourceTxid,
                  rawTx: Array.from(input.sourceTransaction.toBinary()),
                },
                trx,
              );

              // Add source transaction's inputs to queue
              txQueue.push(...input.sourceTransaction.inputs);
            }

            // Add labels
            for (const label of labels || []) {
              const txLabel = await sp.findOrInsertTxLabel(userId, label, trx);
              if (txLabel.txLabelId) {
                await sp.findOrInsertTxLabelMap(
                  transactionId,
                  txLabel.txLabelId,
                  trx,
                );
              }
            }
          }

          // Mark inputs as spent (only for new transactions)
          if (isNewTransaction) {
            for (const input of tx.inputs) {
              if (input.sourceTXID) {
                const spentOutputs = await sp.findOutputs({
                  partial: {
                    userId,
                    txid: input.sourceTXID,
                    vout: input.sourceOutputIndex,
                  },
                  trx,
                });
                if (spentOutputs.length > 0) {
                  const output = spentOutputs[0];
                  // Mark as spent
                  if (output.outputId) {
                    await sp.updateOutput(
                      output.outputId,
                      {
                        spendable: false,
                        spentBy: transactionId,
                      },
                      trx,
                    );
                  }
                }
              }
            }
          }

          // Create output records for owned outputs
          let outputsCreated = 0;
          for (const txo of ownedTxos) {
            // Check if output already exists
            const existingOutputs = await sp.findOutputs({
              partial: { userId, txid, vout: txo.outpoint.vout },
              trx,
            });

            if (existingOutputs.length > 0) {
              // Output already exists, skip
              continue;
            }

            // Collect tags and content from all indexer data
            const tags: string[] = [];
            let content: string | undefined;
            if (txo.owner) {
              tags.push(`own:${txo.owner}`);
            }
            for (const indexData of Object.values(txo.data)) {
              if (indexData.tags) {
                tags.push(...indexData.tags);
              }
              // Use first non-empty content found
              if (!content && indexData.content) {
                content = indexData.content;
              }
            }

            // Get or create basket
            const basketName = txo.basket || "default";
            const basket = await sp.findOrInsertOutputBasket(
              userId,
              basketName,
              trx,
            );

            // Create output record
            const now = new Date();
            const newOutput = {
              created_at: now,
              updated_at: now,
              outputId: 0,
              userId,
              transactionId,
              basketId: basket.basketId,
              spendable: true,
              change: basketName === "default",
              outputDescription: "",
              vout: txo.outpoint.vout,
              satoshis: txo.output.satoshis || 0,
              providedBy: "you" as const,
              purpose: basketName === "default" ? "change" : "",
              type: "custom",
              txid,
              lockingScript: Array.from(txo.output.lockingScript.toBinary()),
              spentBy: undefined,
              customInstructions: content?.substring(0, 1000),
            };

            const outputId = await sp.insertOutput(newOutput, trx);

            // Add tags to output
            for (const tag of tags) {
              const outputTag = await sp.findOrInsertOutputTag(
                userId,
                tag,
                trx,
              );
              if (outputTag.outputTagId) {
                await sp.findOrInsertOutputTagMap(
                  outputId,
                  outputTag.outputTagId,
                  trx,
                );
              }
            }

            outputsCreated++;
          }

          return outputsCreated;
        });
      },
    );

    return { parseContext: ctx, internalizedCount };
  }

  /**
   * Broadcast a transaction and ingest it into the wallet if successful.
   *
   * @param tx - Transaction to broadcast
   * @param description - Human-readable description for the transaction
   * @param labels - Optional labels for the transaction
   * @returns The ingest result if successful
   * @throws Error if broadcast fails
   */
  async broadcast(
    tx: Transaction,
    description: string,
    labels?: string[],
  ): Promise<IngestResult> {
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

  // ===== Queue-Based Sync =====

  /**
   * Start queue-based sync for all owner addresses.
   * Requires syncQueue to be provided in constructor args.
   *
   * This method:
   * 1. Opens SSE stream and enqueues outputs
   * 2. Processes queue in batches using Promise.all()
   * 3. Continues until queue is empty and stream is done
   */
  async sync(): Promise<void> {
    if (!this.syncQueue) {
      throw new Error(
        "syncQueue not provided - provide syncQueue in constructor",
      );
    }

    if (this.syncRunning) {
      return;
    }

    const addresses = Array.from(this.owners);
    if (addresses.length === 0) {
      return;
    }

    this.syncRunning = true;
    this.syncStopRequested = false;

    // Reset any items stuck in "processing" from a previous crashed session
    await this.syncQueue.resetProcessing();

    // Get last queued score from queue state
    const state = await this.syncQueue.getState();
    const fromScore = state.lastQueuedScore;

    // Fetch current height once for reorg protection checks
    const currentHeight = await this.services.getHeight();

    this.emit("sync:start", { addresses });

    // Start SSE stream
    let streamDone = false;
    const unsubscribe = this.services.owner.syncMulti(
      addresses,
      async (output) => {
        await this.handleSyncOutput(output, currentHeight);
      },
      fromScore,
      () => {
        streamDone = true;
      },
      (error) => {
        streamDone = true;
        this.emit("sync:error", { message: error.message });
      },
    );

    this.activeQueueSync = unsubscribe;

    // Start processing loop
    await this.processQueueLoop(streamDone, () => streamDone);

    this.syncRunning = false;
    this.activeQueueSync = null;
  }

  /**
   * Handle a single output from the SSE stream.
   * Enqueues to the sync queue and updates lastQueuedScore with reorg protection.
   */
  private async handleSyncOutput(
    output: SyncOutput,
    currentHeight: number,
  ): Promise<void> {
    if (!this.syncQueue) return;

    // Enqueue the output
    await this.syncQueue.enqueue([
      {
        outpoint: output.outpoint,
        score: output.score,
        spendTxid: output.spendTxid,
      },
    ]);

    // Update lastQueuedScore with reorg protection
    const blockHeight = Math.floor(output.score);
    if (blockHeight <= currentHeight - REORG_SAFE_DEPTH) {
      await this.syncQueue.setState({
        lastQueuedScore: output.score,
        lastSyncedAt: Date.now(),
      });
    }
  }

  /**
   * Process queue in batches until empty or stopped.
   */
  private async processQueueLoop(
    _streamDone: boolean,
    isStreamDone: () => boolean,
  ): Promise<void> {
    if (!this.syncQueue) return;

    while (!this.syncStopRequested) {
      // claim() returns items already grouped by txid, all marked as "processing"
      const byTxid = await this.syncQueue.claim(this.syncBatchSize);

      if (byTxid.size === 0) {
        if (isStreamDone()) {
          // Stream done and queue empty - sync complete
          this.emit("sync:complete", {});
          break;
        }
        // Queue empty but stream still running - wait a bit
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }

      // Process each txid in parallel
      await Promise.all(
        Array.from(byTxid.entries()).map(([txid, txidItems]) =>
          this.processTxid(txid, txidItems),
        ),
      );

      // Emit progress
      const stats = await this.syncQueue.getStats();
      this.emit("sync:progress", {
        pending: stats.pending,
        done: stats.done,
        failed: stats.failed,
      });
    }
  }

  /**
   * Group queue items by txid.
   * @deprecated - claim() now returns items already grouped
   */
  private groupItemsByTxid(
    items: SyncQueueItem[],
  ): Map<string, SyncQueueItem[]> {
    const byTxid = new Map<string, SyncQueueItem[]>();
    for (const item of items) {
      const txid = item.outpoint.substring(0, 64);
      const existing = byTxid.get(txid);
      if (existing) {
        existing.push(item);
      } else {
        byTxid.set(txid, [item]);
      }
    }
    return byTxid;
  }

  /**
   * Process a single txid - ingest transaction and complete queue items.
   * Items are already marked as "processing" by claim().
   */
  private async processTxid(
    txid: string,
    items: SyncQueueItem[],
  ): Promise<void> {
    if (!this.syncQueue) return;

    try {
      const itemIds = items.map((i) => i.id);

      // Build spend map: vout -> spendTxid
      const spendMap = new Map<number, string>();
      for (const item of items) {
        if (item.spendTxid) {
          const vout = Number.parseInt(item.outpoint.substring(65), 10);
          spendMap.set(vout, item.spendTxid);
        }
      }

      // Check if this is purely a spend-only batch (all items have spendTxid, no new outputs)
      const hasUnspentCreation = items.some((item) => !item.spendTxid);

      if (hasUnspentCreation) {
        // Need to ingest the transaction
        await this.ingestWithSpendInfo(txid, spendMap);
      } else {
        // All items are spends - just mark outputs as spent
        await this.markOutputsSpent(items);
      }

      // Complete all items
      await this.syncQueue.completeMany(itemIds);
    } catch (error) {
      this.emit("sync:error", {
        message: error instanceof Error ? error.message : String(error),
      });

      // Mark items as failed
      for (const item of items) {
        await this.syncQueue.fail(item.id, String(error));
      }
    }
  }

  /**
   * Ingest a transaction with knowledge of which outputs are already spent.
   */
  private async ingestWithSpendInfo(
    txid: string,
    spendMap: Map<number, string>,
  ): Promise<void> {
    // Load and ingest the transaction
    const tx = await this.loadTransaction(txid);
    const result = await this.ingestTransaction(tx, "1sat-sync");

    // Mark any outputs that we know are spent
    if (spendMap.size > 0) {
      const userId = await this.storage.getUserId();
      await this.storage.runAsStorageProvider(async (sp) => {
        await sp.transaction(async (trx) => {
          for (const [vout] of spendMap) {
            const outputs = await sp.findOutputs({
              partial: { userId, txid, vout },
              trx,
            });
            if (outputs.length > 0 && outputs[0].spendable) {
              const output = outputs[0];
              if (output.outputId) {
                await sp.updateOutput(output.outputId, { spendable: false }, trx);
              }
            }
          }
        });
      });
    }
  }

  /**
   * Mark outputs as spent for spend-only queue items.
   */
  private async markOutputsSpent(items: SyncQueueItem[]): Promise<void> {
    const userId = await this.storage.getUserId();

    await this.storage.runAsStorageProvider(async (sp) => {
      await sp.transaction(async (trx) => {
        for (const item of items) {
          if (!item.spendTxid) continue;

          const txid = item.outpoint.substring(0, 64);
          const vout = Number.parseInt(item.outpoint.substring(65), 10);

          const outputs = await sp.findOutputs({
            partial: { userId, txid, vout },
            trx,
          });

          if (outputs.length > 0 && outputs[0].spendable && outputs[0].outputId) {
            await sp.updateOutput(outputs[0].outputId, { spendable: false }, trx);
          }
        }
      });
    });
  }

  /**
   * Stop the sync.
   */
  stopSync(): void {
    this.syncStopRequested = true;
    if (this.activeQueueSync) {
      this.activeQueueSync();
      this.activeQueueSync = null;
    }
    // Also stop individual components
    this.stopStream();
    this.stopProcessor();
  }

  /**
   * Close the wallet and cleanup all sync connections.
   */
  close(): void {
    this.stopSync();
    this.services.close();
  }

  /**
   * Check if sync is currently running.
   */
  isSyncing(): boolean {
    return this.syncRunning;
  }

  /**
   * Get the sync queue instance (if provided).
   */
  getQueue(): SyncQueueStorage | null {
    return this.syncQueue;
  }

  // ===== Separate Stream/Processor Controls (for testing) =====

  /**
   * Start only the SSE stream, enqueueing outputs without processing.
   * Useful for testing to observe queue buildup.
   */
  async startStream(): Promise<void> {
    if (!this.syncQueue) {
      throw new Error("syncQueue not provided");
    }
    if (this.sseStreamActive) {
      return;
    }

    const addresses = Array.from(this.owners);
    if (addresses.length === 0) {
      return;
    }

    const state = await this.syncQueue.getState();
    const fromScore = state.lastQueuedScore;

    // Fetch current height once for reorg protection checks
    const currentHeight = await this.services.getHeight();

    this.sseStreamActive = true;
    this.streamDone = false;

    this.emit("sync:start", { addresses });

    this.sseUnsubscribe = this.services.owner.syncMulti(
      addresses,
      async (output) => {
        await this.handleSyncOutput(output, currentHeight);
      },
      fromScore,
      () => {
        this.streamDone = true;
        this.sseStreamActive = false;
      },
      (error) => {
        this.streamDone = true;
        this.sseStreamActive = false;
        this.emit("sync:error", { message: error.message });
      },
    );
  }

  /**
   * Stop the SSE stream.
   */
  stopStream(): void {
    if (this.sseUnsubscribe) {
      this.sseUnsubscribe();
      this.sseUnsubscribe = null;
    }
    this.sseStreamActive = false;
  }

  /**
   * Check if SSE stream is active.
   */
  isStreamActive(): boolean {
    return this.sseStreamActive;
  }

  /**
   * Check if SSE stream has completed.
   */
  isStreamDone(): boolean {
    return this.streamDone;
  }

  /**
   * Start only the queue processor, without starting a new SSE stream.
   * Useful for testing to process queued items independently.
   */
  async startProcessor(): Promise<void> {
    if (!this.syncQueue) {
      throw new Error("syncQueue not provided");
    }
    if (this.processorActive) {
      return;
    }

    this.processorActive = true;
    this.processorStopRequested = false;

    // Reset any items stuck in "processing" from a previous crashed session
    await this.syncQueue.resetProcessing();

    while (!this.processorStopRequested) {
      // claim() returns items already grouped by txid, all marked as "processing"
      const byTxid = await this.syncQueue.claim(this.syncBatchSize);

      if (byTxid.size === 0) {
        // Queue empty - wait a bit and check again
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }

      // Process each txid in parallel
      await Promise.all(
        Array.from(byTxid.entries()).map(([txid, txidItems]) =>
          this.processTxid(txid, txidItems),
        ),
      );

      // Emit progress
      const stats = await this.syncQueue.getStats();
      this.emit("sync:progress", {
        pending: stats.pending,
        done: stats.done,
        failed: stats.failed,
      });
    }

    this.processorActive = false;
  }

  /**
   * Stop the queue processor.
   */
  stopProcessor(): void {
    this.processorStopRequested = true;
  }

  /**
   * Check if queue processor is active.
   */
  isProcessorActive(): boolean {
    return this.processorActive;
  }
}
