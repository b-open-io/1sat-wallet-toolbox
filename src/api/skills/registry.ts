/**
 * Skill registry for runtime discovery and MCP integration.
 */

import type { Skill, SkillCategory } from "./types";

// biome-ignore lint/suspicious/noExplicitAny: Registry needs to store skills with any input/output types
type AnySkill = Skill<any, any>;

/**
 * MCP-compatible tool definition.
 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: object;
}

/**
 * Registry for collecting and discovering skills at runtime.
 */
export class SkillRegistry {
  private skills = new Map<string, AnySkill>();

  /**
   * Register a skill.
   */
  register(skill: AnySkill): void {
    this.skills.set(skill.meta.name, skill);
  }

  /**
   * Register multiple skills.
   */
  registerAll(skills: AnySkill[]): void {
    for (const skill of skills) {
      this.register(skill);
    }
  }

  /**
   * Get a skill by name.
   */
  get(name: string): AnySkill | undefined {
    return this.skills.get(name);
  }

  /**
   * Check if a skill exists.
   */
  has(name: string): boolean {
    return this.skills.has(name);
  }

  /**
   * List all registered skills.
   */
  list(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * List skills by category.
   */
  listByCategory(category: SkillCategory): Skill[] {
    return this.list().filter((s) => s.meta.category === category);
  }

  /**
   * Get skill names.
   */
  names(): string[] {
    return Array.from(this.skills.keys());
  }

  /**
   * Convert to MCP-compatible tool list.
   * Prefixes names with "1sat__" for namespace isolation.
   */
  toMcpTools(): McpTool[] {
    return this.list().map((skill) => ({
      name: `1sat__${skill.meta.name}`,
      description: skill.meta.description,
      inputSchema: skill.meta.inputSchema,
    }));
  }

  /**
   * Number of registered skills.
   */
  get size(): number {
    return this.skills.size;
  }
}

/**
 * Global skill registry singleton.
 */
export const skillRegistry = new SkillRegistry();
