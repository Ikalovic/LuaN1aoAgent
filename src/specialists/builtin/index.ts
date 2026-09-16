import type { SpecialistAgentDefinition } from "../types.js";
import { GENERAL_SPECIALIST_ID, generalSpecialist } from "./general.js";
import { BRUTEFORCE_SPECIALIST_ID, bruteforceSpecialist } from "./bruteforce.js";

export { GENERAL_SPECIALIST_ID, generalSpecialist } from "./general.js";
export { BRUTEFORCE_SPECIALIST_ID, bruteforceSpecialist } from "./bruteforce.js";

/** Specialists shipped with the runtime, in catalog display order. */
export function builtinSpecialists(): SpecialistAgentDefinition[] {
  return [generalSpecialist, bruteforceSpecialist];
}

/** Built-in Specialists that must always stay enabled and loadable. */
export const REQUIRED_SPECIALIST_IDS: readonly string[] = [GENERAL_SPECIALIST_ID];

export { BRUTEFORCE_SPECIALIST_ID as EXAMPLE_SPECIALIST_ID };
