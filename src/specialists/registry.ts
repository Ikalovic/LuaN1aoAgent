import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { builtinSpecialists, GENERAL_SPECIALIST_ID, REQUIRED_SPECIALIST_IDS } from "./builtin/index.js";
import {
  optionAuthorDefault,
  plannerTunableOptions,
  isSpecialistOptionsMode,
  resolveSpecialistOptions,
  valuesEqual,
  type ResolvedSpecialistOptions
} from "./options.js";
import { specialistPromptPlaceholderDiagnostics } from "./prompt.js";
import {
  validateSpecialistDefinition,
  SPECIALIST_MODULE_API
} from "./sdk.js";
import { specialistToolGroupScope } from "./tools.js";
import {
  DEFAULT_SPECIALIST_BUDGET,
  SPECIALIST_OPTIONS_MODES,
  isSpecialistId,
  type RegisteredSpecialist,
  type RegisteredSpecialistOption,
  type SpecialistAgentDefinition,
  type SpecialistBudgetProfile,
  type SpecialistCatalogEntry,
  type SpecialistOptionPolicyMap,
  type SpecialistOptionsMode,
  type SpecialistRegistryDiagnostic,
  type SpecialistRegistrySnapshot,
  type SpecialistResolution
} from "./types.js";

const MAX_PROMPT_FILE_BYTES = 256 * 1024;
const EPOCH = new Date(0).toISOString();
const MODULE_EXTENSIONS = new Set([".mjs", ".js"]);

/**
 * Option diagnostics that make a write fail instead of being clamped away.
 * Bounds diagnostics are excluded on purpose: clamping to the author's envelope
 * is the designed behaviour, not an error.
 */
const REJECTED_OPTION_DIAGNOSTICS = new Set([
  "specialist_option_unknown",
  "specialist_option_invalid",
  "specialist_option_not_editable",
  "specialist_option_bound_below_minimum",
  "specialist_option_bound_excludes_all"
]);

export class SpecialistOptionError extends Error {
  constructor(message: string, readonly diagnostics: SpecialistRegistryDiagnostic[] = []) {
    super(message);
    this.name = "SpecialistOptionError";
  }
}

export type SpecialistRegistryOptions = {
  cwd: string;
  builtins?: SpecialistAgentDefinition[];
  /** Defaults to <cwd>/.agents/specialists */
  projectDir?: string;
  /** Defaults to <cwd>/.agents/specialists-state.json */
  statePath?: string;
  requiredIds?: readonly string[];
};

type SpecialistStateEntry = {
  enabled?: boolean;
  /** Operator-chosen authority mode for the whole Agent. */
  optionsMode?: unknown;
  options?: Record<string, unknown>;
};

type ProjectManifest = {
  id?: unknown;
  enabled?: unknown;
  entry?: unknown;
  name?: unknown;
  description?: unknown;
  whenToUse?: unknown;
  version?: unknown;
  prompt?: { mode?: unknown; content?: unknown; file?: unknown };
  tools?: unknown;
  skills?: unknown;
  budget?: unknown;
  model?: unknown;
  concurrency?: unknown;
  options?: unknown;
};

type SpecialistSourceEntry = {
  id: string;
  source: "builtin" | "project";
  dir?: string;
  /** Present for built-ins, manifest-only project agents and loaded modules. */
  definition?: SpecialistAgentDefinition;
  manifest?: ProjectManifest;
  entryPath?: string;
  diagnostics: SpecialistRegistryDiagnostic[];
  /** Set when the definition was produced by executing a project module. */
  moduleLoaded?: boolean;
  moduleLoadDiagnostics?: SpecialistRegistryDiagnostic[];
};

/**
 * Registry of Specialist Agents: built-ins declared through the TypeScript SDK
 * plus project-level `.agents/specialists/<id>/` manifests and modules.
 *
 * Module code is only imported for agents that are enabled, so a disabled
 * project agent never runs inside the runtime process.
 */
export class SpecialistRegistry {
  private current: SpecialistRegistrySnapshot = { scannedAt: EPOCH, specialists: [], diagnostics: [] };
  private sources: SpecialistSourceEntry[] = [];
  private sourcesScannedAt = EPOCH;
  private readonly cwd: string;
  private readonly builtins: SpecialistAgentDefinition[];
  private readonly projectDir: string;
  private readonly statePath: string;
  private readonly requiredIds: Set<string>;

  constructor(options: SpecialistRegistryOptions) {
    this.cwd = options.cwd;
    this.builtins = options.builtins ?? builtinSpecialists();
    this.projectDir = options.projectDir ?? join(options.cwd, ".agents", "specialists");
    this.statePath = options.statePath ?? join(options.cwd, ".agents", "specialists-state.json");
    this.requiredIds = new Set(options.requiredIds ?? REQUIRED_SPECIALIST_IDS);
  }

  /** Synchronous view that never executes project module code. */
  scan(): SpecialistRegistrySnapshot {
    this.ensureSources();
    return this.buildSnapshot();
  }

  snapshot(): SpecialistRegistrySnapshot {
    return this.current.scannedAt === EPOCH ? this.scan() : this.current;
  }

  /** Full view: imports enabled project modules so option schemas are known. */
  async describeAll(): Promise<SpecialistRegistrySnapshot> {
    this.ensureSources();
    for (const entry of this.sources) {
      if (!entry.entryPath) continue;
      if (!this.isEnabled(entry)) continue;
      await this.loadModule(entry);
    }
    this.current = this.buildSnapshot();
    return this.current;
  }

  /**
   * Fresh, synchronous availability index (enabled/valid/unknown) that never
   * executes project module code. Used for planner-visible Task status.
   */
  statusIndex(): Record<string, "ready" | "disabled" | "invalid"> {
    this.ensureSources();
    const state = this.readState();
    const index: Record<string, "ready" | "disabled" | "invalid"> = {};
    for (const entry of this.sources) {
      const blocking = [...entry.diagnostics, ...(entry.moduleLoadDiagnostics ?? [])].some(isBlockingDiagnostic);
      index[entry.id] = blocking ? "invalid" : this.isEnabled(entry, state[entry.id]) ? "ready" : "disabled";
    }
    return index;
  }

  /**
   * Synchronous budget profile used to clamp Planner budget patches. Returns
   * undefined when the Specialist is unknown or its module is not loaded yet.
   */
  budgetProfile(id: string): SpecialistBudgetProfile | undefined {
    this.ensureSources();
    const entry = this.sources.find((candidate) => candidate.id === id);
    if (!entry) return undefined;
    return entry.definition?.budget ?? this.manifestBudget(entry);
  }

  /** Resolves one Specialist for execution. Authoritative: loads its module if needed. */
  async resolve(id: string): Promise<SpecialistResolution> {
    this.ensureSources();
    const entry = this.sources.find((candidate) => candidate.id === id);
    if (!entry) {
      return {
        ok: false,
        id,
        reason: "unknown",
        message: `Unknown Specialist "${id}". Available: ${this.sources.map((candidate) => candidate.id).sort().join(", ") || "none"}`
      };
    }
    const enabled = this.isEnabled(entry);
    if (entry.entryPath && enabled) await this.loadModule(entry);
    const definition = entry.definition;
    const entryView = this.toRegistered(entry);
    if (!enabled) {
      return {
        ok: false,
        id,
        reason: "disabled",
        message: `Specialist "${id}" is disabled; enable it or create the Task with an enabled Specialist`,
        entry: entryView
      };
    }
    if (!definition) {
      const loadFailure = (entry.moduleLoadDiagnostics ?? []).find((diagnostic) => diagnostic.code === "specialist_module_failed");
      return {
        ok: false,
        id,
        reason: loadFailure ? "load_failed" : "invalid",
        message: loadFailure?.message ?? `Specialist "${id}" has no loadable definition`,
        entry: entryView
      };
    }
    const diagnostics = [...entry.diagnostics, ...(entry.moduleLoadDiagnostics ?? [])];
    const blocking = diagnostics.filter(isBlockingDiagnostic);
    if (blocking.length > 0 || !entryView.valid) {
      return {
        ok: false,
        id,
        reason: "invalid",
        message: `Specialist "${id}" is invalid: ${blocking.map((diagnostic) => diagnostic.message).join("; ") || "registry diagnostics"}`,
        entry: entryView
      };
    }
    const state = this.readState()[id];
    const resolved = resolveSpecialistOptions(definition, state?.options, state?.optionsMode);
    return {
      ok: true,
      id,
      definition,
      options: resolved.values,
      optionPolicies: resolved.policies,
      entry: entryView,
      diagnostics: [...diagnostics, ...resolved.diagnostics, ...specialistPromptPlaceholderDiagnostics(definition)]
    };
  }

  /** Enabled, valid and fully introspected Specialists, for the Planner catalog. */
  async catalog(): Promise<SpecialistCatalogEntry[]> {
    const snapshot = await this.describeAll();
    const state = this.readState();
    return snapshot.specialists
      .filter((specialist) => specialist.enabled && specialist.valid && specialist.introspected)
      .map((specialist) => {
        const definition = this.sources.find((entry) => entry.id === specialist.id)?.definition;
        const source = state[specialist.id];
        const resolved = definition
          ? resolveSpecialistOptions(definition, source?.options, source?.optionsMode)
          : undefined;
        const tunable = resolved ? plannerTunableOptions(resolved.policies) : undefined;
        return {
          id: specialist.id,
          name: specialist.name,
          description: specialist.description,
          ...(specialist.whenToUse ? { whenToUse: specialist.whenToUse } : {}),
          budget: specialist.budget,
          skillMode: specialist.skillMode,
          disabledToolGroups: specialist.disabledGroups,
          ...(specialist.concurrency?.maxParallelTasks !== undefined
            ? { maxParallelTasks: specialist.concurrency.maxParallelTasks }
            : {}),
          ...(tunable ? { tunableOptions: tunable } : {})
        };
      });
  }

  async setEnabled(id: string, enabled: boolean): Promise<RegisteredSpecialist> {
    this.ensureSources();
    const entry = this.sources.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`Unknown Specialist: ${id}`);
    if (!enabled && this.requiredIds.has(id)) {
      throw new SpecialistOptionError(`Specialist "${id}" is required by the runtime and cannot be disabled`);
    }
    const state = this.readState();
    state[id] = { ...state[id], enabled };
    this.writeState(state);
    const snapshot = await this.describeAll();
    const updated = snapshot.specialists.find((specialist) => specialist.id === id);
    if (!updated) throw new Error(`Unknown Specialist: ${id}`);
    return updated;
  }

  async setOptions(id: string, options: unknown): Promise<RegisteredSpecialist> {
    this.ensureSources();
    const entry = this.sources.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`Unknown Specialist: ${id}`);
    if (entry.entryPath && this.isEnabled(entry)) await this.loadModule(entry);
    const definition = entry.definition;
    if (!definition) throw new SpecialistOptionError(`Specialist "${id}" has no loadable definition`);
    const state = this.readState();
    const resolved = resolveSpecialistOptions(definition, options, state[id]?.optionsMode);
    // Author-owned options are the Specialists' capability envelope. Writing one
    // is rejected outright rather than silently ignored, so the capability page
    // cannot appear to have loosened a limit it never controlled.
    const rejected = resolved.diagnostics.filter((diagnostic) => REJECTED_OPTION_DIAGNOSTICS.has(diagnostic.code));
    if (rejected.length > 0) {
      throw new SpecialistOptionError(
        `Invalid options for Specialist "${id}": ${rejected.map((diagnostic) => diagnostic.message).join("; ")}`,
        rejected
      );
    }
    // Persist the clamped, authority-appropriate slice: the raw body is never
    // stored, so a stale state file cannot carry a value past the current
    // definition's bounds.
    state[id] = { ...state[id], options: { ...resolved.userValues } };
    if (Object.keys(state[id]!.options ?? {}).length === 0) delete state[id]!.options;
    this.writeState(state);
    const snapshot = await this.describeAll();
    const updated = snapshot.specialists.find((specialist) => specialist.id === id);
    if (!updated) throw new Error(`Unknown Specialist: ${id}`);
    return updated;
  }

  /**
   * Switches the Agent-wide option authority mode. Per-option overrides still
   * tighten on top, and author bounds are never widened by a mode change.
   */
  async setOptionsMode(id: string, mode: unknown): Promise<RegisteredSpecialist> {
    this.ensureSources();
    const entry = this.sources.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`Unknown Specialist: ${id}`);
    if (entry.entryPath && this.isEnabled(entry)) await this.loadModule(entry);
    const definition = entry.definition;
    if (!definition) throw new SpecialistOptionError(`Specialist "${id}" has no loadable definition`);
    const authorMode: SpecialistOptionsMode = definition.optionsMode ?? "planner";
    if (mode === authorMode || mode === undefined || mode === null) {
      const state = this.readState();
      if (state[id]?.optionsMode !== undefined) {
        delete state[id]!.optionsMode;
        if (Object.keys(state[id]!).length === 0) delete state[id];
        this.writeState(state);
      }
    } else if (isSpecialistOptionsMode(mode)) {
      const state = this.readState();
      // Re-normalize on mode change: a number stored as a value can become a
      // boundary, so it must be clamped under the new interpretation.
      const resolved = resolveSpecialistOptions(definition, state[id]?.options, mode);
      state[id] = { ...state[id], optionsMode: mode, options: { ...resolved.userValues } };
      if (Object.keys(state[id]!.options ?? {}).length === 0) delete state[id]!.options;
      this.writeState(state);
    } else {
      throw new SpecialistOptionError(
        `Invalid options mode for Specialist "${id}": expected one of ${SPECIALIST_OPTIONS_MODES.join(", ")}`
      );
    }
    const snapshot = await this.describeAll();
    const updated = snapshot.specialists.find((specialist) => specialist.id === id);
    if (!updated) throw new Error(`Unknown Specialist: ${id}`);
    return updated;
  }

  private ensureSources(): void {
    const signature = this.projectSignature();
    if (this.sourcesScannedAt !== EPOCH && signature === this.sourcesScannedAt) return;
    this.sources = [];
    for (const definition of this.builtins) {
      this.sources.push({
        id: definition.id,
        source: "builtin",
        definition,
        diagnostics: []
      });
    }
    this.sources.push(...this.scanProjectSources());
    const seen = new Set<string>();
    for (const entry of this.sources) {
      if (seen.has(entry.id)) {
        entry.diagnostics.push({
          code: "specialist_duplicate_id",
          message: `Specialist id "${entry.id}" is declared more than once; the project entry is ignored`,
          specialistId: entry.id
        });
      }
      seen.add(entry.id);
    }
    this.sources = this.sources.filter((entry, index) => this.sources.findIndex((candidate) => candidate.id === entry.id) === index);
    this.sourcesScannedAt = signature;
  }

  /**
   * Cheap change detector for the project directory. The state file is read on
   * every resolve/describe call, so only definition files need invalidation.
   */
  private projectSignature(): string {
    if (!existsSync(this.projectDir)) return "absent";
    try {
      const parts: string[] = [realpathSync(this.projectDir)];
      for (const name of readdirSync(this.projectDir).sort()) {
        const dir = join(this.projectDir, name);
        let stats: ReturnType<typeof statSync>;
        try {
          stats = statSync(dir);
        } catch {
          continue;
        }
        if (!stats.isDirectory()) continue;
        parts.push(`${name}:${stats.mtimeMs}`);
        const tracked = ["specialist.json", "prompt.md", ...readdirSync(dir).filter((file) => MODULE_EXTENSIONS.has(extname(file).toLowerCase()))];
        for (const file of tracked) {
          const path = join(dir, file);
          if (!existsSync(path)) continue;
          try {
            parts.push(`${name}/${file}:${statSync(path).mtimeMs}`);
          } catch {
            // ignore unreadable file metadata; parsing reports the real problem
          }
        }
      }
      return parts.join("|");
    } catch {
      return `unreadable:${Date.now()}`;
    }
  }

  private scanProjectSources(): SpecialistSourceEntry[] {
    const entries: SpecialistSourceEntry[] = [];
    if (!existsSync(this.projectDir)) return entries;
    let names: string[];
    try {
      names = readdirSync(this.projectDir).sort();
    } catch {
      return entries;
    }
    for (const name of names) {
      const dir = join(this.projectDir, name);
      let isDirectory = false;
      try {
        isDirectory = statSync(dir).isDirectory();
      } catch {
        isDirectory = false;
      }
      if (!isDirectory) continue;
      const manifestPath = join(dir, "specialist.json");
      if (!existsSync(manifestPath)) {
        entries.push({
          id: name,
          source: "project",
          dir,
          diagnostics: [{
            code: "specialist_manifest_missing",
            message: `Specialist directory ${name} has no specialist.json`,
            specialistId: name,
            path: manifestPath
          }]
        });
        continue;
      }
      entries.push(this.readProjectEntry(name, dir, manifestPath));
    }
    return entries;
  }

  private readProjectEntry(directoryName: string, dir: string, manifestPath: string): SpecialistSourceEntry {
    const diagnostics: SpecialistRegistryDiagnostic[] = [];
    let manifest: ProjectManifest;
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("manifest must be a JSON object");
      }
      manifest = parsed as ProjectManifest;
    } catch (error) {
      return {
        id: directoryName,
        source: "project",
        dir,
        diagnostics: [{
          code: "specialist_manifest_invalid",
          message: `Specialist ${directoryName} specialist.json is invalid: ${error instanceof Error ? error.message : String(error)}`,
          specialistId: directoryName,
          path: manifestPath
        }]
      };
    }
    const id = typeof manifest.id === "string" ? manifest.id : directoryName;
    if (!isSpecialistId(id)) {
      diagnostics.push({
        code: "specialist_id_invalid",
        message: `Specialist id "${id}" must match ^[a-z0-9]+(-[a-z0-9]+)*$`,
        specialistId: directoryName,
        path: manifestPath
      });
    }
    if (id !== directoryName) {
      diagnostics.push({
        code: "specialist_id_invalid",
        message: `Specialist id "${id}" must equal its directory name "${directoryName}"`,
        specialistId: id,
        path: manifestPath
      });
    }
    const entryPath = this.resolveEntryPath(dir, manifest.entry, id, diagnostics);
    if (entryPath) {
      return { id, source: "project", dir, manifest, entryPath, diagnostics };
    }
    if (manifest.entry !== undefined) {
      // Invalid entry declaration: report it and stay manifest-only.
      return { id, source: "project", dir, manifest, diagnostics };
    }
    const definition = this.definitionFromManifest(manifest, id, dir, diagnostics);
    return { id, source: "project", dir, manifest, ...(definition ? { definition } : {}), diagnostics };
  }

  private definitionFromManifest(
    manifest: ProjectManifest,
    id: string,
    dir: string,
    diagnostics: SpecialistRegistryDiagnostic[]
  ): SpecialistAgentDefinition | undefined {
    const prompt = manifest.prompt;
    let content = "";
    if (prompt && typeof prompt === "object") {
      if (typeof prompt.content === "string") content = prompt.content;
      else if (typeof prompt.file === "string") {
        const promptPath = this.resolveContainedFile(dir, prompt.file, id, diagnostics, "prompt file");
        if (promptPath) {
          try {
            const stats = statSync(promptPath);
            if (stats.size > MAX_PROMPT_FILE_BYTES) {
              diagnostics.push({
                code: "specialist_manifest_invalid",
                message: `Specialist ${id} prompt file exceeds ${MAX_PROMPT_FILE_BYTES} bytes`,
                specialistId: id,
                path: promptPath
              });
            } else {
              content = readFileSync(promptPath, "utf8");
            }
          } catch (error) {
            diagnostics.push({
              code: "specialist_manifest_invalid",
              message: `Specialist ${id} prompt file is unreadable: ${error instanceof Error ? error.message : String(error)}`,
              specialistId: id,
              path: promptPath
            });
          }
        }
      } else {
        diagnostics.push({
          code: "specialist_manifest_invalid",
          message: `Specialist ${id} prompt requires "content" or "file"`,
          specialistId: id
        });
      }
    } else {
      diagnostics.push({
        code: "specialist_manifest_invalid",
        message: `Specialist ${id} requires a prompt object`,
        specialistId: id
      });
    }
    const mode = prompt && typeof prompt === "object" && (prompt.mode === "replace" || prompt.mode === "extend")
      ? prompt.mode
      : "extend";
    const candidate = {
      id,
      name: typeof manifest.name === "string" ? manifest.name : id,
      description: typeof manifest.description === "string" ? manifest.description : "",
      ...(typeof manifest.whenToUse === "string" ? { whenToUse: manifest.whenToUse } : {}),
      ...(typeof manifest.version === "string" ? { version: manifest.version } : {}),
      prompt: { mode, content },
      ...(manifest.tools !== undefined ? { tools: manifest.tools } : {}),
      ...(manifest.skills !== undefined ? { skills: manifest.skills } : {}),
      budget: manifest.budget ?? { ...DEFAULT_SPECIALIST_BUDGET },
      ...(manifest.model !== undefined ? { model: manifest.model } : {}),
      ...(manifest.concurrency !== undefined ? { concurrency: manifest.concurrency } : {}),
      ...(manifest.options !== undefined ? { options: manifest.options } : {})
    } as SpecialistAgentDefinition;
    diagnostics.push(...validateSpecialistDefinition(candidate));
    return diagnostics.some((diagnostic) => diagnostic.code !== "specialist_prompt_placeholder_unknown")
      ? undefined
      : candidate;
  }

  private resolveEntryPath(
    dir: string,
    entry: unknown,
    id: string,
    diagnostics: SpecialistRegistryDiagnostic[]
  ): string | undefined {
    if (entry === undefined) return undefined;
    if (typeof entry !== "string" || entry.length === 0) {
      diagnostics.push({
        code: "specialist_manifest_invalid",
        message: `Specialist ${id} entry must be a non-empty relative path`,
        specialistId: id
      });
      return undefined;
    }
    if (!MODULE_EXTENSIONS.has(extname(entry).toLowerCase())) {
      diagnostics.push({
        code: "specialist_entry_extension",
        message: `Specialist ${id} entry must be a .mjs or .js module`,
        specialistId: id
      });
      return undefined;
    }
    const absolute = resolve(dir, entry);
    if (!isInside(absolute, resolve(dir))) {
      diagnostics.push({
        code: "specialist_entry_outside_root",
        message: `Specialist ${id} entry must stay inside its own directory`,
        specialistId: id,
        path: absolute
      });
      return undefined;
    }
    if (!existsSync(absolute)) {
      diagnostics.push({
        code: "specialist_manifest_invalid",
        message: `Specialist ${id} entry does not exist`,
        specialistId: id,
        path: absolute
      });
      return undefined;
    }
    try {
      const canonical = realpathSync(absolute);
      if (!isInside(canonical, realpathSync(dir))) {
        diagnostics.push({
          code: "specialist_entry_outside_root",
          message: `Specialist ${id} entry resolves outside its own directory`,
          specialistId: id,
          path: canonical
        });
        return undefined;
      }
      return canonical;
    } catch (error) {
      diagnostics.push({
        code: "specialist_manifest_invalid",
        message: `Specialist ${id} entry is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        specialistId: id
      });
      return undefined;
    }
  }

  private resolveContainedFile(
    dir: string,
    relative: string,
    id: string,
    diagnostics: SpecialistRegistryDiagnostic[],
    label: string
  ): string | undefined {
    const absolute = resolve(dir, relative);
    if (!isInside(absolute, resolve(dir))) {
      diagnostics.push({
        code: "specialist_entry_outside_root",
        message: `Specialist ${id} ${label} must stay inside its own directory`,
        specialistId: id,
        path: absolute
      });
      return undefined;
    }
    if (!existsSync(absolute)) {
      diagnostics.push({
        code: "specialist_manifest_invalid",
        message: `Specialist ${id} ${label} does not exist`,
        specialistId: id,
        path: absolute
      });
      return undefined;
    }
    try {
      const canonical = realpathSync(absolute);
      if (!isInside(canonical, realpathSync(dir))) {
        diagnostics.push({
          code: "specialist_entry_outside_root",
          message: `Specialist ${id} ${label} resolves outside its own directory`,
          specialistId: id,
          path: canonical
        });
        return undefined;
      }
      return canonical;
    } catch {
      return undefined;
    }
  }

  /**
   * Imports a project module. Trusted code by design: the runtime validates the
   * path and the exported shape, but executes it in-process once enabled.
   */
  private async loadModule(entry: SpecialistSourceEntry): Promise<void> {
    if (!entry.entryPath || entry.moduleLoaded) return;
    entry.moduleLoaded = true;
    entry.moduleLoadDiagnostics = [];
    let moduleNamespace: Record<string, unknown>;
    try {
      const version = statSync(entry.entryPath).mtimeMs;
      moduleNamespace = await import(`${pathToFileURL(entry.entryPath).href}?v=${version}`) as Record<string, unknown>;
    } catch (error) {
      entry.moduleLoadDiagnostics.push({
        code: "specialist_module_failed",
        message: `Specialist ${entry.id} module failed to load: ${error instanceof Error ? error.message : String(error)}`,
        specialistId: entry.id,
        path: entry.entryPath
      });
      return;
    }
    const exported = moduleNamespace.default ?? moduleNamespace.specialist;
    let candidate: unknown = exported;
    if (typeof exported === "function") {
      try {
        candidate = (exported as (api: unknown) => unknown)(SPECIALIST_MODULE_API);
      } catch (error) {
        entry.moduleLoadDiagnostics.push({
          code: "specialist_module_failed",
          message: `Specialist ${entry.id} module factory threw: ${error instanceof Error ? error.message : String(error)}`,
          specialistId: entry.id,
          path: entry.entryPath
        });
        return;
      }
    }
    const diagnostics = validateSpecialistDefinition(candidate);
    if (typeof (candidate as { id?: unknown } | undefined)?.id === "string"
      && (candidate as { id: string }).id !== entry.id) {
      diagnostics.push({
        code: "specialist_manifest_invalid",
        message: `Specialist module id "${(candidate as { id: string }).id}" must equal its directory id "${entry.id}"`,
        specialistId: entry.id,
        path: entry.entryPath
      });
    }
    if (diagnostics.length > 0) {
      entry.moduleLoadDiagnostics.push(...diagnostics.map((diagnostic) => ({
        ...diagnostic,
        code: diagnostic.code === "specialist_manifest_invalid" ? "specialist_module_invalid_export" : diagnostic.code
      })));
      return;
    }
    entry.definition = candidate as SpecialistAgentDefinition;
    entry.moduleLoadDiagnostics.push({
      code: "specialist_module_loaded",
      message: `Specialist ${entry.id} module loaded`,
      specialistId: entry.id,
      path: entry.entryPath
    });
  }

  private buildSnapshot(): SpecialistRegistrySnapshot {
    const specialists = this.sources
      .map((entry) => this.toRegistered(entry))
      .sort((left, right) => left.id.localeCompare(right.id));
    const diagnostics: SpecialistRegistryDiagnostic[] = [];
    for (const specialist of specialists) {
      if (!specialist.enabled) continue;
      diagnostics.push(...specialist.diagnostics);
    }
    return { scannedAt: new Date().toISOString(), specialists, diagnostics };
  }

  private toRegistered(entry: SpecialistSourceEntry): RegisteredSpecialist {
    const state = this.readState()[entry.id];
    const enabled = this.isEnabled(entry, state);
    const definition = entry.definition;
    const scope = specialistToolGroupScope(definition?.tools);
    const resolved = definition
      ? resolveSpecialistOptions(definition, state?.options, state?.optionsMode)
      : undefined;
    const options = definition && resolved ? this.optionViews(definition, resolved) : [];
    const diagnostics = [...entry.diagnostics, ...(entry.moduleLoadDiagnostics ?? [])]
      .filter((diagnostic) => diagnostic.code !== "specialist_module_loaded");
    const blocking = diagnostics.some(isBlockingDiagnostic);
    return {
      id: entry.id,
      name: definition?.name ?? (typeof entry.manifest?.name === "string" ? entry.manifest.name : entry.id),
      description: definition?.description
        ?? (typeof entry.manifest?.description === "string" ? entry.manifest.description : ""),
      ...(definition?.whenToUse ?? (typeof entry.manifest?.whenToUse === "string" ? entry.manifest.whenToUse : undefined)
        ? { whenToUse: definition?.whenToUse ?? (entry.manifest?.whenToUse as string) }
        : {}),
      ...(definition?.version ? { version: definition.version } : {}),
      source: entry.source,
      enabled,
      // A module Agent that has not been loaded yet is unproven, not invalid:
      // only blocking diagnostics or a failed load make an entry invalid.
      valid: !blocking,
      introspected: Boolean(definition),
      executability: entry.entryPath ? "module" : "prompt-only",
      promptMode: definition?.prompt.mode ?? "extend",
      enabledGroups: scope.enabledGroups,
      disabledGroups: scope.disabledGroups,
      deniedTools: scope.deny,
      skillMode: definition?.skills?.mode ?? "auto",
      budget: definition?.budget ?? this.manifestBudget(entry) ?? { ...DEFAULT_SPECIALIST_BUDGET },
      ...(definition?.concurrency?.maxParallelTasks !== undefined
        ? { concurrency: { maxParallelTasks: definition.concurrency.maxParallelTasks } }
        : {}),
      optionsMode: resolved?.mode ?? definition?.optionsMode ?? "planner",
      authorOptionsMode: definition?.optionsMode ?? "planner",
      options,
      diagnostics
    };
  }

  private manifestBudget(entry: SpecialistSourceEntry): SpecialistAgentDefinition["budget"] | undefined {
    const budget = entry.manifest?.budget;
    if (!budget || typeof budget !== "object" || Array.isArray(budget)) return undefined;
    return budget as SpecialistAgentDefinition["budget"];
  }

  /**
   * Read-only projection of the resolved options for the capability page. The
   * `authority`/`editable` pair is what lets the UI render the author's
   * capability envelope as read-only instead of pretending it is configurable.
   */
  private optionViews(
    definition: SpecialistAgentDefinition,
    resolved: ResolvedSpecialistOptions
  ): RegisteredSpecialistOption[] {
    return Object.entries(definition.options ?? {}).map(([key, spec]) => {
      const policy = resolved.policies[key];
      const authority = policy?.authority ?? "author";
      const authorDefault = policy?.authorDefault ?? optionAuthorDefault(spec);
      const value = resolved.values[key] ?? authorDefault;
      return {
        key,
        spec,
        value,
        isDefault: valuesEqual(value, authorDefault),
        authority,
        editable: authority !== "author",
        boundOnly: authority === "planner" && spec.type === "number",
        ...(policy?.bounds ? { bounds: policy.bounds } : {}),
        authorDefault
      };
    });
  }

  private isEnabled(entry: SpecialistSourceEntry, state?: SpecialistStateEntry): boolean {
    if (this.requiredIds.has(entry.id)) return true;
    const resolved = state ?? this.readState()[entry.id];
    if (resolved?.enabled !== undefined) return resolved.enabled;
    if (entry.manifest?.enabled !== undefined) return entry.manifest.enabled !== false;
    return true;
  }

  private readState(): Record<string, SpecialistStateEntry> {
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const state: Record<string, SpecialistStateEntry> = {};
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const record = value as Record<string, unknown>;
        state[id] = {
          ...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
          ...(isSpecialistOptionsMode(record.optionsMode) ? { optionsMode: record.optionsMode } : {}),
          ...(record.options && typeof record.options === "object" && !Array.isArray(record.options)
            ? { options: record.options as Record<string, unknown> }
            : {})
        };
      }
      return state;
    } catch {
      return {};
    }
  }

  private writeState(state: Record<string, SpecialistStateEntry>): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temporary, this.statePath);
  }
}

export { GENERAL_SPECIALIST_ID };

/**
 * Diagnostics that only describe successful or advisory outcomes never make a
 * Specialist unusable.
 */
function isBlockingDiagnostic(diagnostic: SpecialistRegistryDiagnostic): boolean {
  return diagnostic.code !== "specialist_prompt_placeholder_unknown"
    && diagnostic.code !== "specialist_module_loaded";
}

function isInside(path: string, root: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}
