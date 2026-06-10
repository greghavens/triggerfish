<script lang="ts">
  import type { ChatEvent, A2UIComponent } from "../../../lib/types.js";
  import DOMPurify from "dompurify";

  interface Props {
    payload: ChatEvent | null;
  }

  let { payload }: Props = $props();

  let iframeEl: HTMLIFrameElement;

  const CANVAS_CSS = `
    :root {
      --bg: #0a0e14; --bg2: #111820; --bg3: #1a2230;
      --fg: #d0dce8; --fg2: #8ba0b8; --accent: #3dffc0; --border: #1e2d3d;
      --font-sans: Inter, system-ui, sans-serif;
      --font-mono: "JetBrains Mono", monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg2); color: var(--fg); font-family: var(--font-sans); padding: 16px; font-size: 14px; line-height: 1.6; }
    .a2ui-card { background: var(--bg3); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 12px; }
    .a2ui-card h3 { color: var(--accent); margin-bottom: 8px; font-size: 16px; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0; }
    th, td { border: 1px solid var(--border); padding: 8px 12px; text-align: left; }
    th { background: var(--bg3); color: var(--accent); font-weight: 600; }
    pre, code { font-family: var(--font-mono); }
    pre { background: var(--bg); padding: 12px; border-radius: 8px; overflow-x: auto; }
    img { max-width: 100%; border-radius: 8px; }
    svg { max-width: 100%; }
    .a2ui-form { display: flex; flex-direction: column; gap: 12px; }
    .a2ui-form label { color: var(--fg2); font-size: 13px; }
    .a2ui-form input, .a2ui-form select, .a2ui-form textarea { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 8px; color: var(--fg); font-family: inherit; }
    .a2ui-layout-row { display: flex; gap: 12px; }
    .a2ui-layout-column { display: flex; flex-direction: column; gap: 12px; }
    h1 { font-size: 24px; margin-bottom: 12px; }
    h2 { font-size: 20px; margin-bottom: 8px; }
    h3 { font-size: 16px; margin-bottom: 6px; }
    p { margin-bottom: 8px; }
    a { color: var(--accent); }
  `;

  function renderComponent(node: A2UIComponent): string {
    const children = (node.children ?? []).map(renderComponent).join("");
    const p = node.props as Record<string, unknown>;

    switch (node.type) {
      case "card":
        return `<div class="a2ui-card"><h3>${esc(String(p.title ?? ""))}</h3>${p.content ? renderMd(String(p.content)) : children}</div>`;
      case "table": {
        const headers = (p.headers as string[]) ?? [];
        const rows = (p.rows as string[][]) ?? [];
        return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(String(c))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      }
      case "chart":
        return p.svg ? sanitizeSvg(String(p.svg)) : renderStructuredChart(p);
      case "form": {
        const fields = (p.fields as Array<{ label: string; type?: string; name: string }>) ?? [];
        return `<div class="a2ui-form">${fields.map((f) => `<label>${esc(f.label)}<input type="${f.type ?? "text"}" name="${esc(f.name)}"/></label>`).join("")}</div>`;
      }
      case "image":
        return `<img src="${esc(String(p.src ?? ""))}" alt="${esc(String(p.alt ?? ""))}" />`;
      case "markdown":
        return renderMd(String(p.content ?? ""));
      case "layout":
        return `<div class="a2ui-layout-${p.direction ?? "column"}">${children}</div>`;
      default:
        return children;
    }
  }

  function renderStructuredChart(p: Record<string, unknown>): string {
    // Simplified chart rendering as SVG
    const labels = (p.labels as string[]) ?? [];
    const values = (p.values as number[]) ?? [];
    if (labels.length === 0) return "";
    const max = Math.max(...values, 1);
    const w = 400;
    const h = 200;
    const barW = w / labels.length - 4;
    const bars = values
      .map((v, i) => {
        const bh = (v / max) * (h - 30);
        const x = i * (barW + 4) + 2;
        const y = h - 30 - bh;
        return `<rect x="${x}" y="${y}" width="${barW}" height="${bh}" fill="var(--accent)" rx="2"/><text x="${x + barW / 2}" y="${h - 14}" text-anchor="middle" fill="var(--fg2)" font-size="10">${esc(labels[i])}</text>`;
      })
      .join("");
    return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">${bars}</svg>`;
  }

  function renderMd(text: string): string {
    const html = text
      .replace(/```(\w*)\n([\s\S]*?)```/g, "<pre><code>$2</code></pre>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/^### (.+)$/gm, "<h3>$1</h3>")
      .replace(/^## (.+)$/gm, "<h2>$1</h2>")
      .replace(/^# (.+)$/gm, "<h1>$1</h1>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br/>");
    // Sanitize: agent-supplied content must not inject scripts/handlers, even
    // though the canvas iframe is already a null-origin (allow-scripts) sandbox.
    return DOMPurify.sanitize(html);
  }

  function sanitizeSvg(svg: string): string {
    return DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
    });
  }

  function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function buildDoc(): string {
    if (!payload) return "";

    let body = "";
    switch (payload.type) {
      case "canvas_render_component":
        body = renderComponent(payload.tree?.root as A2UIComponent);
        break;
      case "canvas_render_html":
        body = payload.html as string;
        break;
      case "canvas_render_file": {
        const mime = payload.mime as string;
        const data = payload.data as string;
        const filename = payload.filename as string;
        if (mime.startsWith("image/")) {
          body = `<img src="data:${mime};base64,${data}" alt="${esc(filename)}" />`;
        } else if (mime === "application/pdf") {
          body = `<embed src="data:${mime};base64,${data}" type="application/pdf" width="100%" height="600px" />`;
        } else {
          try {
            const text = atob(data);
            body = `<pre><code>${esc(text)}</code></pre>`;
          } catch {
            body = `<p>Cannot preview ${esc(filename)}</p>`;
          }
        }
        const dl = `data:${mime};base64,${data}`;
        body += `<p style="margin-top:12px"><a href="${dl}" download="${esc(filename)}" style="color:var(--accent)">Download ${esc(filename)}</a></p>`;
        break;
      }
    }

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${CANVAS_CSS}</style></head><body>${body}</body></html>`;
  }

  const srcdoc = $derived(buildDoc());
</script>

<iframe
  bind:this={iframeEl}
  {srcdoc}
  title="Canvas"
  sandbox="allow-scripts"
  class="canvas-frame"
></iframe>

<style>
  .canvas-frame {
    width: 100%;
    height: 100%;
    border: none;
    background: var(--bg2);
  }
</style>
