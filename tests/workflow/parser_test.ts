/**
 * Parser tests — YAML parsing and validation.
 *
 * @module
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { parseWorkflowYaml } from "../../src/workflow/parser.ts";

const MORNING_BRIEFING_YAML = `
document:
  dsl: "1.0.0"
  namespace: personal
  name: morning-briefing
  version: "1.0.0"
  metadata:
    triggerfish:
      requires_tools: [web_search, memory_search]
      network_domains: [api.openweathermap.org]
      tags: [daily, briefing]
do:
  - getWeather:
      call: http
      with:
        method: GET
        endpoint:
          uri: https://api.openweathermap.org/data/2.5/weather
  - composeBriefing:
      call: triggerfish:llm
      with:
        task: "Compose a morning briefing"
      output:
        as: .briefing
  - deliverBriefing:
      call: triggerfish:message
      with:
        channel: preferred
        recipient: owner
        text: "\${ .briefing }"
`;

const COMPETITOR_MONITOR_YAML = `
document:
  dsl: "1.0.0"
  namespace: business
  name: competitor-monitor
  version: "1.0.0"
  metadata:
    triggerfish:
      classification_ceiling: CONFIDENTIAL
      requires_tools: [web_search]
      tags: [competitive, weekly]
do:
  - gatherNews:
      for:
        each: competitor
        in: "\${ .competitors }"
        do:
          - searchCompetitor:
              call: triggerfish:web_search
              with:
                query: "\${ $competitor + \" news\" }"
              output:
                as: ".results"
  - analyzeFindings:
      call: triggerfish:llm
      with:
        task: "Analyze findings"
      output:
        as: .analysis
`;

const DETERMINISTIC_YAML = `
document:
  dsl: "1.0.0"
  namespace: default
  name: deterministic-workflow
  version: "1.0.0"
do:
  - fetchData:
      call: http
      with:
        method: GET
        endpoint:
          uri: https://api.example.com/data
      output:
        as: .data
  - saveToMemory:
      call: triggerfish:memory
      with:
        operation: save
        key: "cached-data"
        content: "\${ .data }"
`;

Deno.test("parser — parse valid morning briefing YAML", () => {
  const result = parseWorkflowYaml(MORNING_BRIEFING_YAML);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.name, "morning-briefing");
    assertEquals(result.value.namespace, "personal");
    assertEquals(result.value.dsl, "1.0.0");
    assertEquals(result.value.do.length, 3);
    assertEquals(result.value.requiresTools, ["web_search", "memory_search"]);
    assertEquals(result.value.networkDomains, ["api.openweathermap.org"]);
    assertEquals(result.value.tags, ["daily", "briefing"]);
  }
});

Deno.test("parser — auto-detect approvalRequired: true for triggerfish:llm", () => {
  const result = parseWorkflowYaml(MORNING_BRIEFING_YAML);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.approvalRequired, true);
  }
});

Deno.test("parser — parse classification_ceiling from metadata", () => {
  const result = parseWorkflowYaml(COMPETITOR_MONITOR_YAML);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.classificationCeiling, "CONFIDENTIAL");
  }
});

Deno.test("parser — parse for-loop workflow with nested tasks", () => {
  const result = parseWorkflowYaml(COMPETITOR_MONITOR_YAML);
  assertEquals(result.ok, true);
  if (result.ok) {
    const gatherTask = result.value.do[0];
    assertEquals(gatherTask.name, "gatherNews");
    assertEquals(gatherTask.for !== undefined, true);
    if (gatherTask.for) {
      assertEquals(gatherTask.for.each, "competitor");
      assertEquals(gatherTask.for.do.length, 1);
    }
  }
});

Deno.test("parser — auto-detect approvalRequired: true for nested llm inside for-loop", () => {
  const result = parseWorkflowYaml(COMPETITOR_MONITOR_YAML);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.approvalRequired, true);
  }
});

Deno.test("parser — auto-detect approvalRequired: false for purely deterministic tasks", () => {
  const result = parseWorkflowYaml(DETERMINISTIC_YAML);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.approvalRequired, false);
  }
});

Deno.test("parser — reject missing dsl field", () => {
  const yaml = `
document:
  namespace: default
  name: bad-workflow
  version: "1.0.0"
do:
  - task1:
      set:
        x: 1
`;
  const result = parseWorkflowYaml(yaml);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error, "dsl");
  }
});

Deno.test("parser — reject invalid dsl version", () => {
  const yaml = `
document:
  dsl: "2.0.0"
  name: bad-workflow
do:
  - task1:
      set:
        x: 1
`;
  const result = parseWorkflowYaml(yaml);
  assertEquals(result.ok, false);
});

Deno.test("parser — reject missing name field", () => {
  const yaml = `
document:
  dsl: "1.0.0"
  version: "1.0.0"
do:
  - task1:
      set:
        x: 1
`;
  const result = parseWorkflowYaml(yaml);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error, "name");
  }
});

Deno.test("parser — reject missing do block", () => {
  const yaml = `
document:
  dsl: "1.0.0"
  name: no-tasks
`;
  const result = parseWorkflowYaml(yaml);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error, "do");
  }
});

Deno.test("parser — reject empty do block", () => {
  const yaml = `
document:
  dsl: "1.0.0"
  name: empty-tasks
do: []
`;
  const result = parseWorkflowYaml(yaml);
  assertEquals(result.ok, false);
});

Deno.test("parser — reject task with multiple type keys", () => {
  const yaml = `
document:
  dsl: "1.0.0"
  name: multi-type
do:
  - badTask:
      call: http
      run:
        type: shell
        with:
          command: echo hi
      with:
        method: GET
`;
  const result = parseWorkflowYaml(yaml);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error, "multiple");
  }
});

Deno.test("parser — parse set task correctly", () => {
  const yaml = `
document:
  dsl: "1.0.0"
  name: set-workflow
do:
  - initVars:
      set:
        counter: 0
        status: "pending"
`;
  const result = parseWorkflowYaml(yaml);
  assertEquals(result.ok, true);
  if (result.ok) {
    const task = result.value.do[0];
    assertEquals(task.name, "initVars");
    assertEquals(task.set !== undefined, true);
    if (task.set) {
      assertEquals(task.set.counter, 0);
      assertEquals(task.set.status, "pending");
    }
  }
});

Deno.test("parser — parse switch task with cases", () => {
  const yaml = `
document:
  dsl: "1.0.0"
  name: switch-workflow
do:
  - route:
      switch:
        - highPriority:
            when: "\${ .priority == \"high\" }"
            then: alertOwner
        - default:
            then: end
`;
  const result = parseWorkflowYaml(yaml);
  assertEquals(result.ok, true);
  if (result.ok) {
    const task = result.value.do[0];
    assertEquals(task.switch !== undefined, true);
    if (task.switch) {
      assertEquals(task.switch.length, 2);
      assertEquals(task.switch[0].name, "highPriority");
      assertEquals(task.switch[0].then, "alertOwner");
    }
  }
});

Deno.test("parser — reject invalid classification_ceiling", () => {
  const yaml = `
document:
  dsl: "1.0.0"
  name: bad-ceiling
  metadata:
    triggerfish:
      classification_ceiling: ULTRA_SECRET
do:
  - task1:
      set:
        x: 1
`;
  // Should parse but ceiling should be omitted (invalid value is ignored)
  const result = parseWorkflowYaml(yaml);
  // Either error or undefined ceiling — both acceptable
  if (result.ok) {
    assertEquals(result.value.classificationCeiling, undefined);
  }
});
