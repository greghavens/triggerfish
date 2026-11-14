/**
 * Tests for the Tide Pool / A2UI module.
 *
 * Covers component constructors, A2UIHost WebSocket broadcasting,
 * TidePoolTools canvas render/update/clear operations, canvas protocol,
 * tool definitions, executor dispatching, and HTML composition.
 */
import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import {
  buildTidepoolHtml,
  card,
  chart,
  createA2UIHost,
  createTidepoolToolExecutor,
  createTidePoolTools,
  form,
  generateRenderId,
  getTidepoolToolDefinitions,
  image,
  layout,
  markdown,
  table,
} from "../../src/tools/tidepool/mod.ts";
import type {
  A2UIComponent,
  A2UIHost,
  CanvasMessage,
  CanvasRenderComponentMessage,
  ComponentTree,
  TidePoolTools,
} from "../../src/tools/tidepool/mod.ts";

// ---------------------------------------------------------------------------
// Component constructors
// ---------------------------------------------------------------------------

Deno.test("card: produces correct shape", () => {
  const c = card("c1", "My Title", "Body text");
  assertEquals(c.type, "card");
  assertEquals(c.id, "c1");
  assertEquals(c.props.title, "My Title");
  assertEquals(c.props.content, "Body text");
  assertEquals(c.children, undefined);
});

Deno.test("table: produces correct shape", () => {
  const t = table("t1", ["Name", "Age"], [["Alice", "30"], ["Bob", "25"]]);
  assertEquals(t.type, "table");
  assertEquals(t.id, "t1");
  assertEquals(t.props.headers, ["Name", "Age"]);
  assertEquals(t.props.rows, [["Alice", "30"], ["Bob", "25"]]);
});

Deno.test("markdown: produces correct shape", () => {
  const m = markdown("m1", "# Hello");
  assertEquals(m.type, "markdown");
  assertEquals(m.id, "m1");
  assertEquals(m.props.content, "# Hello");
});

Deno.test("layout: produces correct shape with children", () => {
  const child1 = card("c1", "A", "a");
  const child2 = card("c2", "B", "b");
  const l = layout("l1", "row", [child1, child2]);
  assertEquals(l.type, "layout");
  assertEquals(l.id, "l1");
  assertEquals(l.props.direction, "row");
  assertExists(l.children);
  assertEquals(l.children!.length, 2);
  assertEquals(l.children![0].id, "c1");
  assertEquals(l.children![1].id, "c2");
});

Deno.test("layout: column direction", () => {
  const l = layout("l2", "column", []);
  assertEquals(l.props.direction, "column");
  assertEquals(l.children!.length, 0);
});

Deno.test("chart: structured data shape", () => {
  const c = chart("ch1", { type: "bar", labels: ["A", "B"], values: [10, 20] });
  assertEquals(c.type, "chart");
  assertEquals(c.id, "ch1");
  assertEquals(c.props.type, "bar");
  assertEquals(c.props.labels, ["A", "B"]);
  assertEquals(c.props.values, [10, 20]);
});

Deno.test("chart: SVG passthrough shape", () => {
  const c = chart("ch2", { svg: "<svg></svg>" });
  assertEquals(c.type, "chart");
  assertEquals(c.id, "ch2");
  assertEquals(c.props.svg, "<svg></svg>");
});

Deno.test("form: produces correct shape", () => {
  const f = form("f1", [
    { name: "email", type: "email", label: "Email" },
    { name: "name", type: "text", label: "Name" },
  ]);
  assertEquals(f.type, "form");
  assertEquals(f.id, "f1");
  const fields = f.props.fields as Array<
    { name: string; type: string; label: string }
  >;
  assertEquals(fields.length, 2);
  assertEquals(fields[0].name, "email");
  assertEquals(fields[1].label, "Name");
});

Deno.test("image: produces correct shape", () => {
  const img = image("i1", "https://example.com/img.png");
  assertEquals(img.type, "image");
  assertEquals(img.id, "i1");
  assertEquals(img.props.src, "https://example.com/img.png");
  assertEquals(img.props.alt, undefined);
});

Deno.test("image: with alt text", () => {
  const img = image("i2", "data:image/png;base64,abc", "test image");
  assertEquals(img.props.src, "data:image/png;base64,abc");
  assertEquals(img.props.alt, "test image");
});

// ---------------------------------------------------------------------------
// generateRenderId
// ---------------------------------------------------------------------------

Deno.test("generateRenderId: returns unique IDs", () => {
  const id1 = generateRenderId();
  const id2 = generateRenderId();
  assertNotEquals(id1, id2);
  // Should be UUID format
  assert(id1.length > 0);
  assert(id2.length > 0);
});

// ---------------------------------------------------------------------------
// A2UIHost WebSocket tests
// ---------------------------------------------------------------------------

const TEST_PORT = 9877;

Deno.test({
  name: "A2UIHost: tracks connections",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const host = createA2UIHost();
    await host.start(TEST_PORT);

    try {
      assertEquals(host.connections, 0);

      const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`);
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      // Give the server a moment to register the connection
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      assertEquals(host.connections, 1);

      ws.close();
      // Wait for close to propagate
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      assertEquals(host.connections, 0);
    } finally {
      await host.stop();
    }
  },
});

Deno.test({
  name: "A2UIHost: broadcasts tree to all connected clients",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const host = createA2UIHost();
    await host.start(TEST_PORT + 1);

    try {
      const ws1 = new WebSocket(`ws://127.0.0.1:${TEST_PORT + 1}`);
      const ws2 = new WebSocket(`ws://127.0.0.1:${TEST_PORT + 1}`);

      await Promise.all([
        new Promise<void>((resolve) => {
          ws1.onopen = () => resolve();
        }),
        new Promise<void>((resolve) => {
          ws2.onopen = () => resolve();
        }),
      ]);

      // Wait for server-side registration
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      assertEquals(host.connections, 2);

      const tree: ComponentTree = {
        root: card("r1", "Root", "Hello"),
        version: 1,
      };

      const received1 = new Promise<CanvasRenderComponentMessage>((resolve) => {
        ws1.onmessage = (event: MessageEvent) => {
          resolve(JSON.parse(event.data as string));
        };
      });

      const received2 = new Promise<CanvasRenderComponentMessage>((resolve) => {
        ws2.onmessage = (event: MessageEvent) => {
          resolve(JSON.parse(event.data as string));
        };
      });

      host.broadcast(tree);

      const [result1, result2] = await Promise.all([received1, received2]);

      // broadcast wraps in canvas_render_component
      assertEquals(result1.type, "canvas_render_component");
      assertEquals(result1.tree.version, 1);
      assertEquals(result1.tree.root.type, "card");
      assertEquals(result1.tree.root.id, "r1");
      assertEquals(result2.type, "canvas_render_component");
      assertEquals(result2.tree.root.id, "r1");

      ws1.close();
      ws2.close();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    } finally {
      await host.stop();
    }
  },
});

Deno.test({
  name: "A2UIHost: sends current tree on new connection",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const host = createA2UIHost();
    await host.start(TEST_PORT + 2);

    try {
      const tree: ComponentTree = {
        root: markdown("intro", "# Welcome"),
        version: 5,
      };
      host.broadcast(tree);

      // Connect after broadcast — should get current tree immediately
      const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT + 2}`);

      const received = new Promise<CanvasRenderComponentMessage>((resolve) => {
        ws.onmessage = (event: MessageEvent) => {
          resolve(JSON.parse(event.data as string));
        };
      });

      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      const result = await received;
      assertEquals(result.type, "canvas_render_component");
      assertEquals(result.tree.version, 5);
      assertEquals(result.tree.root.id, "intro");
      assertEquals(result.tree.root.type, "markdown");

      ws.close();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    } finally {
      await host.stop();
    }
  },
});

Deno.test({
  name: "A2UIHost: disconnected client does not cause errors",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const host = createA2UIHost();
    await host.start(TEST_PORT + 3);

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT + 3}`);
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      assertEquals(host.connections, 1);

      // Close the client
      ws.close();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      assertEquals(host.connections, 0);

      // Broadcast after disconnect — should not throw
      const tree: ComponentTree = {
        root: card("orphan", "Title", "No receivers"),
        version: 1,
      };
      host.broadcast(tree);

      // No error means success
      assertEquals(host.connections, 0);
    } finally {
      await host.stop();
    }
  },
});

// ---------------------------------------------------------------------------
// A2UIHost: sendCanvas tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "A2UIHost: sendCanvas sends typed messages to clients",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const host = createA2UIHost();
    await host.start(TEST_PORT + 10);

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT + 10}`);
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      const received = new Promise<CanvasMessage>((resolve) => {
        ws.onmessage = (event: MessageEvent) => {
          resolve(JSON.parse(event.data as string));
        };
      });

      const msg: CanvasMessage = {
        type: "canvas_render_html",
        id: "test-id",
        label: "Test HTML",
        html: "<h1>Hello</h1>",
      };
      host.sendCanvas(msg);

      const result = await received;
      assertEquals(result.type, "canvas_render_html");
      if (result.type === "canvas_render_html") {
        assertEquals(result.id, "test-id");
        assertEquals(result.label, "Test HTML");
        assertEquals(result.html, "<h1>Hello</h1>");
      }

      ws.close();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    } finally {
      await host.stop();
    }
  },
});

// ---------------------------------------------------------------------------
// TidePoolTools tests
// ---------------------------------------------------------------------------

/** Create a mock host that records sendCanvas calls. */
function createMockHost(): A2UIHost & {
  readonly canvasMessages: CanvasMessage[];
} {
  const canvasMessages: CanvasMessage[] = [];
  return {
    start: async (_port: number) => {},
    stop: async () => {},
    sendCanvas: (msg: CanvasMessage) => {
      canvasMessages.push(msg);
    },
    broadcast: (_tree: ComponentTree) => {},
    get connections() {
      return 0;
    },
    canvasMessages,
  };
}

Deno.test("TidePoolTools: renderComponent sends canvas message", () => {
  const mockHost = createMockHost();
  const tools = createTidePoolTools(mockHost);

  const tree: ComponentTree = {
    root: card("main", "Dashboard", "Content"),
    version: 1,
  };

  const result = tools.renderComponent("Dashboard", tree);
  assert(result.ok);

  assertEquals(mockHost.canvasMessages.length, 1);
  assertEquals(mockHost.canvasMessages[0].type, "canvas_render_component");
  if (mockHost.canvasMessages[0].type === "canvas_render_component") {
    assertEquals(mockHost.canvasMessages[0].label, "Dashboard");
    assertEquals(mockHost.canvasMessages[0].tree.root.id, "main");
  }
});

Deno.test("TidePoolTools: renderHtml sends canvas message", () => {
  const mockHost = createMockHost();
  const tools = createTidePoolTools(mockHost);

  const result = tools.renderHtml("Chart SVG", "<svg><circle r='50'/></svg>");
  assert(result.ok);

  assertEquals(mockHost.canvasMessages.length, 1);
  assertEquals(mockHost.canvasMessages[0].type, "canvas_render_html");
});

Deno.test("TidePoolTools: renderFile sends canvas message", () => {
  const mockHost = createMockHost();
  const tools = createTidePoolTools(mockHost);

  const result = tools.renderFile("Report", {
    filename: "report.pdf",
    mime: "application/pdf",
    data: "AAAA",
  });
  assert(result.ok);

  assertEquals(mockHost.canvasMessages.length, 1);
  assertEquals(mockHost.canvasMessages[0].type, "canvas_render_file");
  if (mockHost.canvasMessages[0].type === "canvas_render_file") {
    assertEquals(mockHost.canvasMessages[0].filename, "report.pdf");
    assertEquals(mockHost.canvasMessages[0].mime, "application/pdf");
  }
});

Deno.test("TidePoolTools: update patches component by ID", () => {
  const mockHost = createMockHost();
  const tools = createTidePoolTools(mockHost);

  const tree: ComponentTree = {
    root: layout("root", "column", [
      card("header", "Old Title", "Old Content"),
      markdown("body", "# Old"),
    ]),
    version: 1,
  };

  tools.renderComponent("Layout", tree);

  const updateResult = tools.update("header", {
    title: "New Title",
    content: "New Content",
  });
  assert(updateResult.ok);

  // Should have sent 2 messages: render + update
  assertEquals(mockHost.canvasMessages.length, 2);
  assertEquals(mockHost.canvasMessages[1].type, "canvas_update");
  if (mockHost.canvasMessages[1].type === "canvas_update") {
    const headerChild = mockHost.canvasMessages[1].tree.root.children?.find(
      (c: A2UIComponent) => c.id === "header",
    );
    assertExists(headerChild);
    assertEquals(headerChild!.props.title, "New Title");
    assertEquals(headerChild!.props.content, "New Content");
    assertEquals(mockHost.canvasMessages[1].tree.version, 2);
  }
});

Deno.test("TidePoolTools: update returns error when no tree rendered", () => {
  const mockHost = createMockHost();
  const tools = createTidePoolTools(mockHost);
  const result = tools.update("nonexistent", { title: "X" });
  assert(!result.ok);
  if (!result.ok) {
    assertEquals(result.error, "No tree rendered yet");
  }
});

Deno.test("TidePoolTools: update returns error for unknown component ID", () => {
  const mockHost = createMockHost();
  const tools = createTidePoolTools(mockHost);
  tools.renderComponent("Test", {
    root: card("only-card", "Title", "Body"),
    version: 1,
  });

  const result = tools.update("nonexistent-id", { title: "X" });
  assert(!result.ok);
  if (!result.ok) {
    assertEquals(result.error, "Component not found: nonexistent-id");
  }
});

Deno.test("TidePoolTools: clear sends canvas_clear message", () => {
  const mockHost = createMockHost();
  const tools = createTidePoolTools(mockHost);

  tools.renderComponent("Test", {
    root: card("main", "Title", "Body"),
    version: 1,
  });

  const result = tools.clear();
  assert(result.ok);
  assertEquals(mockHost.canvasMessages.length, 2);
  assertEquals(mockHost.canvasMessages[1].type, "canvas_clear");
});

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

Deno.test("getTidepoolToolDefinitions: returns 5 tools with correct names", () => {
  const defs = getTidepoolToolDefinitions();
  assertEquals(defs.length, 5);
  const names = defs.map((d) => d.name);
  assert(names.includes("tidepool_render_component"));
  assert(names.includes("tidepool_render_html"));
  assert(names.includes("tidepool_render_file"));
  assert(names.includes("tidepool_update"));
  assert(names.includes("tidepool_clear"));
});

// ---------------------------------------------------------------------------
// Executor tests
// ---------------------------------------------------------------------------

Deno.test("executor: returns null for non-tidepool tool names", async () => {
  const executor = createTidepoolToolExecutor(() => undefined);
  const result = await executor("web_search", { query: "test" });
  assertEquals(result, null);
});

Deno.test("executor: returns error when getter returns undefined", async () => {
  const executor = createTidepoolToolExecutor(() => undefined);
  const result = await executor("tidepool_render_component", {
    label: "Test",
    tree: {},
  });
  assertEquals(
    result,
    "Tidepool is not connected. Visual workspace is unavailable.",
  );
});

Deno.test("executor: dispatches render_component correctly", async () => {
  const mockHost = createMockHost();
  const tools = createTidePoolTools(mockHost);
  const executor = createTidepoolToolExecutor(() => tools);

  const tree: ComponentTree = {
    root: card("x", "Title", "Body"),
    version: 1,
  };

  const result = await executor("tidepool_render_component", {
    label: "Test Render",
    tree,
  });
  assertStringIncludes(result!, 'Rendered component tree "Test Render"');
  assertStringIncludes(result!, "chars) in canvas.");
  assertStringIncludes(result!, "The user can see it now.");
  assertEquals(mockHost.canvasMessages.length, 1);
});

Deno.test("executor: dispatches render_html correctly", async () => {
  const mockHost = createMockHost();
  const tools = createTidePoolTools(mockHost);
  const executor = createTidepoolToolExecutor(() => tools);

  const result = await executor("tidepool_render_html", {
    label: "HTML Test",
    html: "<h1>Hello</h1>",
  });
  assertStringIncludes(result!, 'Rendered HTML "HTML Test"');
  assertStringIncludes(result!, "(14 chars) in canvas.");
  assertStringIncludes(result!, "The user can see it now.");
});

Deno.test("executor: dispatches render_file correctly", async () => {
  const mockHost = createMockHost();
  const tools = createTidePoolTools(mockHost);
  const executor = createTidepoolToolExecutor(() => tools);

  const result = await executor("tidepool_render_file", {
    label: "File Test",
    filename: "test.png",
    mime: "image/png",
    data: "iVBORw0KGgo=",
  });
  assertStringIncludes(result!, 'Rendered file "test.png"');
  assertStringIncludes(result!, "(image/png,");
  assertStringIncludes(result!, 'as "File Test"');
  assertStringIncludes(result!, "The user can see it now.");
});

Deno.test("executor: lazy getter works after wiring", async () => {
  // deno-lint-ignore prefer-const
  let tools: TidePoolTools | undefined;
  const executor = createTidepoolToolExecutor(() => tools);

  // Before wiring — should return not connected
  const before = await executor("tidepool_clear", {});
  assertEquals(
    before,
    "Tidepool is not connected. Visual workspace is unavailable.",
  );

  // Wire up the tools
  const mockHost = createMockHost();
  tools = createTidePoolTools(mockHost);

  // After wiring — should work
  const after = await executor("tidepool_clear", {});
  assertEquals(after, "Tidepool canvas cleared.");
});

// ---------------------------------------------------------------------------
// A2UIHost: session key authentication
// ---------------------------------------------------------------------------

Deno.test({
  name: "A2UIHost: rejects HTTP request without session key",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const host = createA2UIHost({ sessionKey: "secret-key-123" });
    await host.start(TEST_PORT + 20);

    try {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT + 20}`);
      assertEquals(res.status, 401);
      await res.body?.cancel();
    } finally {
      await host.stop();
    }
  },
});

Deno.test({
  name: "A2UIHost: rejects HTTP request with wrong session key",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const host = createA2UIHost({ sessionKey: "secret-key-123" });
    await host.start(TEST_PORT + 21);

    try {
      const res = await fetch(
        `http://127.0.0.1:${TEST_PORT + 21}?key=wrong-key`,
      );
      assertEquals(res.status, 401);
      await res.body?.cancel();
    } finally {
      await host.stop();
    }
  },
});

Deno.test({
  name: "A2UIHost: serves HTML with injected key when correct key provided",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const host = createA2UIHost({ sessionKey: "secret-key-123" });
    await host.start(TEST_PORT + 22);

    try {
      const res = await fetch(
        `http://127.0.0.1:${TEST_PORT + 22}?key=secret-key-123`,
      );
      assertEquals(res.status, 200);
      const body = await res.text();
      assertStringIncludes(body, "tidepool-key");
      assertStringIncludes(body, "secret-key-123");
    } finally {
      await host.stop();
    }
  },
});

Deno.test({
  name: "A2UIHost: rejects WebSocket without session key with 4401 close",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const host = createA2UIHost({ sessionKey: "secret-key-123" });
    await host.start(TEST_PORT + 23);

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT + 23}`);
      const closed = new Promise<CloseEvent>((resolve) => {
        ws.addEventListener("close", resolve);
      });
      const event = await closed;
      assertEquals(event.code, 4401);
      assertEquals(event.reason, "Unauthorized");
      assertEquals(host.connections, 0);
    } finally {
      await host.stop();
    }
  },
});

Deno.test({
  name: "A2UIHost: accepts WebSocket with correct session key",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const host = createA2UIHost({ sessionKey: "secret-key-123" });
    await host.start(TEST_PORT + 24);

    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${TEST_PORT + 24}?key=secret-key-123`,
      );
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      assertEquals(host.connections, 1);

      ws.close();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    } finally {
      await host.stop();
    }
  },
});

// ---------------------------------------------------------------------------
// buildTidepoolHtml
// ---------------------------------------------------------------------------

Deno.test("buildTidepoolHtml: returns valid HTML document", () => {
  const html = buildTidepoolHtml();
  const isBuiltUi = html.includes("canvas-panel");

  if (isBuiltUi) {
    assert(html.includes("canvas-frame"), "should contain canvas-frame");
    assert(
      html.includes("<!doctype html>") || html.includes("<!DOCTYPE html>"),
      "should be valid HTML document",
    );
    assert(html.includes('<div id="app">'), "should contain app mount point");
  } else {
    // Fallback page when tidepool-ui is not built
    assert(
      html.includes("Tidepool UI not built"),
      "fallback should indicate UI is not built",
    );
    assert(
      html.includes("<!DOCTYPE html>"),
      "fallback should be valid HTML document",
    );
  }
});
