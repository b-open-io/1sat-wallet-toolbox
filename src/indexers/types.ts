import type { Transaction, TransactionOutput } from "@bsv/sdk";
import type { Outpoint } from "./Outpoint";

/**
 * BSV21 token data structure from overlay API
 */
export interface Bsv21TokenData {
  id: string;
  op: string;
  amt: string; // Stored as string in overlay to avoid BSON type conversion issues
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

/**
 * IndexData contains the parsed data and tags from an indexer
 * Tags are concatenated strings in the format "key:value" for searchability
 */
export interface IndexData {
  data: unknown;
  tags: string[];
  /** Optional text content (e.g., from text inscriptions). */
  content?: string;
}

/**
 * IndexSummary contains transaction-level summary information
 */
export interface IndexSummary {
  id?: string;
  amount?: number;
  icon?: string;
  data?: unknown;
}

/**
 * Result from Indexer.parse() method
 */
export interface ParseResult {
  data: unknown;
  tags: string[];
  owner?: string;
  basket?: string;
  /** Optional text content (e.g., from text inscriptions). Truncated to 1000 chars when stored. */
  content?: string;
}

/**
 * Transaction output structure used during parsing
 */
export interface Txo {
  output: TransactionOutput;
  outpoint: Outpoint;
  owner?: string;
  basket?: string;
  data: { [tag: string]: IndexData };
}

/**
 * Minimal context structure for indexer parsing
 */
export interface ParseContext {
  tx: Transaction;
  txid: string;
  txos: Txo[];
  spends: Txo[];
  summary: { [tag: string]: IndexSummary };
  indexers: Indexer[];
}

/**
 * Base indexer class that all indexers extend
 */
export abstract class Indexer {
  abstract tag: string;
  abstract name: string;

  constructor(
    public owners = new Set<string>(),
    public network: "mainnet" | "testnet" = "mainnet",
  ) {}

  /**
   * Parses a single output in isolation and returns the parse result if relevant.
   * Cannot access other outputs or inputs - only the single Txo.
   * Cross-output/cross-input logic belongs in summarize().
   */
  abstract parse(txo: Txo): Promise<ParseResult | undefined>;

  /**
   * Post-parse phase with full transaction context.
   * Used for cross-output/cross-input validation and transaction-level summarization.
   */
  async summarize(
    _ctx: ParseContext,
    _isBroadcasted: boolean,
  ): Promise<IndexSummary | undefined> {
    return undefined;
  }
}
