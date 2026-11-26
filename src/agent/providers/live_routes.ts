/** Operator-owned provider selection from the already configured provider registry. */
import { dirname, join } from "@std/path";
import {
  isModelProfileName,
  isSelectedModelProfile,
  type ModelProfileAllowlists,
  selectedModelProvider,
} from "../../core/model_profile_selection.ts";
import type { ClassificationLevel } from "../../core/types/classification.ts";
import type { LlmProvider, LlmProviderRegistry } from "../../core/types/llm.ts";

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
    snapshotForTurn() {
      const allowed = asMap(allowlists);
      const selected = asMap(readOperatorRoutes(routeFile));
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
        const profile = selected[level];
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
      return {
        ...registry,
        getDefault: () => defaultProvider,
        getForClassification: (level) => routes.get(level),
      };
    },
  };
}
