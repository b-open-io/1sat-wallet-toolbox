/**
 * Consolidated type definitions for 1sat-stack API clients.
 * These types mirror the structures returned by the 1sat-stack server.
 */

// ============================================================================
// Client Configuration
// ============================================================================

/**
 * Options for configuring API clients
 */
export interface ClientOptions {
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Custom fetch implementation */
  fetch?: typeof fetch;
}

// ============================================================================
// Server Capabilities
// ============================================================================

/**
 * Server capabilities returned by /api/capabilities endpoint.
 * These match the actual capability names from 1sat-stack.
 */
export type Capability =
  | "beef" // BEEF storage, raw tx, proofs (/api/beef)
  | "pubsub" // SSE subscriptions (/api/sse)
  | "txo" // TXO lookup (/api/txo)
  | "owner" // Owner queries (/api/owner)
  | "indexer" // Indexer operations (/api/indexer)
  | "bsv21" // BSV21 tokens (/api/bsv21)
  | "ordfs" // Content serving (/api/ordfs)
  | "chaintracks" // Block headers (/api/chaintracks)
  | "arcade" // TX broadcast (/api/arcade)
  | "overlay"; // Overlay engine (/api/overlay)

// ============================================================================
// Chaintracks Types (Block Headers)
// ============================================================================

/**
 * Block header data returned by chaintracks endpoints
 */
export interface BlockHeader {
  height: number;
  hash: string;
  version: number;
  prevHash: string;
  merkleRoot: string;
  time: number;
  bits: number;
  nonce: number;
}

// ============================================================================
// Arcade Types (Transaction Broadcast)
// ============================================================================

/**
 * Transaction status values from arcade
 */
export type TxStatus =
  | "UNKNOWN"
  | "RECEIVED"
  | "SENT_TO_NETWORK"
  | "ACCEPTED_BY_NETWORK"
  | "SEEN_ON_NETWORK"
  | "DOUBLE_SPEND_ATTEMPTED"
  | "REJECTED"
  | "MINED"
  | "IMMUTABLE";

/**
 * Transaction status response from arcade
 */
export interface TransactionStatus {
  txid: string;
  txStatus: TxStatus;
  timestamp: string;
  blockHash?: string;
  blockHeight?: number;
  merklePath?: string;
  extraInfo?: string;
  competingTxs?: string[];
}

/**
 * Options for submitting transactions to arcade
 */
export interface SubmitOptions {
  /** URL for status callbacks */
  callbackUrl?: string;
  /** Token for authenticating callbacks */
  callbackToken?: string;
  /** Receive all status updates, not just final */
  fullStatusUpdates?: boolean;
  /** Skip fee validation */
  skipFeeValidation?: boolean;
  /** Skip script validation */
  skipScriptValidation?: boolean;
}

/**
 * Mining policy from arcade
 */
export interface Policy {
  maxscriptsizepolicy: number;
  maxtxsigopscountspolicy: number;
  maxtxsizepolicy: number;
  miningFee: { satoshis: number; bytes: number };
}

// ============================================================================
// TXO Types (Transaction Outputs)
// ============================================================================

/**
 * Indexed transaction output
 */
export interface IndexedOutput {
  outpoint: string;
  satoshis: number;
  script?: string;
  height?: number;
  idx?: number;
  owners?: string[];
  events?: string[];
  data?: Record<string, unknown>;
  spend?: string;
  score: number;
}

/**
 * Spend information response
 */
export interface SpendResponse {
  spendTxid: string | null;
}

/**
 * Options for querying TXOs
 */
export interface TxoQueryOptions {
  /** Tags to include in response data */
  tags?: string[];
  /** Include script in response */
  script?: boolean;
  /** Starting score for pagination */
  from?: number;
  /** Maximum results to return */
  limit?: number;
  /** Reverse order */
  rev?: boolean;
  /** Filter for unspent only */
  unspent?: boolean;
}

/**
 * Search request for multiple keys
 */
export interface SearchRequest {
  keys: string[];
  limit?: number;
  from?: number;
  reverse?: boolean;
  unspent?: boolean;
  tags?: string[];
}

// ============================================================================
// Owner Types (Address Queries)
// ============================================================================

/**
 * Balance response from owner endpoint
 */
export interface BalanceResponse {
  balance: number;
  count: number;
}

/**
 * Sync output streamed via SSE
 */
export interface SyncOutput {
  outpoint: string;
  score: number;
  spendTxid?: string;
}

// ============================================================================
// Indexer Types
// ============================================================================

/**
 * Indexed output from parse/ingest operations
 */
export interface IndexedTxo {
  outpoint: string;
  satoshis: number;
  script?: string;
  owners?: string[];
  events?: string[];
  data?: Record<string, unknown>;
}

/**
 * Index context returned by parse/ingest
 */
export interface IndexContext {
  txid: string;
  score: number;
  outputs: IndexedTxo[];
}

// ============================================================================
// ORDFS Types (Content)
// ============================================================================

/**
 * OrdFS metadata for an inscription
 */
export interface OrdfsMetadata {
  outpoint: string;
  origin?: string;
  sequence: number;
  contentType: string;
  contentLength: number;
  parent?: string;
  map?: Record<string, unknown>;
}

// ============================================================================
// BSV21 Types (Tokens)
// ============================================================================

/**
 * BSV21 token details (deploy data)
 */
export interface Bsv21TokenDetails {
  id: string;
  txid: string;
  vout: number;
  op: string;
  amt: string;
  sym?: string;
  dec: number;
  icon?: string;
}

/**
 * BSV21 token data structure from overlay API
 */
export interface Bsv21TokenData {
  id: string;
  op: string;
  amt: string;
  sym?: string;
  dec?: number;
  icon?: string;
  address?: string;
}

/**
 * BSV21 output data from overlay API
 */
export interface Bsv21OutputData {
  txid: string;
  vout: number;
  data: {
    bsv21: Bsv21TokenData;
  };
  script: string;
  satoshis: number;
  spend: string | null;
  score: number;
}

/**
 * BSV21 transaction data from overlay API
 */
export interface Bsv21TransactionData {
  txid: string;
  inputs: Bsv21OutputData[];
  outputs: Bsv21OutputData[];
  beef?: string;
}

// ============================================================================
// SSE/PubSub Types
// ============================================================================

/**
 * Event from SSE subscription
 */
export interface SseEvent {
  topic: string;
  data: string;
  score?: number;
}
