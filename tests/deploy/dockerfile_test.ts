/**
 * Static analysis tests for Docker deployment files.
 *
 * Validates Dockerfile, Dockerfile.release, docker-compose.yml, and
 * .dockerignore conform to expected patterns without building anything.
 *
 * @module
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

const DOCKERFILE_PATH = "deploy/docker/Dockerfile";
const DOCKERFILE_RELEASE_PATH = "deploy/docker/Dockerfile.release";
const COMPOSE_PATH = "deploy/docker/docker-compose.yml";
const DOCKERIGNORE_PATH = ".dockerignore";

/**
 * Extract the content of a named Dockerfile stage (FROM ... AS name).
 * Returns everything from the FROM line up to the next FROM or EOF.
 */
function extractStage(content: string, stageName: string): string {
  const regex = new RegExp(
    `^FROM\\s+\\S+.*\\s+AS\\s+${stageName}\\s*$`,
    "im",
  );
  const match = content.match(regex);
  if (!match || match.index === undefined) return "";
  const start = match.index;
  const rest = content.substring(start + match[0].length);
  const nextFrom = rest.match(/\nFROM\s/);
  if (nextFrom && nextFrom.index !== undefined) {
    return content.substring(start, start + match[0].length + nextFrom.index);
  }
  return content.substring(start);
}

// --- Dockerfile (local dev build) ---

Deno.test("Dockerfile exists and is readable", async () => {
  const content = await Deno.readTextFile(DOCKERFILE_PATH);
  assertEquals(content.length > 0, true);
});

Deno.test("Dockerfile uses denoland/deno base image", async () => {
  const content = await Deno.readTextFile(DOCKERFILE_PATH);
  assertStringIncludes(content, "denoland/deno:");
});

Deno.test("Dockerfile uses distroless runtime base", async () => {
  const content = await Deno.readTextFile(DOCKERFILE_PATH);
  assertStringIncludes(content, "gcr.io/distroless/cc-debian12");
  assertEquals(
    content.includes("trixie-slim"),
    false,
    "Should not use trixie-slim",
  );
  assertEquals(content.includes("alpine"), false, "Should not use alpine");
});

Deno.test("Dockerfile exposes correct ports", async () => {
  const content = await Deno.readTextFile(DOCKERFILE_PATH);
  assertStringIncludes(content, "EXPOSE 18789");
  assertStringIncludes(content, "18790");
});

Deno.test("Dockerfile uses direct binary entrypoint", async () => {
  const content = await Deno.readTextFile(DOCKERFILE_PATH);
  assertStringIncludes(content, 'ENTRYPOINT ["/usr/local/bin/triggerfish"]');
  assertEquals(content.includes("tini"), false, "Should not reference tini");
});

Deno.test("Dockerfile sets TRIGGERFISH_DOCKER=true", async () => {
  const content = await Deno.readTextFile(DOCKERFILE_PATH);
  assertStringIncludes(content, "TRIGGERFISH_DOCKER=true");
});

Deno.test("Dockerfile runs as nonroot user", async () => {
  const content = await Deno.readTextFile(DOCKERFILE_PATH);
  // Distroless default is nonroot (UID 65534) — no explicit USER directive
  // required, but if present it should reference nonroot
  const productionStage = extractStage(content, "production");
  assertEquals(
    productionStage.includes("USER root"),
    false,
    "Production stage must not run as root",
  );
});

Deno.test("Dockerfile includes config and skills", async () => {
  const content = await Deno.readTextFile(DOCKERFILE_PATH);
  assertStringIncludes(content, "--include config/");
  assertStringIncludes(content, "--include skills/");
});

Deno.test("Dockerfile has production and debug stages", async () => {
  const content = await Deno.readTextFile(DOCKERFILE_PATH);
  assertStringIncludes(content, "AS production");
  assertStringIncludes(content, "AS debug");
});

Deno.test("Dockerfile production stage has no RUN directives", async () => {
  const content = await Deno.readTextFile(DOCKERFILE_PATH);
  const productionStage = extractStage(content, "production");
  assertEquals(
    productionStage.length > 0,
    true,
    "Production stage must exist",
  );
  assertEquals(
    /\nRUN\s/m.test(productionStage),
    false,
    "Production stage must not have RUN directives (distroless has no shell)",
  );
});

Deno.test("Dockerfile debug stage uses debug variant", async () => {
  const content = await Deno.readTextFile(DOCKERFILE_PATH);
  const debugStage = extractStage(content, "debug");
  assertStringIncludes(
    debugStage,
    "distroless/cc-debian12:debug",
  );
});

Deno.test("Dockerfile does not install tini", async () => {
  const content = await Deno.readTextFile(DOCKERFILE_PATH);
  assertEquals(
    content.includes("apt-get install") && content.includes("tini"),
    false,
    "Should not install tini via apt-get",
  );
});

// --- Dockerfile.release (CI multi-arch build) ---

Deno.test("Dockerfile.release exists and is readable", async () => {
  const content = await Deno.readTextFile(DOCKERFILE_RELEASE_PATH);
  assertEquals(content.length > 0, true);
});

Deno.test("Dockerfile.release uses TARGETARCH for multi-arch", async () => {
  const content = await Deno.readTextFile(DOCKERFILE_RELEASE_PATH);
  assertStringIncludes(content, "ARG TARGETARCH");
  assertStringIncludes(content, "triggerfish-linux-${TARGETARCH}");
});

Deno.test("Dockerfile.release uses minimal Chainguard runtime base", async () => {
  const content = await Deno.readTextFile(DOCKERFILE_RELEASE_PATH);
  assertStringIncludes(content, "cgr.dev/chainguard/glibc-dynamic:latest");
  assertEquals(
    content.includes("trixie-slim"),
    false,
    "Should not use trixie-slim",
  );
  assertEquals(content.includes("alpine"), false, "Should not use alpine");
});

Deno.test("Dockerfile.release has no build stage", async () => {
  const content = await Deno.readTextFile(DOCKERFILE_RELEASE_PATH);
  assertEquals(
    content.includes("AS builder"),
    false,
    "Should not have a build stage",
  );
  assertEquals(content.includes("deno compile"), false, "Should not compile");
});

Deno.test("Dockerfile.release exposes correct ports", async () => {
  const content = await Deno.readTextFile(DOCKERFILE_RELEASE_PATH);
  assertStringIncludes(content, "EXPOSE 18789");
  assertStringIncludes(content, "18790");
});

Deno.test("Dockerfile.release uses direct binary entrypoint", async () => {
  const content = await Deno.readTextFile(DOCKERFILE_RELEASE_PATH);
  assertStringIncludes(content, 'ENTRYPOINT ["/usr/local/bin/triggerfish"]');
  assertEquals(content.includes("tini"), false, "Should not reference tini");
});

Deno.test("Dockerfile.release sets TRIGGERFISH_DOCKER=true", async () => {
  const content = await Deno.readTextFile(DOCKERFILE_RELEASE_PATH);
  assertStringIncludes(content, "TRIGGERFISH_DOCKER=true");
});

Deno.test("Dockerfile.release runs as nonroot user", async () => {
  const content = await Deno.readTextFile(DOCKERFILE_RELEASE_PATH);
  const productionStage = extractStage(content, "production");
  assertEquals(
    productionStage.includes("USER root"),
    false,
    "Production stage must not run as root",
  );
});

Deno.test("Dockerfile.release has production and debug stages", async () => {
  const content = await Deno.readTextFile(DOCKERFILE_RELEASE_PATH);
  assertStringIncludes(content, "AS production");
  assertStringIncludes(content, "AS debug");
});

Deno.test("Dockerfile.release production stage has no RUN directives", async () => {
  const content = await Deno.readTextFile(DOCKERFILE_RELEASE_PATH);
  const productionStage = extractStage(content, "production");
  assertEquals(
    productionStage.length > 0,
    true,
    "Production stage must exist",
  );
  assertEquals(
    /\nRUN\s/m.test(productionStage),
    false,
    "Production stage must not have RUN directives (distroless has no shell)",
  );
});

Deno.test("Dockerfile.release debug stage uses debug variant", async () => {
  const content = await Deno.readTextFile(DOCKERFILE_RELEASE_PATH);
  const debugStage = extractStage(content, "debug");
  assertStringIncludes(
    debugStage,
    "glibc-dynamic:latest-dev",
  );
});

Deno.test("Dockerfile.release does not install tini", async () => {
  const content = await Deno.readTextFile(DOCKERFILE_RELEASE_PATH);
  assertEquals(
    content.includes("apt-get"),
    false,
    "Release Dockerfile should not use apt-get at all",
  );
});

// --- docker-compose.yml ---

Deno.test("docker-compose.yml exists and has triggerfish service", async () => {
  const content = await Deno.readTextFile(COMPOSE_PATH);
  assertStringIncludes(content, "triggerfish:");
});

Deno.test("docker-compose.yml maps correct ports", async () => {
  const content = await Deno.readTextFile(COMPOSE_PATH);
  assertStringIncludes(content, "18789:18789");
  assertStringIncludes(content, "18790:18790");
});

Deno.test("docker-compose.yml has data volume", async () => {
  const content = await Deno.readTextFile(COMPOSE_PATH);
  assertStringIncludes(content, "triggerfish-data");
});

Deno.test("docker-compose.yml has init: true for signal handling", async () => {
  const content = await Deno.readTextFile(COMPOSE_PATH);
  assertStringIncludes(content, "init: true");
});

Deno.test("docker-compose.yml documents UID 65534", async () => {
  const content = await Deno.readTextFile(COMPOSE_PATH);
  assertStringIncludes(content, "65534");
});

Deno.test("docker-compose.yml has environment variables", async () => {
  const content = await Deno.readTextFile(COMPOSE_PATH);
  assertStringIncludes(content, "TRIGGERFISH_DATA_DIR");
  assertStringIncludes(content, "TRIGGERFISH_CONFIG");
  assertStringIncludes(content, "ANTHROPIC_API_KEY");
});

// --- .dockerignore ---

Deno.test(".dockerignore excludes tests and .git", async () => {
  const content = await Deno.readTextFile(DOCKERIGNORE_PATH);
  assertStringIncludes(content, ".git");
  assertStringIncludes(content, "tests");
});
