// Buffer polyfill must be first - before any other imports
import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") {
  (globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}

export {
  OneSatWallet,
  type OneSatWalletArgs,
  type OneSatWalletEvents,
  type IngestResult,
} from "./OneSatWallet";
export { OneSatServices, type SyncOutput } from "./services/OneSatServices";
export type { OrdfsMetadata, Capability } from "./services/types";
export * from "./services/client";
export { ReadOnlySigner } from "./signers/ReadOnlySigner";

// Indexers
export * from "./indexers";
