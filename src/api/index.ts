/**
 * 1Sat Wallet Toolbox API Layer
 *
 * This module provides the OneSatApi class for interacting with the 1Sat ecosystem.
 * All methods work with any BRC-100 compatible wallet interface (CWI).
 *
 * Usage:
 * ```typescript
 * import { OneSatApi } from '@1sat/wallet-toolbox';
 *
 * // Create API instance with a CWI-compatible wallet
 * const api = new OneSatApi(cwi);
 *
 * // Use the API
 * const balance = await api.getBalance();
 * const ordinals = await api.listOrdinals();
 * const result = await api.sendBsv([{ address: '...', satoshis: 1000 }]);
 * ```
 *
 * You can also import functions directly from modules:
 * ```typescript
 * import { listOrdinals } from '@1sat/wallet-toolbox/api/ordinals';
 * import { sendBsv } from '@1sat/wallet-toolbox/api/payments';
 * ```
 */

// Export the main API class
export { OneSatApi } from "./OneSatApi";

// Export constants
export * from "./constants";

// Export module functions and types
export * from "./balance";
export * from "./payments";
export * from "./ordinals";
export * from "./tokens";
export * from "./inscriptions";
export * from "./locks";
export * from "./signing";
export * from "./broadcast";

// Re-export SDK types that consumers commonly need
export type {
  WalletInterface,
  WalletOutput,
  CreateActionArgs,
  CreateActionResult,
  CreateActionOutput,
  CreateActionInput,
  ListOutputsResult,
  ListOutputsArgs,
} from "@bsv/sdk";
