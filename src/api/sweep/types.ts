/**
 * Sweep Module Types
 */

/** Input for sweep operations - a UTXO to be swept */
export interface SweepInput {
  /** Outpoint in format "txid_vout" */
  outpoint: string;
  /** Satoshis in this output */
  satoshis: number;
  /** Locking script hex */
  lockingScript: string;
}

/** Request to sweep BSV funds */
export interface SweepBsvRequest {
  /** UTXOs to spend from source wallet */
  inputs: SweepInput[];
  /** WIF private key controlling the inputs */
  wif: string;
  /** Amount to sweep (in satoshis). If omitted, sweeps all input value. */
  amount?: number;
}

/** Response from sweep operation */
export interface SweepBsvResponse {
  /** Transaction ID if successful */
  txid?: string;
  /** BEEF (transaction with validity proof) */
  beef?: number[];
  /** Error message if failed */
  error?: string;
}
