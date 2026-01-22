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

/** Input for ordinal sweep operations */
export interface SweepOrdinalInput extends SweepInput {
  /** Content type from ordfs metadata */
  contentType?: string;
  /** Origin outpoint for tracking */
  origin?: string;
}

/** Request to sweep ordinals */
export interface SweepOrdinalsRequest {
  /** Ordinal UTXOs to sweep */
  inputs: SweepOrdinalInput[];
  /** WIF private key controlling the inputs */
  wif: string;
}

/** Response from ordinal sweep operation */
export interface SweepOrdinalsResponse {
  /** Transaction ID if successful */
  txid?: string;
  /** BEEF (transaction with validity proof) */
  beef?: number[];
  /** Error message if failed */
  error?: string;
}
