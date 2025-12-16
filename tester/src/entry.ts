// Entry point that sets up polyfills before loading the app
import { Buffer } from "buffer";
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;

// Now dynamically import the main app
import("./main.js");
