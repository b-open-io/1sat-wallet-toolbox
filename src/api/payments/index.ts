/**
 * Payments Module
 *
 * Skills for sending BSV payments.
 */

import { P2PKH, Script, Utils, type CreateActionOutput } from "@bsv/sdk";
import { Inscription } from "@bopen-io/templates";
import type { Skill } from "../skills/types";
import { FUNDING_BASKET } from "../constants";

// ============================================================================
// Types
// ============================================================================

export interface SendBsvRequest {
  /** Destination address (P2PKH) */
  address?: string;
  /** Destination paymail */
  paymail?: string;
  /** Amount in satoshis */
  satoshis: number;
  /** Custom locking script (hex) */
  script?: string;
  /** OP_RETURN data */
  data?: string[];
  /** Inscription data */
  inscription?: {
    base64Data: string;
    mimeType: string;
    map?: Record<string, string>;
  };
}

export interface SendBsvResponse {
  txid?: string;
  rawtx?: string;
  error?: string;
}

// ============================================================================
// Internal helpers
// ============================================================================

function isPaymail(address: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
}

function buildInscriptionScript(address: string, base64Data: string, mimeType: string): Script {
  const content = Utils.toArray(base64Data, "base64");
  const inscription = Inscription.create(new Uint8Array(content), mimeType);
  const inscriptionScript = inscription.lock();
  const p2pkhScript = new P2PKH().lock(address);

  const combined = new Script();
  for (const chunk of inscriptionScript.chunks) combined.chunks.push(chunk);
  for (const chunk of p2pkhScript.chunks) combined.chunks.push(chunk);
  return combined;
}

// ============================================================================
// Skills
// ============================================================================

/** Input for sendBsv skill */
export interface SendBsvInput {
  requests: SendBsvRequest[];
}

/**
 * Send BSV to one or more destinations.
 */
export const sendBsv: Skill<SendBsvInput, SendBsvResponse> = {
  meta: {
    name: "sendBsv",
    description: "Send BSV to one or more destinations (addresses, scripts, or OP_RETURN)",
    category: "payments",
    inputSchema: {
      type: "object",
      properties: {
        requests: {
          type: "array",
          description: "Array of payment requests",
          items: {
            type: "object",
            properties: {
              address: { type: "string", description: "Destination P2PKH address" },
              paymail: { type: "string", description: "Destination paymail address" },
              satoshis: { type: "integer", description: "Amount in satoshis" },
              script: { type: "string", description: "Custom locking script (hex)" },
              data: {
                type: "array",
                description: "OP_RETURN data elements",
                items: { type: "string" },
              },
            },
            required: ["satoshis"],
          },
        },
      },
      required: ["requests"],
    },
  },
  async execute(ctx, input) {
    try {
      const { requests } = input;
      if (!requests || requests.length === 0) {
        return { error: "no-requests" };
      }

      const outputs: CreateActionOutput[] = [];
      for (const req of requests) {
        let lockingScript: Script;

        if (req.script) {
          lockingScript = Script.fromHex(req.script);
        } else if (req.address) {
          if (req.inscription) {
            lockingScript = buildInscriptionScript(req.address, req.inscription.base64Data, req.inscription.mimeType);
          } else {
            lockingScript = new P2PKH().lock(req.address);
          }
        } else if (req.data && req.data.length > 0) {
          try {
            lockingScript = Script.fromASM(`OP_0 OP_RETURN ${req.data.join(" ")}`);
          } catch {
            return { error: "invalid-data" };
          }
        } else if (req.paymail) {
          return { error: "paymail-not-yet-implemented" };
        } else {
          return { error: "invalid-request" };
        }

        outputs.push({
          lockingScript: lockingScript.toHex(),
          satoshis: req.satoshis,
          outputDescription: `Payment of ${req.satoshis} sats`,
        });
      }

      const result = await ctx.wallet.createAction({
        description: `Send ${requests.length} payment(s)`,
        outputs,
        options: { signAndProcess: true, acceptDelayedBroadcast: false },
      });

      if (!result.txid) {
        return { error: "no-txid-returned" };
      }
      return { txid: result.txid, rawtx: result.tx ? Utils.toHex(result.tx) : undefined };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "unknown-error" };
    }
  },
};

/** Input for sendAllBsv skill */
export interface SendAllBsvInput {
  /** Destination address to send all funds to */
  destination: string;
}

/**
 * Send all BSV to a destination address.
 */
export const sendAllBsv: Skill<SendAllBsvInput, SendBsvResponse> = {
  meta: {
    name: "sendAllBsv",
    description: "Send all BSV from wallet to a single destination address",
    category: "payments",
    inputSchema: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          description: "Destination P2PKH address to send all funds to",
        },
      },
      required: ["destination"],
    },
  },
  async execute(ctx, input) {
    try {
      const { destination } = input;
      if (isPaymail(destination)) {
        return { error: "paymail-not-yet-implemented" };
      }

      const listResult = await ctx.wallet.listOutputs({
        basket: FUNDING_BASKET,
        include: "locking scripts",
        limit: 10000,
      });

      if (!listResult.outputs || listResult.outputs.length === 0) {
        return { error: "no-funds" };
      }

      const totalSats = listResult.outputs.reduce((sum, o) => sum + o.satoshis, 0);
      const estimatedFee = Math.ceil((listResult.outputs.length * 150 + 44) * 1);
      const sendAmount = totalSats - estimatedFee;

      if (sendAmount <= 0) {
        return { error: "insufficient-funds-for-fee" };
      }

      const inputs = listResult.outputs.map((o) => ({
        outpoint: o.outpoint,
        inputDescription: "Sweep funds",
      }));

      const result = await ctx.wallet.createAction({
        description: "Send all BSV",
        inputs,
        outputs: [
          {
            lockingScript: new P2PKH().lock(destination).toHex(),
            satoshis: sendAmount,
            outputDescription: "Sweep all funds",
          },
        ],
        options: { signAndProcess: true, acceptDelayedBroadcast: false },
      });

      if (!result.txid) {
        return { error: "no-txid-returned" };
      }
      return { txid: result.txid, rawtx: result.tx ? Utils.toHex(result.tx) : undefined };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "unknown-error" };
    }
  },
};

// ============================================================================
// Module exports
// ============================================================================

/** All payment skills for registry */
export const paymentsSkills = [sendBsv, sendAllBsv];
