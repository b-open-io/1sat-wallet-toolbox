// Buffer polyfill must be first - before any other imports
import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") {
  (globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}

export {
  OneSatWallet,
  type OneSatWalletArgs,
  type OneSatWalletEvents,
  type SyncStartEvent,
  type SyncProgressEvent,
  type SyncTxEvent,
  type SyncErrorEvent,
  type SyncCompleteEvent,
} from "./OneSatWallet";
export { OneSatServices, type OrdfsMetadata } from "./services/OneSatServices";
export { ReadOnlySigner } from "./signers/ReadOnlySigner";

// Indexers
export * from "./indexers";

// Re-export commonly used types from wallet-toolbox (mobile/client version for browser compatibility)
export { WalletStorageManager } from "@bsv/wallet-toolbox/mobile";
export { StorageIdb } from "@bsv/wallet-toolbox/mobile/out/src/storage/StorageIdb";
export type { Chain } from "@bsv/wallet-toolbox/mobile/out/src/sdk/types";
