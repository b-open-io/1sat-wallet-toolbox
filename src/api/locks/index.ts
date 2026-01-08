/**
 * Locks Module
 *
 * Functions for time-locking BSV.
 */

import {
  Hash,
  PublicKey,
  Script,
  Transaction,
  TransactionSignature,
  Utils,
  type WalletInterface,
  type WalletOutput,
  type CreateActionOutput,
} from "@bsv/sdk";
import { LOCK_BASKET, LOCK_PREFIX, LOCK_SUFFIX, MIN_UNLOCK_SATS } from "../constants";
import { getChainInfo } from "../balance";

// Hardcoded keyID for all locks - deterministic derivation
const LOCK_KEY_ID = "lock";

export interface LockBsvRequest {
  /** Amount in satoshis to lock */
  satoshis: number;
  /** Block height until which to lock */
  until: number;
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
 * Lock BSV until a block height.
 * Derives lock address using hardcoded keyID.
 */
export async function lockBsv(
  cwi: WalletInterface,
  requests: LockBsvRequest[]
): Promise<LockOperationResponse> {
  try {
    if (!requests || requests.length === 0) {
      return { error: "no-lock-requests" };
    }

    // Derive lock address once (same for all locks)
    const { publicKey } = await cwi.getPublicKey({
      protocolID: [1, "lock"],
      keyID: LOCK_KEY_ID,
      counterparty: "self",
      forSelf: true,
    });
    const lockAddress = PublicKey.fromString(publicKey).toAddress();

    const outputs: CreateActionOutput[] = [];
    for (const req of requests) {
      if (req.satoshis <= 0) return { error: "invalid-satoshis" };
      if (req.until <= 0) return { error: "invalid-block-height" };

      const lockingScript = buildLockScript(lockAddress, req.until);
      outputs.push({
        lockingScript: lockingScript.toHex(),
        satoshis: req.satoshis,
        outputDescription: `Lock ${req.satoshis} sats until block ${req.until}`,
        basket: LOCK_BASKET,
        tags: [`lock:until:${req.until}`],
      });
    }

    const result = await cwi.createAction({
      description: `Lock BSV in ${requests.length} output(s)`,
      outputs,
    });

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
 * Uses createSignature with stored keyID to sign unlock transactions.
 */
export async function unlockBsv(
  cwi: WalletInterface,
  chain: "main" | "test" = "main",
  wocApiKey?: string
): Promise<LockOperationResponse> {
  try {
    // Get current block height
    const chainInfo = await getChainInfo(chain, wocApiKey);
    const currentHeight = chainInfo?.blocks || 0;
    if (currentHeight === 0) {
      return { error: "could-not-get-block-height" };
    }

    // Get lock outputs from basket
    const result = await cwi.listOutputs({
      basket: LOCK_BASKET,
      includeTags: true,
      include: "locking scripts",
      limit: 10000,
    });

    // Filter for matured locks
    const maturedLocks: Array<{
      output: WalletOutput;
      until: number;
    }> = [];

    for (const o of result.outputs) {
      const untilTag = o.tags?.find((t) => t.startsWith("lock:until:"));
      if (!untilTag) continue;

      const until = parseInt(untilTag.slice(11), 10);

      if (until <= currentHeight) {
        maturedLocks.push({ output: o, until });
      }
    }

    if (maturedLocks.length === 0) {
      return { error: "no-matured-locks" };
    }

    // Check minimum unlock amount
    const totalSats = maturedLocks.reduce((sum, l) => sum + l.output.satoshis, 0);
    if (totalSats < MIN_UNLOCK_SATS * maturedLocks.length) {
      return { error: "insufficient-unlock-amount" };
    }

    // Find max until value for lockTime
    const maxUntil = Math.max(...maturedLocks.map((l) => l.until));

    // Build createAction args
    const createResult = await cwi.createAction({
      description: `Unlock ${maturedLocks.length} lock(s)`,
      inputs: maturedLocks.map((l) => ({
        outpoint: l.output.outpoint,
        inputDescription: "Locked BSV",
        unlockingScriptLength: 180, // sig + pubkey + preimage estimate
        sequenceNumber: 0, // Must be < 0xffffffff for nLockTime
      })),
      outputs: [
        {
          lockingScript: "", // Will be filled by wallet as change
          satoshis: 0, // Will be calculated by wallet
          outputDescription: "Unlocked BSV",
        },
      ],
      lockTime: maxUntil,
      options: { signAndProcess: false },
    });

    if ("error" in createResult && createResult.error) {
      return { error: String(createResult.error) };
    }

    if (!createResult.signableTransaction) {
      return { error: "no-signable-transaction" };
    }

    // Parse transaction from BEEF
    const tx = Transaction.fromBEEF(createResult.signableTransaction.tx);

    // Build unlocking scripts for each input
    const spends: Record<number, { unlockingScript: string }> = {};

    for (let i = 0; i < maturedLocks.length; i++) {
      const lock = maturedLocks[i];
      const input = tx.inputs[i];
      const lockingScript = Script.fromHex(lock.output.lockingScript!);

      // Build preimage for signature
      const preimage = TransactionSignature.format({
        sourceTXID: input.sourceTXID!,
        sourceOutputIndex: input.sourceOutputIndex,
        sourceSatoshis: lock.output.satoshis,
        transactionVersion: tx.version,
        otherInputs: tx.inputs.filter((_, idx) => idx !== i),
        outputs: tx.outputs,
        inputIndex: i,
        subscript: lockingScript,
        inputSequence: 0,
        lockTime: tx.lockTime,
        scope:
          TransactionSignature.SIGHASH_ALL |
          TransactionSignature.SIGHASH_ANYONECANPAY |
          TransactionSignature.SIGHASH_FORKID,
      });

      // Hash preimage for signing
      const sighash = Hash.sha256(Hash.sha256(preimage));

      // Get signature via createSignature using hardcoded keyID
      const { signature } = await cwi.createSignature({
        protocolID: [1, "lock"],
        keyID: LOCK_KEY_ID,
        counterparty: "self",
        hashToDirectlySign: Array.from(sighash),
      });

      // Get public key
      const { publicKey } = await cwi.getPublicKey({
        protocolID: [1, "lock"],
        keyID: LOCK_KEY_ID,
        counterparty: "self",
        forSelf: true,
      });

      // Build unlocking script: <sig> <pubkey> <preimage>
      const unlockingScript = new Script()
        .writeBin(signature)
        .writeBin(Utils.toArray(publicKey, "hex"))
        .writeBin(Array.from(preimage));

      spends[i] = { unlockingScript: unlockingScript.toHex() };
    }

    // Sign and broadcast
    const signResult = await cwi.signAction({
      reference: createResult.signableTransaction.reference,
      spends,
    });

    if ("error" in signResult) {
      return { error: String(signResult.error) };
    }

    return {
      txid: signResult.txid,
      rawtx: signResult.tx ? Utils.toHex(signResult.tx) : undefined,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "unknown-error" };
  }
}
