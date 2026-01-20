/**
 * Core types for the skill/action pattern.
 */

import type { WalletInterface } from "@bsv/sdk";
import type { OneSatServices } from "../../services/OneSatServices";

/**
 * Context passed to all skills.
 * Contains the wallet and optional services for backend operations.
 */
export interface OneSatContext {
  /** BRC-100 compatible wallet interface */
  wallet: WalletInterface;
  /** Optional services for operations requiring backend (purchases, lookups) */
  services?: OneSatServices;
  /** Network chain */
  chain: "main" | "test";
  /** Optional WhatsOnChain API key */
  wocApiKey?: string;
}

/**
 * JSON Schema property definition for skill input schemas.
 */
export interface JsonSchemaProperty {
  type: "string" | "number" | "integer" | "boolean" | "object" | "array";
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/**
 * Skill category for grouping related operations.
 */
export type SkillCategory =
  | "balance"
  | "payments"
  | "ordinals"
  | "tokens"
  | "inscriptions"
  | "locks"
  | "signing"
  | "broadcast"
  | "sweep";

/**
 * Metadata describing a skill for AI agents and tooling.
 */
export interface SkillMetadata<TInput = unknown> {
  /** Unique skill name */
  name: string;
  /** Human-readable description of what the skill does */
  description: string;
  /** Category for grouping */
  category: SkillCategory;
  /** JSON Schema for the input parameters (MCP-compatible) */
  inputSchema: {
    type: "object";
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
  /** Whether this skill requires OneSatServices to be provided in context */
  requiresServices?: boolean;
}

/**
 * A skill is a self-describing action that can be executed with a context.
 */
export interface Skill<TInput = unknown, TOutput = unknown> {
  /** Metadata describing the skill */
  meta: SkillMetadata<TInput>;
  /** Execute the skill with context and input */
  execute: (ctx: OneSatContext, input: TInput) => Promise<TOutput>;
}

/**
 * Helper to create a context object from a wallet and options.
 */
export function createContext(
  wallet: WalletInterface,
  options?: {
    services?: OneSatServices;
    chain?: "main" | "test";
    wocApiKey?: string;
  },
): OneSatContext {
  return {
    wallet,
    services: options?.services,
    chain: options?.chain ?? "main",
    wocApiKey: options?.wocApiKey,
  };
}
