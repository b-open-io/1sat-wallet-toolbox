/**
 * 1Sat Wallet Toolbox API Layer
 *
 * This module provides skills (self-describing actions) for interacting with the 1Sat ecosystem.
 * All skills work with any BRC-100 compatible wallet interface via OneSatContext.
 *
 * Usage:
 * ```typescript
 * import { createContext, transferOrdinals, skillRegistry } from '@1sat/wallet-toolbox/api';
 *
 * // Create context with a BRC-100 compatible wallet
 * const ctx = createContext(wallet, { services, chain: 'main' });
 *
 * // Execute skills directly
 * const result = await transferOrdinals.execute(ctx, { transfers: [...], inputBEEF: [...] });
 *
 * // Or via registry (useful for AI agents)
 * const skill = skillRegistry.get('transferOrdinals');
 * const result = await skill.execute(ctx, { transfers: [...], inputBEEF: [...] });
 *
 * // Get MCP-compatible tool list
 * const tools = skillRegistry.toMcpTools();
 * ```
 */

// Export skill types and helpers
export {
  type OneSatContext,
  type Skill,
  type SkillMetadata,
  type SkillCategory,
  type JsonSchemaProperty,
  createContext,
} from "./skills/types";

// Export skill registry
export { SkillRegistry, skillRegistry, type McpTool } from "./skills/registry";

// Export constants
export * from "./constants";

// Export module skills and types
export * from "./balance";
export * from "./payments";
export * from "./ordinals";
export * from "./tokens";
export * from "./inscriptions";
export * from "./locks";
export * from "./signing";
export * from "./broadcast";

// Export sweep module (uses external signing, not skill-based)
export * from "./sweep";

import { balanceSkills } from "./balance";
import { broadcastSkills } from "./broadcast";
import { inscriptionsSkills } from "./inscriptions";
import { locksSkills } from "./locks";
import { ordinalsSkills } from "./ordinals";
import { paymentsSkills } from "./payments";
import { signingSkills } from "./signing";
// Register all skills with the global registry
import { skillRegistry } from "./skills/registry";
import { sweepSkills } from "./sweep";
import { tokensSkills } from "./tokens";

skillRegistry.registerAll([
  ...balanceSkills,
  ...paymentsSkills,
  ...ordinalsSkills,
  ...tokensSkills,
  ...inscriptionsSkills,
  ...locksSkills,
  ...signingSkills,
  ...broadcastSkills,
  ...sweepSkills,
]);

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
