/**
 * OneSatApi - 1Sat ecosystem application logic built on BRC-100/CWI
 *
 * This class provides convenient, app-specific methods for the 1Sat ecosystem
 * that internally use the standard CWI (WalletInterface) primitives.
 *
 * The class is a thin facade over the modular functions in the subfolders.
 * You can use the class for convenience, or import functions directly:
 *
 * ```typescript
 * // Class-based usage
 * const api = new OneSatApi(cwi);
 * const ordinals = await api.listOrdinals();
 *
 * // Function-based usage
 * import { listOrdinals } from '@1sat/wallet-toolbox/api/ordinals';
 * const ordinals = await listOrdinals(cwi);
 * ```
 */

import type { WalletInterface, WalletOutput, ListOutputsArgs } from "@bsv/sdk";
import type { OneSatServices } from "../services/OneSatServices";

// Import from modules
import * as balance from "./balance";
import * as payments from "./payments";
import * as ordinals from "./ordinals";
import * as tokens from "./tokens";
import * as inscriptions from "./inscriptions";
import * as locks from "./locks";
import * as signing from "./signing";
import * as broadcast from "./broadcast";
import {
  ONESAT_MAINNET_CONTENT_URL,
  ONESAT_TESTNET_CONTENT_URL,
} from "./constants";

// Re-export types for convenience
export type { Balance, PaymentUtxo } from "./balance";
export type { SendBsvRequest, SendBsvResponse } from "./payments";
export type {
  TransferOrdinalRequest,
  ListOrdinalRequest,
  PurchaseOrdinalRequest,
  OrdinalOperationResponse,
} from "./ordinals";
export type { Bsv21Balance, SendBsv21Request, PurchaseBsv21Request, TokenOperationResponse } from "./tokens";
export type { InscribeRequest, InscribeResponse } from "./inscriptions";
export type { LockBsvRequest, LockData, LockOperationResponse } from "./locks";
export type {
  SignMessageRequest,
  SignedMessage,
} from "./signing";
export type { BroadcastRequest, BroadcastResponse } from "./broadcast";

export class OneSatApi {
  constructor(
    private cwi: WalletInterface,
    private services?: OneSatServices,
    private chain: "main" | "test" = "main",
    private wocApiKey?: string
  ) {}

  // ============ Balance ============

  getBalance() {
    return balance.getBalance(this.cwi, this.chain, this.wocApiKey);
  }

  getPaymentUtxos() {
    return balance.getPaymentUtxos(this.cwi);
  }

  getExchangeRate() {
    return balance.getExchangeRate(this.chain, this.wocApiKey);
  }

  // ============ Payments ============

  sendBsv(requests: payments.SendBsvRequest[]) {
    return payments.sendBsv(this.cwi, requests);
  }

  sendAllBsv(destination: string) {
    return payments.sendAllBsv(this.cwi, destination);
  }

  // ============ Ordinals ============

  /**
   * List ordinals from the 1sat basket.
   * Returns WalletOutput[] directly - use tags for metadata.
   */
  listOrdinals(options?: Partial<ListOutputsArgs>): Promise<WalletOutput[]> {
    return ordinals.listOrdinals(this.cwi, options);
  }

  buildTransferOrdinal(request: ordinals.TransferOrdinalRequest) {
    return ordinals.buildTransferOrdinal(this.cwi, request);
  }

  buildListOrdinal(request: ordinals.ListOrdinalRequest) {
    return ordinals.buildListOrdinal(this.cwi, request);
  }

  transferOrdinal(request: ordinals.TransferOrdinalRequest) {
    return ordinals.transferOrdinal(this.cwi, request);
  }

  listOrdinal(request: ordinals.ListOrdinalRequest) {
    return ordinals.listOrdinal(this.cwi, request);
  }

  cancelListing(outpoint: string) {
    return ordinals.cancelListing(this.cwi, outpoint);
  }

  purchaseOrdinal(request: ordinals.PurchaseOrdinalRequest) {
    return ordinals.purchaseOrdinal(this.cwi, request, this.services);
  }

  /**
   * Derive a cancel address for an ordinal listing.
   * Uses the outpoint as keyID with security level 1 (self-only).
   */
  deriveCancelAddress(outpoint: string): Promise<string> {
    return ordinals.deriveCancelAddress(this.cwi, outpoint);
  }

  // ============ Tokens ============

  /**
   * List BSV21 token outputs.
   * Returns WalletOutput[] directly - use tags for metadata.
   */
  listTokens(limit?: number): Promise<WalletOutput[]> {
    return tokens.listTokens(this.cwi, limit);
  }

  getBsv21Balances() {
    return tokens.getBsv21Balances(this.cwi);
  }

  sendBsv21(request: tokens.SendBsv21Request) {
    return tokens.sendBsv21(this.cwi, request, this.services);
  }

  purchaseBsv21(request: tokens.PurchaseBsv21Request) {
    return tokens.purchaseBsv21(this.cwi, request, this.services);
  }

  // ============ Inscriptions ============

  inscribe(request: inscriptions.InscribeRequest) {
    return inscriptions.inscribe(this.cwi, request);
  }

  // ============ Locks ============

  /**
   * List locked outputs.
   * Returns WalletOutput[] directly - use tags for metadata.
   */
  listLocks(limit?: number): Promise<WalletOutput[]> {
    return locks.listLocks(this.cwi, limit);
  }

  getLockData() {
    return locks.getLockData(this.cwi, this.chain, this.wocApiKey);
  }

  lockBsv(requests: locks.LockBsvRequest[]) {
    return locks.lockBsv(this.cwi, requests);
  }

  unlockBsv() {
    return locks.unlockBsv(this.cwi, this.chain, this.wocApiKey);
  }

  // ============ Signing ============

  signMessage(request: signing.SignMessageRequest) {
    return signing.signMessage(this.cwi, request);
  }

  // ============ Broadcast ============

  broadcast(request: broadcast.BroadcastRequest) {
    return broadcast.broadcast(this.cwi, request);
  }

  // ============ Utilities ============

  /**
   * Get the content URL for an inscription/ordinal.
   * Useful for displaying in img/video tags.
   * @param outpoint - Outpoint in format "txid_vout" (e.g., "abc123_0")
   */
  getContentUrl(outpoint: string): string {
    const contentBaseUrl = this.chain === "main"
      ? ONESAT_MAINNET_CONTENT_URL
      : ONESAT_TESTNET_CONTENT_URL;
    return `${contentBaseUrl}/${outpoint}`;
  }

  /**
   * Get the current block height from the CWI wallet.
   */
  async getBlockHeight(): Promise<number> {
    const result = await this.cwi.getHeight({});
    return result.height;
  }

}
