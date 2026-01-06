/**
 * Locks Module
 *
 * Functions for time-locking BSV.
 */

import {
  P2PKH,
  Script,
  Utils,
  type WalletInterface,
  type WalletOutput,
  type CreateActionArgs,
  type CreateActionOutput,
} from "@bsv/sdk";
import { LOCK_BASKET, LOCK_PREFIX, LOCK_SUFFIX, MIN_UNLOCK_SATS } from "../constants";
import { getChainInfo } from "../balance";

export interface LockBsvRequest {
  /** Amount in satoshis to lock */
  satoshis: number;
  /** Block height until which to lock */
  until: number;
  /** Address to lock to (required - use a derived address for unlocking) */
  lockAddress: string;
}

export interface LockData {
  /** Total locked satoshis */
  totalLocked: number;
  /** Unlockable satoshis (matured locks) */
  unlockable: number;
  /** Next unlock block height */
  nextUnlock: number;
}

export interface LockOperationResponse {
  txid?: string;
  rawtx?: string;
  error?: string;
}

/**
 * Build lock script for time-locked BSV.
 */
function buildLockScript(address: string, until: number): Script {
  const pkh = Utils.fromBase58Check(address).data as number[];
  return new Script()
    .writeScript(Script.fromHex(LOCK_PREFIX))
    .writeBin(pkh)
    .writeNumber(until)
    .writeScript(Script.fromHex(LOCK_SUFFIX));
}

/**
 * List locked outputs from the lock basket.
 * Returns WalletOutput[] directly - use tags for metadata (lock:until:).
 */
export async function listLocks(
  cwi: WalletInterface,
  limit = 10000
): Promise<WalletOutput[]> {
  const result = await cwi.listOutputs({
    basket: LOCK_BASKET,
    includeTags: true,
    limit,
  });
  return result.outputs;
}

/**
 * Get lock data summary.
 */
export async function getLockData(
  cwi: WalletInterface,
  chain: "main" | "test" = "main",
  wocApiKey?: string
): Promise<LockData> {
  const lockData: LockData = { totalLocked: 0, unlockable: 0, nextUnlock: 0 };

  const chainInfo = await getChainInfo(chain, wocApiKey);
  const currentHeight = chainInfo?.blocks || 0;

  const outputs = await listLocks(cwi);

  for (const o of outputs) {
    const lockTag = o.tags?.find((t) => t.startsWith("lock:until:"));
    if (!lockTag) continue;

    const until = parseInt(lockTag.slice(11), 10);
    lockData.totalLocked += o.satoshis;

    if (until <= currentHeight) {
      lockData.unlockable += o.satoshis;
    } else if (!lockData.nextUnlock || until < lockData.nextUnlock) {
      lockData.nextUnlock = until;
    }
  }

  if (lockData.unlockable < MIN_UNLOCK_SATS * outputs.length) {
    lockData.unlockable = 0;
  }

  return lockData;
}

/**
 * Build CreateActionArgs for locking BSV until a block height.
 * Does NOT execute - returns params for createAction.
 */
export function buildLockBsv(requests: LockBsvRequest[]): CreateActionArgs | { error: string } {
  if (!requests || requests.length === 0) {
    return { error: "no-lock-requests" };
  }

  const outputs: CreateActionOutput[] = [];
  for (const req of requests) {
    if (req.satoshis <= 0) return { error: "invalid-satoshis" };
    if (req.until <= 0) return { error: "invalid-block-height" };
    if (!req.lockAddress) return { error: "missing-lock-address" };

    const lockingScript = buildLockScript(req.lockAddress, req.until);
    outputs.push({
      lockingScript: lockingScript.toHex(),
      satoshis: req.satoshis,
      outputDescription: `Lock ${req.satoshis} sats until block ${req.until}`,
    });
  }

  return {
    description: `Lock BSV in ${requests.length} output(s)`,
    outputs,
  };
}

/**
 * Lock BSV until a block height.
 */
export async function lockBsv(
  cwi: WalletInterface,
  requests: LockBsvRequest[]
): Promise<LockOperationResponse> {
  try {
    const params = buildLockBsv(requests);
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
 * Unlock matured BSV locks.
 * TODO: Requires direct key access - not possible through CWI alone
 */
export async function unlockBsv(_cwi: WalletInterface): Promise<LockOperationResponse> {
  return { error: "requires-direct-key-access" };
}
