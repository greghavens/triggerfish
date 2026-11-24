import { assert, assertEquals, assertRejects } from "@std/assert";
import type { Page } from "puppeteer-core";
import { createBrowserManager } from "../../../src/tools/browser/manager/manager.ts";
import { createDomainPolicy } from "../../../src/tools/browser/domains.ts";
import { createMemoryStorage } from "../../../src/core/storage/memory.ts";
import { buildTidepoolHtml } from "../../../src/tools/tidepool/ui.ts";

const chromiumPath = Deno.env.get("TRIGGERFISH_TEST_CHROME");

Deno.test({
  name:
    "real Chrome: pinned HTTP/WebSocket egress, private denial, UI routes and SVG sanitization",
  ignore: !chromiumPath,
  // Puppeteer's Node transport owns process resources outside Deno's tracker.
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const profileBaseDir = await Deno.makeTempDir();
    const sockets = new Set<WebSocket>();
    const requests: string[] = [];
    const seen: string[] = [];
    let rebound = false;
    const privateServer = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen() {},
    }, (request) => {
      requests.push("PRIVATE:" + request.url);
      return new Response("private data", {
        headers: { "access-control-allow-origin": "*" },
      });
    });
    const origin = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      (request) => {
        const path = new URL(request.url).pathname;
        requests.push(path);
        if (request.headers.get("upgrade") === "websocket") {
          const { socket, response } = Deno.upgradeWebSocket(request);
          sockets.add(socket);
          socket.onclose = () => sockets.delete(socket);
          socket.onopen = () => {
            if (path === "/ws") socket.send("proxied websocket");
            else {
              socket.send(
                JSON.stringify({
                  type: "connected",
                  provider: "test",
                  model: "test",
                  workspace: "test",
                  taint: "PUBLIC",
                }),
              );
              socket.send(
                JSON.stringify({
                  type: "canvas_render_component",
                  id: "xss-probe",
                  label: "SVG test",
                  tree: {
                    version: 1,
                    root: {
                      id: "chart",
                      type: "chart",
                      props: {
                        svg:
                          '<svg xmlns="http://www.w3.org/2000/svg" onload="parent.__svgProbe=true"><script>parent.__svgProbe=true</script><rect width="10" height="10"/></svg>',
                      },
                    },
                  },
                }),
              );
            }
          };
          return response;
        }
        return new Response(
          path === "/ui" ? buildTidepoolHtml() : "approved origin",
          {
            headers: {
              "content-type": path === "/ui" ? "text/html" : "text/plain",
              "connection": "close",
              "access-control-allow-origin": "*",
            },
          },
        );
      },
    );
    const manager = createBrowserManager({
      chromiumPath,
      profileBaseDir,
      headless: true,
      launchArgs: ["--no-sandbox"],
      domainPolicy: createDomainPolicy({
        classifications: {},
        allowList: [],
        denyList: [],
      }),
      storage: createMemoryStorage(),
      egressResolver: (hostname) => {
        seen.push(hostname);
        return Promise.resolve(
          (hostname === "approved.invalid" && !rebound) ||
            hostname === "ws.approved.invalid"
            ? { ok: true, value: "127.0.0.1" }
            : { ok: false, error: "Test DNS answer is private" },
        );
      },
    });
    try {
      const launched = await manager.launch("egress-test", "PUBLIC");
      assert(launched.ok, launched.ok ? "" : launched.error);
      const page = launched.value.page as Page;
      await page.setCacheEnabled(false);
      const base = `http://approved.invalid:${origin.addr.port}`;
      await page.goto(base);
      assertEquals(
        await page.$eval("body", (element) => element.textContent),
        "approved origin",
      );
      const websocket = await page.evaluate(
        (port) =>
          new Promise<string>((resolve) => {
            const socket = new WebSocket(`ws://ws.approved.invalid:${port}/ws`);
            socket.onmessage = (event) => {
              socket.close();
              resolve(String(event.data));
            };
            socket.onerror = () => resolve("failed");
          }),
        origin.addr.port,
      );
      assertEquals(websocket, "proxied websocket");
      const deniedSocket = await page.evaluate(
        (port) =>
          new Promise<string>((resolve) => {
            const socket = new WebSocket(
              `ws://private.invalid:${port}/private`,
            );
            socket.onmessage = () => {
              socket.close();
              resolve("leaked");
            };
            socket.onerror = () => resolve("blocked");
          }),
        privateServer.addr.port,
      );
      assertEquals(deniedSocket, "blocked");
      await assertRejects(() =>
        page.goto(`http://127.0.0.1:${privateServer.addr.port}/private`)
      );
      assert(
        seen.includes("127.0.0.1"),
        "Literal localhost must reach the proxy rather than bypass it",
      );
      await page.goto(base + "/ui");
      await page.waitForSelector(".canvas-frame");
      const frame = await (await page.$(".canvas-frame"))!.contentFrame();
      assert(frame);
      await frame.waitForSelector("svg");
      assertEquals(
        await frame.$eval("svg", (element) => element.hasAttribute("onload")),
        false,
      );
      assertEquals(
        await frame.$$("script").then((elements) => elements.length),
        0,
      );
      assertEquals(
        await page.evaluate(() => Reflect.get(globalThis, "__svgProbe")),
        undefined,
      );
      for (
        const screen of [
          "chat",
          "agents",
          "workflows",
          "health",
          "settings",
          "logs",
          "memory",
        ]
      ) {
        const label = screen[0].toUpperCase() + screen.slice(1);
        await page.click(`button.nav-item[title="${label}"]`);
        await page.waitForSelector(`.${screen}-screen`);
      }
      rebound = true;
      await assertRejects(() =>
        page.goto(`http://approved.invalid:${privateServer.addr.port}/rebound`)
      );
      assertEquals(
        requests.some((request) => request.startsWith("PRIVATE:")),
        false,
      );
      assert(seen.includes("private.invalid"));
    } finally {
      await manager.close("egress-test");
      for (const socket of sockets) socket.close();
      await origin.shutdown();
      await privateServer.shutdown();
      await Deno.remove(profileBaseDir, { recursive: true });
    }
  },
});
