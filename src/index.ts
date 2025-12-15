// Buffer polyfill must be first - before any other imports
import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") {
  (globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}

export { OneSatWallet, type OneSatWalletArgs, type IngestResult } from "./OneSatWallet";
export { type ParseResult, type ParsedOutput } from "./indexers/TransactionParser";
export {
  OneSatServices,
  type OrdfsMetadata,
  type SyncOutput,
  type OneSatServicesEvents,
} from "./services/OneSatServices";
export { ReadOnlySigner } from "./signers/ReadOnlySigner";

// Indexers
export * from "./indexers";

// Re-export commonly used types from wallet-toolbox (mobile/client version for browser compatibility)
export { WalletStorageManager } from "@bsv/wallet-toolbox/mobile";
export { StorageIdb } from "@bsv/wallet-toolbox/mobile/out/src/storage/StorageIdb";
export type { Chain } from "@bsv/wallet-toolbox/mobile/out/src/sdk/types";
