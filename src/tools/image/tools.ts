/**
 * Image analysis tool for the agent.
 *
 * Reads an image file, base64-encodes it, and sends it to a
 * vision-capable LLM provider for analysis. Returns the text
 * description from the provider.
 *
 * @module
 */

import type { ToolDefinition } from "../../core/types/tool.ts";
import type { LlmProvider, LlmProviderRegistry } from "../../core/types/llm.ts";

/** MIME type mapping for common image extensions. */
const MIME_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

/** Get image tool definitions for the agent orchestrator. */
export function buildImageToolDefinitions(): readonly ToolDefinition[] {
  return [
    {
      name: "image_analyze",
      description:
        "Analyze an image file using a vision-capable LLM. Returns a text description or answers a question about the image.",
      parameters: {
        path: {
          type: "string",
          description: "Absolute path to the image file",
          required: true,
        },
        prompt: {
          type: "string",
          description:
            "Optional question or prompt about the image (default: describe the image)",
          required: false,
        },
      },
    },
  ];
}

/** System prompt section explaining image analysis to the LLM. */
export const IMAGE_TOOLS_SYSTEM_PROMPT = `## Image Analysis

You can analyze images using the image_analyze tool.

- Provide an absolute file path to the image.
- Optionally provide a prompt/question about the image.
- Supported formats: PNG, JPEG, GIF, WebP, BMP, SVG.
- The image is sent to a vision-capable LLM provider for analysis.`;

/**
 * Create a tool executor for image analysis.
 *
 * Returns null for non-image tool names (allowing chaining).
 *
 * @param registry - LLM provider registry for accessing vision models
 * @returns An executor function: (name, input) => Promise<string | null>
 */
export function createImageToolExecutor(
  registry: LlmProviderRegistry | undefined,
  visionProvider?: LlmProvider,
): (name: string, input: Record<string, unknown>) => Promise<string | null> {
  return async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string | null> => {
    if (name !== "image_analyze") return null;

    if (!registry) {
      return "Image analysis is not available (no provider registry).";
    }

    const path = input.path;
    if (typeof path !== "string" || path.length === 0) {
      return "Error: image_analyze requires a non-empty 'path' argument (string).";
    }

    const prompt = typeof input.prompt === "string" && input.prompt.length > 0
      ? input.prompt
      : "Describe this image in detail.";

    // Detect MIME type from extension
    const ext = path.substring(path.lastIndexOf(".")).toLowerCase();
    const mimeType = MIME_TYPES[ext];
    if (!mimeType) {
      return `Error: Unsupported image format '${ext}'. Supported: ${
        Object.keys(MIME_TYPES).join(", ")
      }`;
    }

    // Read and base64-encode the image
    let base64Data: string;
    try {
      const bytes = await Deno.readFile(path);
      // Chunk to avoid call stack overflow on large buffers
      const chunks: string[] = [];
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const slice = bytes.subarray(i, i + chunkSize);
        chunks.push(String.fromCharCode(...slice));
      }
      base64Data = btoa(chunks.join(""));
    } catch (err) {
      return `Error reading image: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }

    // Send to vision-capable provider: prefer dedicated vision provider
    const provider = visionProvider ?? registry.getDefault();
    if (!provider) {
      return "Error: No LLM provider available for image analysis.";
    }

    try {
      const messages = [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mimeType,
                data: base64Data,
              },
            },
            {
              type: "text",
              text: prompt,
            },
          ],
        },
      ];
      const result = await provider.complete(messages, [], {});
      return result.content;
    } catch (err) {
      return `Error analyzing image: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  };
}

/** @deprecated Use buildImageToolDefinitions instead */
export const getImageToolDefinitions = buildImageToolDefinitions;
