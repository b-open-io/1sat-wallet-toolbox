// Buffer polyfill must be first - before any other imports
import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") {
  (globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}

// API Layer - The new unified API for 1sat ecosystem
export * from "./api";

// Services
export { OneSatServices, type SyncOutput } from "./services/OneSatServices";
export type {
  IndexedOutput,
  OrdfsMetadata,
  OrdfsContentOptions,
  OrdfsContentResponse,
  OrdfsResponseHeaders,
  Capability,
} from "./services/types";
export * from "./services/client";
export { ReadOnlySigner } from "./signers/ReadOnlySigner";

// Indexers
export * from "./indexers";

// Sync Queue
export * from "./sync";

// CWI (Chrome Wallet Interface) - BRC-100 implementations
export * from "./cwi";

// Wallet factory for creating 1Sat web wallets
export * from "./wallet";
