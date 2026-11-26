import { createHash } from "node:crypto";
import { isModelRouteIdentity } from "../../core/model_route_identity.ts";
/** Operator-owned provider selection from the already configured provider registry. */
import { dirname, join } from "@std/path";
import {
  isModelProfileName,
  isSelectedModelProfile,
  type ModelProfileAllowlists,
  type SelectedModelProfile,
  selectedModelProvider,
} from "../../core/model_profile_selection.ts";
import type { ClassificationLevel } from "../../core/types/classification.ts";
import type { LlmProvider, LlmProviderRegistry } from "../../core/types/llm.ts";

import {
  hasNamedModelProfiles,
  type LiveRouteEdit,
  type NamedModelProfile,
  openLiveRouteJournal,
  readLiveRouteEdits,
  readNamedModelProfile,
} from "./live_route_journal.ts";

const levels: readonly ClassificationLevel[] = [
  "PUBLIC",
  "INTERNAL",
  "CONFIDENTIAL",
  "RESTRICTED",
];

function asMap(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid model route settings");
  }
  return value as Record<string, unknown>;
}

function readOperatorRoutes(path: string): unknown {
  const directory = Deno.lstatSync(dirname(path));
  if (
    !directory.isDirectory || directory.isSymlink ||
    (directory.mode !== null && (directory.mode & 0o022))
  ) {
    throw new Error("Invalid model route directory");
  }
  const pathInfo = Deno.lstatSync(path);
  if (!pathInfo.isFile || pathInfo.isSymlink) {
    throw new Error("Invalid model route file");
  }
  using file = Deno.openSync(path);
  const info = file.statSync();
  if (
    !info.isFile || info.ino !== pathInfo.ino || info.dev !== pathInfo.dev ||
    (info.nlink ?? 1) !== 1 || (info.mode !== null && (info.mode & 0o022)) ||
    info.size < 2 || info.size > 4096
  ) {
    throw new Error("Invalid model route file");
  }
  const bytes = new Uint8Array(4097);
  let length = 0;
  while (length < bytes.length) {
    const read = file.readSync(bytes.subarray(length));
    if (read === null) break;
    length += read;
  }
  if (length > 4096) throw new Error("Invalid model route file");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
    bytes.subarray(0, length),
  ));
}

function providerRouteIdentity(
  level: ClassificationLevel,
  managed: boolean,
  provider?: LlmProvider,
) {
  return createHash("sha256").update(JSON.stringify([
    level,
    managed,
    provider?.name ?? null,
    provider?.model ?? null,
  ])).digest("hex");
}

/** Pin all classification routes together before the first request in a turn. */
export function enableLiveProviderRoutes(
  registry: LlmProviderRegistry,
  baseDir: string,
  allowlists?: ModelProfileAllowlists,
): LlmProviderRegistry {
  if (allowlists === undefined) return registry;
  const routeFile = join(baseDir, "data", "model-routes.json");
  return {
    ...registry,
    snapshotForTurn(priorRouteIdentity) {
      if (
        priorRouteIdentity !== undefined &&
        !isModelRouteIdentity(priorRouteIdentity)
      ) {
        throw new Error("Invalid approved model route identity");
      }
      const allowed = asMap(allowlists);
      const selected = asMap(readOperatorRoutes(routeFile));
      const edits = readLiveRouteEdits(baseDir);
      const classes = levels.filter((level) => Object.hasOwn(allowed, level));
      if (
        !classes.length || Object.keys(allowed).length !== classes.length ||
        Object.keys(selected).length !== classes.length
      ) throw new Error("Invalid model route classifications");
      const defaultProvider = registry.getDefault();
      const routes = new Map<ClassificationLevel, LlmProvider | undefined>(
        levels.map((level) => [level, registry.getForClassification(level)]),
      );
      for (const level of classes) {
        const names = allowed[level];
        const edit = edits.get(level);
        const profile = edit?.override ?? selected[level];
        if (
          !Array.isArray(names) || !names.length ||
          !names.every(isModelProfileName) || !isSelectedModelProfile(profile)
        ) throw new Error("Invalid approved model route");
        const provider = selectedModelProvider(
          registry,
          profile,
          level,
          allowlists,
        );
        if (!provider) throw new Error("Approved model route is unavailable");
        routes.set(level, provider);
      }
      const identities = levels.map((level, index) => {
        const managed = classes.includes(level);
        const expected = priorRouteIdentity?.slice(
          index * 64,
          (index + 1) * 64,
        );
        const provider = routes.get(level);
        const current = providerRouteIdentity(level, managed, provider);
        if (expected === undefined || expected === current) return current;
        if (managed) {
          const eligible = allowlists[level]?.flatMap((name) => {
            const candidate = registry.get(name);
            return candidate?.name === name ? [candidate] : [];
          }).find((candidate) =>
            providerRouteIdentity(level, true, candidate) === expected
          );
          if (eligible) {
            routes.set(level, eligible);
            return expected;
          }
        }
        throw new Error("The original approved model route is unavailable");
      });
      return {
        ...registry,
        modelRouteIdentity: identities.join(""),
        getDefault: () => defaultProvider,
        getForClassification: (level) => routes.get(level),
      };
    },
  };
}

/** Inspect and edit exact class routes using the same source and admission as turns. */
export function liveProviderRouteSettings(
  registry: LlmProviderRegistry,
  baseDir: string,
  allowlists: ModelProfileAllowlists,
) {
  function read(classification: ClassificationLevel) {
    const names = allowlists[classification];
    if (
      !Array.isArray(names) || !names.length || !names.every(isModelProfileName)
    ) return;
    const source = asMap(
      readOperatorRoutes(join(baseDir, "data", "model-routes.json")),
    );
    const baseline = source[classification];
    if (!isSelectedModelProfile(baseline)) return;
    const saved = readLiveRouteEdits(baseDir).get(classification);
    return {
      baseline,
      effective: saved?.override ?? baseline,
      override: saved?.override ?? null,
      version: saved?.version ?? 0,
      ...(saved?.named && { named: saved.named }),
    };
  }
  function eligible(
    profile: SelectedModelProfile,
    classification: ClassificationLevel,
  ) {
    return selectedModelProvider(
      registry,
      profile,
      classification,
      allowlists,
    ) !== undefined;
  }
  function inspectProfile(id: string) {
    const db = openLiveRouteJournal(baseDir);
    try {
      return db && readNamedModelProfile(db, id);
    } finally {
      db?.close();
    }
  }
  function listProfiles(classification: ClassificationLevel, after: string) {
    const db = openLiveRouteJournal(baseDir);
    try {
      if (!db || !hasNamedModelProfiles(db)) return [];
      return db.prepare(`SELECT n.receipt FROM named_profiles n
        WHERE n.classification = ? AND n.id > ? AND n.version =
          (SELECT max(version) FROM named_profiles WHERE id = n.id)
        AND json_type(n.receipt, '$.profile') = 'object'
        ORDER BY n.id LIMIT 51`)
        .all(classification, after).map((row) =>
          JSON.parse(String(row.receipt)) as NamedModelProfile
        );
    } finally {
      db?.close();
    }
  }
  function commitProfile(input: NamedModelProfile, expectedRoute: number) {
    const db = openLiveRouteJournal(baseDir, true);
    if (!db) return;
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db.prepare(
          "SELECT receipt FROM named_profiles WHERE requestId = ?",
        ).get(input.requestId);
        if (existing) {
          db.exec("COMMIT");
          const previous = JSON.parse(
            String(existing.receipt),
          ) as NamedModelProfile;
          return JSON.stringify(previous) === JSON.stringify(input) &&
              (!previous.profile ||
                eligible(previous.profile, previous.classification))
            ? previous
            : undefined;
        }
        const current = readNamedModelProfile(db, input.id);
        const route = read(input.classification);
        const running = route?.named?.id === input.id;
        if (
          !route || route.version !== expectedRoute ||
          (current && current.classification !== input.classification) ||
          input.version !== (current?.version ?? 0) + 1 ||
          (input.profile
            ? !eligible(input.profile, input.classification)
            : !current?.profile || running)
        ) {
          db.exec("ROLLBACK");
          return;
        }
        db.prepare("INSERT INTO named_profiles VALUES (?, ?, ?, ?, ?)").run(
          input.id,
          input.version,
          input.classification,
          input.requestId,
          JSON.stringify(input),
        );
        if (running && input.profile) {
          const override = {
            classification: input.classification,
            requestId: input.requestId,
            version: route.version + 1,
            previous: route.effective,
            override: input.profile,
            effective: input.profile,
            named: { id: input.id, version: input.version },
          } satisfies LiveRouteEdit;
          db.prepare("INSERT INTO route_edits VALUES (?, ?, ?, ?)").run(
            override.classification,
            override.version,
            override.requestId,
            JSON.stringify(override),
          );
        }
        db.exec("COMMIT");
        return input;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
  }
  function commit(input: LiveRouteEdit) {
    const db = openLiveRouteJournal(baseDir, true);
    if (!db) return;
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const duplicate = db.prepare(
          "SELECT receipt FROM route_edits WHERE requestId = ?",
        ).get(input.requestId);
        if (duplicate) {
          const saved = JSON.parse(String(duplicate.receipt)) as LiveRouteEdit;
          db.exec("COMMIT");
          return saved.classification === input.classification &&
              saved.version === input.version &&
              JSON.stringify(saved.override) ===
                JSON.stringify(input.override) &&
              JSON.stringify(saved.named) === JSON.stringify(input.named) &&
              eligible(saved.effective, saved.classification)
            ? saved
            : undefined;
        }
        const current = read(input.classification);
        const named = input.named && readNamedModelProfile(db, input.named.id);
        if (
          !current || input.version !== current.version + 1 ||
          !eligible(input.effective, input.classification) ||
          (input.named && (
            !named?.profile || named.classification !== input.classification ||
            named.version !== input.named.version ||
            named.profile.provider !== input.override?.provider ||
            named.profile.model !== input.override?.model
          )) ||
          current.effective.provider !== input.previous.provider ||
          current.effective.model !== input.previous.model ||
          (!input.override &&
            (current.baseline.provider !== input.effective.provider ||
              current.baseline.model !== input.effective.model))
        ) {
          db.exec("ROLLBACK");
          return;
        }
        db.prepare("INSERT INTO route_edits VALUES (?, ?, ?, ?)").run(
          input.classification,
          input.version,
          input.requestId,
          JSON.stringify(input),
        );
        db.exec("COMMIT");
        return input;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      db.close();
    }
  }
  return {
    read,
    eligible,
    commit,
    inspectProfile,
    listProfiles,
    commitProfile,
  };
}
