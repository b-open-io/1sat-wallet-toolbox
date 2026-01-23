/**
 * Sweep Module
 *
 * Functions for sweeping assets from external wallets into a BRC-100 wallet.
 */

import {
  P2PKH,
  PrivateKey,
  PublicKey,
  Transaction,
  type CreateActionOutput,
} from "@bsv/sdk";
import type { OneSatContext, Skill } from "../skills/types";
import type { IndexedOutput } from "../../services/types";
import { ONESAT_PROTOCOL } from "../constants";
import type {
  SweepBsvRequest,
  SweepBsvResponse,
  SweepInput,
  SweepOrdinalsRequest,
  SweepOrdinalsResponse,
} from "./types";

export * from "./types";

/**
 * Prepare sweep inputs from IndexedOutput objects by fetching locking scripts.
 * This extracts locking scripts from the raw transactions in BEEF format.
 */
export async function prepareSweepInputs(
  ctx: OneSatContext,
  utxos: IndexedOutput[],
): Promise<SweepInput[]> {
  if (!ctx.services) {
    throw new Error("Services required for prepareSweepInputs");
  }

  // Group UTXOs by txid to minimize BEEF fetches
  const byTxid = new Map<string, { vout: number; utxo: IndexedOutput }[]>();
  for (const utxo of utxos) {
    const [txid, voutStr] = utxo.outpoint.split("_");
    const vout = Number.parseInt(voutStr, 10);
    const existing = byTxid.get(txid) ?? [];
    existing.push({ vout, utxo });
    byTxid.set(txid, existing);
  }

  const results: SweepInput[] = [];

  // Fetch BEEF for each txid and extract locking scripts
  for (const [txid, outputs] of byTxid) {
    const beef = await ctx.services.getBeefForTxid(txid);
    const beefTx = beef.findTxid(txid);

    if (!beefTx?.tx) {
      throw new Error(`Transaction ${txid} not found in BEEF`);
    }

    for (const { vout, utxo } of outputs) {
      const output = beefTx.tx.outputs[vout];
      if (!output) {
        throw new Error(`Output ${vout} not found in transaction ${txid}`);
      }

      results.push({
        outpoint: utxo.outpoint,
        satoshis: utxo.satoshis ?? output.satoshis ?? 0,
        lockingScript: output.lockingScript?.toHex() ?? "",
      });
    }
  }

  return results;
}


/**
 * Sweep BSV from external inputs into the destination wallet.
 *
 * If amount is specified, only that amount is swept and the remainder
 * is returned to the source address. If amount is omitted, all input
 * value is swept (minus fees).
 */
export const sweepBsv: Skill<SweepBsvRequest, SweepBsvResponse> = {
  meta: {
    name: "sweepBsv",
    description:
      "Sweep BSV from external wallet (via WIF) into the connected wallet",
    category: "sweep",
    requiresServices: true,
    inputSchema: {
      type: "object",
      properties: {
        inputs: {
          type: "array",
          description: "UTXOs to sweep (use prepareSweepInputs to build these)",
          items: {
            type: "object",
            properties: {
              outpoint: { type: "string", description: "Outpoint (txid_vout)" },
              satoshis: { type: "integer", description: "Satoshis in output" },
              lockingScript: {
                type: "string",
                description: "Locking script hex",
              },
            },
            required: ["outpoint", "satoshis", "lockingScript"],
          },
        },
        wif: {
          type: "string",
          description: "WIF private key controlling the inputs",
        },
        amount: {
          type: "integer",
          description:
            "Amount to sweep (satoshis). If omitted, sweeps all input value.",
        },
      },
      required: ["inputs", "wif"],
    },
  },

  async execute(ctx, request): Promise<SweepBsvResponse> {
    if (!ctx.services) {
      return { error: "services-required" };
    }

    try {
      const { inputs, wif, amount } = request;

      if (!inputs || inputs.length === 0) {
        return { error: "no-inputs" };
      }

      // Parse WIF and derive source address
      const privateKey = PrivateKey.fromWif(wif);
      const sourceAddress = privateKey.toPublicKey().toAddress();

      // Calculate totals
      const inputTotal = inputs.reduce((sum, i) => sum + i.satoshis, 0);

      // Validate amount if specified
      if (amount !== undefined) {
        if (amount <= 0) {
          return { error: "invalid-amount" };
        }
        if (amount > inputTotal) {
          return { error: "insufficient-funds" };
        }
      }

      // Fetch BEEF for all input transactions and merge them
      const txids = [
        ...new Set(inputs.map((i) => i.outpoint.split("_")[0])),
      ];

      console.log(`[sweep] Fetching BEEF for ${txids.length} transactions`);

      // Get first BEEF, then merge others into it
      const firstBeef = await ctx.services.getBeefForTxid(txids[0]);
      for (let i = 1; i < txids.length; i++) {
        const additionalBeef = await ctx.services.getBeefForTxid(txids[i]);
        firstBeef.mergeBeef(additionalBeef);
      }

      console.log(`[sweep] Merged BEEF valid=${firstBeef.isValid()}, txs=${firstBeef.txs.length}`);

      // Build input descriptors (we'll sign after getting the final transaction)
      const inputDescriptors = inputs.map((input) => {
        const [txid, voutStr] = input.outpoint.split("_");
        // Convert outpoint format: our format uses "_" but SDK expects "."
        return {
          outpoint: `${txid}.${voutStr}`,
          inputDescription: "Sweep input",
          unlockingScriptLength: 108, // P2PKH unlocking script length
          sequenceNumber: 0xffffffff,
        };
      });

      const beefData = firstBeef.toBinary();

      // Build outputs array
      const outputs: CreateActionOutput[] = [];

      // If amount specified, create return output for the difference
      if (amount !== undefined) {
        const returnAmount = inputTotal - amount;
        if (returnAmount > 0) {
          outputs.push({
            lockingScript: new P2PKH().lock(sourceAddress).toHex(),
            satoshis: returnAmount,
            outputDescription: "Return to source",
          });
        }
      }
      // If no amount specified, no outputs - wallet creates change for everything

      // Step 1: Create action to get the signable transaction
      const createResult = await ctx.wallet.createAction({
        description: amount
          ? `Sweep ${amount} sats`
          : `Sweep ${inputTotal} sats`,
        inputBEEF: beefData,
        inputs: inputDescriptors,
        outputs,
        options: { signAndProcess: false },
      });

      if ("error" in createResult && createResult.error) {
        return { error: String(createResult.error) };
      }

      if (!createResult.signableTransaction) {
        return { error: "no-signable-transaction" };
      }

      // Step 2: Sign each input with our external key
      const tx = Transaction.fromBEEF(createResult.signableTransaction.tx);

      console.log(`[sweep] Transaction has ${tx.inputs.length} inputs, ${tx.outputs.length} outputs`);

      // Build a set of outpoints we control (using SDK format with ".")
      const ourOutpoints = new Set(
        inputs.map((input) => {
          const [txid, vout] = input.outpoint.split("_");
          return `${txid}.${vout}`;
        })
      );

      // Find and set up P2PKH unlocker on each input we control
      for (let i = 0; i < tx.inputs.length; i++) {
        const txInput = tx.inputs[i];
        const inputOutpoint = `${txInput.sourceTXID}.${txInput.sourceOutputIndex}`;
        const hasSourceTx = !!txInput.sourceTransaction;
        const sourceSatoshis = txInput.sourceTransaction?.outputs[txInput.sourceOutputIndex]?.satoshis;

        console.log(`[sweep] Input ${i}: ${inputOutpoint}, hasSourceTx=${hasSourceTx}, satoshis=${sourceSatoshis}, isOurs=${ourOutpoints.has(inputOutpoint)}`);

        if (ourOutpoints.has(inputOutpoint)) {
          const p2pkh = new P2PKH();
          txInput.unlockingScriptTemplate = p2pkh.unlock(
            privateKey,
            "all", // SIGHASH_ALL - commit to outputs (we know them now)
            true, // anyoneCanPay - only commit to this input
          );
        }
      }

      // Sign all inputs
      await tx.sign();

      // Extract unlocking scripts for signAction (only for our inputs)
      const spends: Record<number, { unlockingScript: string }> = {};
      for (let i = 0; i < tx.inputs.length; i++) {
        const txInput = tx.inputs[i];
        const inputOutpoint = `${txInput.sourceTXID}.${txInput.sourceOutputIndex}`;

        if (ourOutpoints.has(inputOutpoint)) {
          spends[i] = { unlockingScript: txInput.unlockingScript?.toHex() ?? "" };
        }
      }

      // Step 3: Complete the action with our signatures
      const signResult = await ctx.wallet.signAction({
        reference: createResult.signableTransaction.reference,
        spends,
      });

      if ("error" in signResult) {
        return { error: String(signResult.error) };
      }

      return {
        txid: signResult.txid,
        beef: signResult.tx ? Array.from(signResult.tx) : undefined,
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "unknown-error",
      };
    }
  },
};

/**
 * Sweep ordinals from external inputs into the destination wallet.
 *
 * Each input is expected to be a 1-sat ordinal output. Each ordinal is
 * transferred to a derived address using the wallet's key derivation.
 */
export const sweepOrdinals: Skill<SweepOrdinalsRequest, SweepOrdinalsResponse> = {
  meta: {
    name: "sweepOrdinals",
    description:
      "Sweep ordinals from external wallet (via WIF) into the connected wallet",
    category: "sweep",
    requiresServices: true,
    inputSchema: {
      type: "object",
      properties: {
        inputs: {
          type: "array",
          description: "Ordinal UTXOs to sweep",
          items: {
            type: "object",
            properties: {
              outpoint: { type: "string", description: "Outpoint (txid_vout)" },
              satoshis: { type: "integer", description: "Satoshis (should be 1)" },
              lockingScript: { type: "string", description: "Locking script hex" },
              contentType: { type: "string", description: "Content type from metadata" },
              origin: { type: "string", description: "Origin outpoint" },
              name: { type: "string", description: "Name from MAP metadata" },
            },
            required: ["outpoint", "satoshis", "lockingScript"],
          },
        },
        wif: {
          type: "string",
          description: "WIF private key controlling the inputs",
        },
      },
      required: ["inputs", "wif"],
    },
  },

  async execute(ctx, request): Promise<SweepOrdinalsResponse> {
    if (!ctx.services) {
      return { error: "services-required" };
    }

    try {
      const { inputs, wif } = request;

      if (!inputs || inputs.length === 0) {
        return { error: "no-inputs" };
      }

      // Parse WIF
      const privateKey = PrivateKey.fromWif(wif);

      // Fetch BEEF for all input transactions and merge them
      const txids = [...new Set(inputs.map((i) => i.outpoint.split("_")[0]))];
      console.log(`[sweepOrdinals] Fetching BEEF for ${txids.length} transactions`);

      const firstBeef = await ctx.services.getBeefForTxid(txids[0]);
      for (let i = 1; i < txids.length; i++) {
        const additionalBeef = await ctx.services.getBeefForTxid(txids[i]);
        firstBeef.mergeBeef(additionalBeef);
      }

      console.log(`[sweepOrdinals] Merged BEEF valid=${firstBeef.isValid()}, txs=${firstBeef.txs.length}`);

      // Build input descriptors
      const inputDescriptors = inputs.map((input) => {
        const [txid, voutStr] = input.outpoint.split("_");
        return {
          outpoint: `${txid}.${voutStr}`,
          inputDescription: `Ordinal ${input.origin ?? input.outpoint}`,
          unlockingScriptLength: 108,
          sequenceNumber: 0xffffffff,
        };
      });

      // Build outputs - one per ordinal, each 1 sat to derived address
      const outputs: CreateActionOutput[] = [];
      for (const input of inputs) {
        // Derive a unique public key for this ordinal using the input outpoint as keyID
        const pubKeyResult = await ctx.wallet.getPublicKey({
          protocolID: ONESAT_PROTOCOL,
          keyID: input.outpoint,
          forSelf: true,
        });

        if (!pubKeyResult.publicKey) {
          return { error: `Failed to derive key for ${input.outpoint}` };
        }

        // Create P2PKH locking script from derived public key
        const derivedAddress = PublicKey.fromString(pubKeyResult.publicKey).toAddress();
        const lockingScript = new P2PKH().lock(derivedAddress);

        // Build tags following ordinals API pattern
        const tags: string[] = [];
        if (input.contentType) tags.push(`type:${input.contentType}`);
        if (input.origin) tags.push(`origin:${input.origin}`);
        if (input.name) tags.push(`name:${input.name}`);

        outputs.push({
          lockingScript: lockingScript.toHex(),
          satoshis: 1,
          outputDescription: `Ordinal ${input.origin ?? input.outpoint}`,
          basket: "1sat",
          tags,
          customInstructions: JSON.stringify({
            protocolID: ONESAT_PROTOCOL,
            keyID: input.outpoint,
          }),
        });
      }

      const beefData = firstBeef.toBinary();

      // Create action to get signable transaction
      // CRITICAL: randomizeOutputs must be false to preserve ordinal satoshi positions
      const createResult = await ctx.wallet.createAction({
        description: `Sweep ${inputs.length} ordinal${inputs.length !== 1 ? "s" : ""}`,
        inputBEEF: beefData,
        inputs: inputDescriptors,
        outputs,
        options: { signAndProcess: false, randomizeOutputs: false },
      });

      if ("error" in createResult && createResult.error) {
        return { error: String(createResult.error) };
      }

      if (!createResult.signableTransaction) {
        return { error: "no-signable-transaction" };
      }

      // Sign each input with our external key
      const tx = Transaction.fromBEEF(createResult.signableTransaction.tx);

      // Build a set of outpoints we control
      const ourOutpoints = new Set(
        inputs.map((input) => {
          const [txid, vout] = input.outpoint.split("_");
          return `${txid}.${vout}`;
        })
      );

      // Set up P2PKH unlocker on each input we control
      for (let i = 0; i < tx.inputs.length; i++) {
        const txInput = tx.inputs[i];
        const inputOutpoint = `${txInput.sourceTXID}.${txInput.sourceOutputIndex}`;

        if (ourOutpoints.has(inputOutpoint)) {
          const p2pkh = new P2PKH();
          txInput.unlockingScriptTemplate = p2pkh.unlock(
            privateKey,
            "all",
            true, // anyoneCanPay
          );
        }
      }

      await tx.sign();

      // Extract unlocking scripts for signAction
      const spends: Record<number, { unlockingScript: string }> = {};
      for (let i = 0; i < tx.inputs.length; i++) {
        const txInput = tx.inputs[i];
        const inputOutpoint = `${txInput.sourceTXID}.${txInput.sourceOutputIndex}`;

        if (ourOutpoints.has(inputOutpoint)) {
          spends[i] = { unlockingScript: txInput.unlockingScript?.toHex() ?? "" };
        }
      }

      // Complete the action with our signatures
      const signResult = await ctx.wallet.signAction({
        reference: createResult.signableTransaction.reference,
        spends,
      });

      if ("error" in signResult) {
        return { error: String(signResult.error) };
      }

      return {
        txid: signResult.txid,
        beef: signResult.tx ? Array.from(signResult.tx) : undefined,
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "unknown-error",
      };
    }
  },
};

// Export skills array for registry
export const sweepSkills = [sweepBsv, sweepOrdinals];
