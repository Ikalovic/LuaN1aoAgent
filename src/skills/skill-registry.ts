import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export type RegisteredSkill = {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  valid: boolean;
  enabled: boolean;
  modelInvocable: boolean;
};

export type SkillRegistryDiagnostic = {
  code: string;
  message: string;
  path?: string;
  skillName?: string;
};

export type SkillRegistrySnapshot = {
  scannedAt: string;
  skills: RegisteredSkill[];
  diagnostics: SkillRegistryDiagnostic[];
};

export class SkillRegistry {
  private current: SkillRegistrySnapshot = { scannedAt: new Date(0).toISOString(), skills: [], diagnostics: [] };
  private readonly statePath: string;

  constructor(readonly rootDir: string, statePath = join(dirname(rootDir), "skills-state.json")) {
    this.statePath = statePath;
  }

  scan(): SkillRegistrySnapshot {
    if (!existsSync(this.rootDir)) {
      this.current = { scannedAt: new Date().toISOString(), skills: [], diagnostics: [] };
      return this.current;
    }
    const root = realpathSync(this.rootDir);
    const diagnostics = findEscapingSymlinks(root);
    const loaded = loadSkillsFromDir({ dir: root, source: "project" });
    diagnostics.push(...loaded.diagnostics.map((diagnostic) => ({
      code: diagnostic.type === "collision" ? "skill_name_collision" : "skill_invalid",
      message: diagnostic.message,
      ...(diagnostic.path ? { path: diagnostic.path } : {}),
      ...(diagnostic.collision?.name ? { skillName: diagnostic.collision.name } : {})
    })));
    const enabledState = this.readState();
    const names = new Set<string>();
    const skills: RegisteredSkill[] = [];
    for (const skill of loaded.skills.sort((left, right) => left.filePath.localeCompare(right.filePath))) {
      const canonical = realpathSync(skill.filePath);
      if (!isInside(canonical, root)) {
        diagnostics.push({
          code: "skill_path_outside_root",
          message: `Skill path escapes registry root: ${skill.filePath}`,
          path: skill.filePath,
          skillName: skill.name
        });
        continue;
      }
      if (names.has(skill.name)) {
        diagnostics.push({ code: "skill_name_collision", message: `Duplicate skill name: ${skill.name}`, path: skill.filePath, skillName: skill.name });
        continue;
      }
      names.add(skill.name);
      const valid = validSkillName(skill.name) && Boolean(skill.description.trim());
      if (!valid) diagnostics.push({ code: "skill_invalid", message: `Invalid skill metadata: ${skill.name}`, path: skill.filePath, skillName: skill.name });
      skills.push({
        name: skill.name,
        description: skill.description,
        filePath: canonical,
        baseDir: dirname(canonical),
        valid,
        enabled: enabledState[skill.name] !== false,
        modelInvocable: !skill.disableModelInvocation
      });
    }
    this.current = {
      scannedAt: new Date().toISOString(),
      skills: skills.sort((left, right) => left.name.localeCompare(right.name)),
      diagnostics
    };
    return this.current;
  }

  snapshot(): SkillRegistrySnapshot {
    return this.current.scannedAt === new Date(0).toISOString() ? this.scan() : this.current;
  }

  setEnabled(name: string, enabled: boolean): void {
    const snapshot = this.scan();
    if (!snapshot.skills.some((skill) => skill.name === name)) throw new Error(`Unknown skill: ${name}`);
    const state = this.readState();
    state[name] = enabled;
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(temporary, this.statePath);
    this.scan();
  }

  resolveSelection(names: string[], allowlist?: string[], denylist?: string[]): RegisteredSkill[] {
    const snapshot = this.scan();
    const allowed = allowlist ? new Set(allowlist) : undefined;
    const denied = new Set(denylist ?? []);
    const requested = new Set(names);
    return snapshot.skills.filter((skill) => requested.has(skill.name)
      && skill.valid
      && skill.enabled
      && skill.modelInvocable
      && (!allowed || allowed.has(skill.name))
      && !denied.has(skill.name));
  }

  private readState(): Record<string, boolean> {
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"))
        : {};
    } catch {
      return {};
    }
  }
}

function findEscapingSymlinks(root: string): SkillRegistryDiagnostic[] {
  const diagnostics: SkillRegistryDiagnostic[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          if (!isInside(realpathSync(path), root)) diagnostics.push({ code: "skill_path_outside_root", message: `Skill symlink escapes registry root: ${path}`, path });
        } catch {}
        continue;
      }
      if (entry.isDirectory()) visit(path);
    }
  };
  visit(root);
  return diagnostics;
}

function isInside(path: string, root: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

function validSkillName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}
