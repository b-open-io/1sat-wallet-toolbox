import { Transaction } from "@bsv/sdk";
import type { OneSatServices } from "../services/OneSatServices";
import { Outpoint } from "./Outpoint";
import type { Indexer, ParseContext, Txo } from "./types";

/**
 * TransactionParser runs indexers over a transaction to extract
 * basket, tags, and custom instructions for wallet-toolbox.
 *
 * This is a stripped-down version of TxoStore.ingest() that only
 * handles parsing without SPV verification or storage.
 */
export class TransactionParser {
  constructor(
    public indexers: Indexer[],
    public owners: Set<string>,
    private services: OneSatServices,
  ) {}

  /**
   * Parse a transaction and return the ParseContext with all indexer data
   */
  async parse(tx: Transaction, isBroadcasted: boolean): Promise<ParseContext> {
    const ctx = this.buildContext(tx);

    // Load source transactions for all inputs
    await this.loadSourceTransactions(tx);

    // Parse all inputs (build ctx.spends)
    await this.parseInputs(ctx);

    // Run parse on each output with each indexer
    for (const [vout] of tx.outputs.entries()) {
      for (const indexer of this.indexers) {
        const indexData = await indexer.parse(ctx, vout, isBroadcasted);
        if (indexData) {
          ctx.txos[vout].data[indexer.tag] = indexData;
        }
      }
    }

    // Run summerize on each indexer
    for (const indexer of this.indexers) {
      const summary = await indexer.summerize(ctx, isBroadcasted);
      if (summary) {
        ctx.summary[indexer.tag] = summary;
      }
    }

    return ctx;
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

      // Build txos array for ALL outputs of the source transaction
      // This ensures indexers can access ctx.txos[vout] at the correct index
      const sourceTxos: Txo[] = input.sourceTransaction.outputs.map(
        (output, vout) => ({
          satoshis: BigInt(output.satoshis || 0),
          script: output.lockingScript.toBinary(),
          data: {},
          outpoint: new Outpoint(sourceTxid, vout),
        }),
      );

      // Build context for parsing the source transaction
      const sourceCtx: ParseContext = {
        tx: input.sourceTransaction,
        txid: sourceTxid,
        txos: sourceTxos,
        spends: [],
        summary: {},
        indexers: ctx.indexers,
      };

      // Run all indexers on the specific source output we're spending
      for (const indexer of this.indexers) {
        const indexData = await indexer.parse(sourceCtx, sourceVout, false);
        if (indexData) {
          sourceTxos[sourceVout].data[indexer.tag] = indexData;
        }
      }

      // Add the spent output to ctx.spends
      ctx.spends.push(sourceTxos[sourceVout]);
    }
  }

  /**
   * Load source transactions for all inputs and set them on tx.inputs[].sourceTransaction
   */
  private async loadSourceTransactions(tx: Transaction): Promise<void> {
    for (const input of tx.inputs) {
      if (input.sourceTransaction) {
        continue; // Already loaded
      }

      const txid = input.sourceTXID;
      if (!txid) {
        throw new Error("Input missing source transaction ID");
      }

      // Load from services
      let rawTx: number[] | undefined;
      const result = await this.services.getRawTx(txid);
      if (result.rawTx) {
        rawTx = result.rawTx;
      }

      if (rawTx) {
        input.sourceTransaction = Transaction.fromBinary(rawTx);
      }
    }
  }

  /**
   * Build minimal parse context from transaction
   */
  private buildContext(tx: Transaction): ParseContext {
    const txid = tx.id("hex");
    return {
      tx,
      txid,
      txos: tx.outputs.map((output, vout) => ({
        satoshis: BigInt(output.satoshis || 0),
        script: output.lockingScript.toBinary(),
        data: {},
        outpoint: new Outpoint(txid, vout),
      })),
      spends: [],
      summary: {},
      indexers: this.indexers,
    };
  }
}
