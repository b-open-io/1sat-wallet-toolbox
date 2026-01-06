/**
 * Payments Module
 *
 * Functions for sending BSV payments.
 */

import {
  P2PKH,
  Script,
  Utils,
  type WalletInterface,
  type CreateActionArgs,
  type CreateActionOutput,
} from "@bsv/sdk";
import { Inscription } from "@bopen-io/templates";
import { FUNDING_BASKET } from "../constants";

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

/**
 * Check if address is a paymail.
 */
function isPaymail(address: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
}

/**
 * Build an inscription locking script.
 */
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

/**
 * Build CreateActionArgs for sending BSV payments.
 * Does NOT execute - returns params for createAction.
 */
export function buildSendBsv(requests: SendBsvRequest[]): CreateActionArgs | { error: string } {
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

  return {
    description: `Send ${requests.length} payment(s)`,
    outputs,
    options: {
      signAndProcess: true,
    },
  };
}

/**
 * Build CreateActionArgs for sending all BSV to a destination.
 * Does NOT execute - returns params for createAction.
 */
export async function buildSendAllBsv(
  cwi: WalletInterface,
  destination: string
): Promise<CreateActionArgs | { error: string }> {
  if (isPaymail(destination)) {
    return { error: "paymail-not-yet-implemented" };
  }

  const result = await cwi.listOutputs({
    basket: FUNDING_BASKET,
    include: "locking scripts",
    limit: 10000,
  });

  if (!result.outputs || result.outputs.length === 0) {
    return { error: "no-funds" };
  }

  const totalSats = result.outputs.reduce((sum, o) => sum + o.satoshis, 0);
  const estimatedFee = Math.ceil((result.outputs.length * 150 + 44) * 1);
  const sendAmount = totalSats - estimatedFee;

  if (sendAmount <= 0) {
    return { error: "insufficient-funds-for-fee" };
  }

  const inputs = result.outputs.map((o) => ({
    outpoint: o.outpoint,
    inputDescription: "Sweep funds",
  }));

  return {
    description: "Send all BSV",
    inputs,
    outputs: [{
      lockingScript: new P2PKH().lock(destination).toHex(),
      satoshis: sendAmount,
      outputDescription: "Sweep all funds",
    }],
    options: {
      signAndProcess: true,
    },
  };
}

/**
 * Send BSV to one or more destinations.
 */
export async function sendBsv(
  cwi: WalletInterface,
  requests: SendBsvRequest[]
): Promise<SendBsvResponse> {
  try {
    const params = buildSendBsv(requests);
    if ("error" in params) {
      return params;
    }

    const result = await cwi.createAction(params);

    if (!result.txid) {
      return { error: "no-txid-returned" };
    }
    return { txid: result.txid, rawtx: result.tx ? Utils.toHex(result.tx) : undefined };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "unknown-error" };
  }
}

/**
 * Send all BSV to a destination address.
 */
export async function sendAllBsv(
  cwi: WalletInterface,
  destination: string
): Promise<SendBsvResponse> {
  try {
    const params = await buildSendAllBsv(cwi, destination);
    if ("error" in params) {
      return params;
    }

    const result = await cwi.createAction(params);

    if (!result.txid) {
      return { error: "no-txid-returned" };
    }
    return { txid: result.txid, rawtx: result.tx ? Utils.toHex(result.tx) : undefined };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "unknown-error" };
  }
}
