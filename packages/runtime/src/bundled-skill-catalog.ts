import { GENERATED_BUNDLED_SKILL_SOURCES } from './bundled-skill-catalog.generated.js';

export interface BundledSkillSource {
  readonly id: string;
  readonly body: string;
}

export const BUNDLED_SKILL_CATALOG: readonly BundledSkillSource[] = Object.freeze(
  GENERATED_BUNDLED_SKILL_SOURCES.map((source) => Object.freeze(source)),
);

export function getBundledSkillSource(id: string): BundledSkillSource | undefined {
  return BUNDLED_SKILL_CATALOG.find((source) => source.id === id);
}
