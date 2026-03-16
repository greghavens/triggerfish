/**
 * Vision fallback for non-vision LLM models.
 *
 * When the primary model doesn't support images, this module uses a
 * vision-capable provider to describe images in the user's message,
 * replacing image blocks with text descriptions.
 *
 * @module
 */

import type {
  ContentBlock,
  ImageContentBlock,
} from "../../core/image/content.ts";
import type { MessageContent } from "../../core/image/content.ts";
import { hasImages, normalizeContent } from "../../core/image/content.ts";
import type { LlmMessage, LlmProvider } from "../llm.ts";
import type { HistoryEntry } from "./orchestrator_types.ts";
import type { OrchestratorState } from "./orchestrator.ts";
import { createLogger } from "../../core/logger/mod.ts";

const log = createLogger("agent.vision");

/** Build a vision description request message for a single image. */
function buildImageDescriptionMessage(
  image: ImageContentBlock,
): LlmMessage {
  return {
    role: "user",
    content: [
      { type: "image", source: image.source },
      {
        type: "text",
        text: "Describe this image in detail. Be specific about what you see.",
      },
    ],
  };
}

/** Describe a single image using the vision provider. */
async function describeImageWithVisionProvider(
  image: ImageContentBlock,
  visionProvider: LlmProvider,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const result = await visionProvider.complete(
      [buildImageDescriptionMessage(image)],
      [],
      { ...(signal ? { signal } : {}) },
    );
    return result.content;
  } catch (err) {
    log.debug("Vision image description unavailable", { operation: "describeImage", err });
    const msg = err instanceof Error ? err.message : String(err);
    return `[Image description unavailable: ${msg}]`;
  }
}

/** Describe multiple images using the vision provider. */
async function transcribeImagesForNonVisionModel(
  images: readonly ImageContentBlock[],
  visionProvider: LlmProvider,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const descriptions: string[] = [];
  for (const image of images) {
    descriptions.push(
      await describeImageWithVisionProvider(image, visionProvider, signal),
    );
  }
  return descriptions;
}

/** Build text-only message by inlining vision descriptions where images were. */
function buildTextOnlyFromImageDescriptions(
  blocks: readonly ContentBlock[],
  descriptions: readonly string[],
): string {
  const parts: string[] = [];
  let descIdx = 0;
  for (const block of blocks) {
    if (block.type === "image") {
      parts.push(
        `[The user shared an image. A vision model described it as follows: ${
          descriptions[descIdx++]
        }]`,
      );
    } else {
      parts.push(block.text);
    }
  }
  return parts.join("\n\n");
}

/** The image-description addendum appended to the system prompt. */
const IMAGE_DESCRIPTION_ADDENDUM = "\n\n## Image Descriptions\n" +
  "The user's message may contain image descriptions provided by a vision model " +
  "in brackets like [The user shared an image. A vision model described it as follows: ...]. " +
  "Treat these descriptions as if you can see the images yourself. " +
  "Do NOT use image_analyze or any other tool to re-examine these images — the descriptions are already complete.";

/** Process vision fallback: describe images and replace history entry. */
export async function orchestrateVisionFallback(
  state: OrchestratorState,
  message: MessageContent,
  history: HistoryEntry[],
  signal: AbortSignal | undefined,
): Promise<string> {
  if (!state.visionProvider || typeof message === "string") return "";
  if (!hasImages(message as readonly ContentBlock[])) return "";

  const blocks = normalizeContent(message);
  const images = blocks.filter(
    (b): b is ImageContentBlock => b.type === "image",
  );

  state.emit({ type: "vision_start", imageCount: images.length });
  const descriptions = await transcribeImagesForNonVisionModel(
    images,
    state.visionProvider,
    signal,
  );
  state.emit({ type: "vision_complete", imageCount: images.length });

  const textOnly = buildTextOnlyFromImageDescriptions(blocks, descriptions);
  history[history.length - 1] = { role: "user", content: textOnly };
  return IMAGE_DESCRIPTION_ADDENDUM;
}

/** @deprecated Use orchestrateVisionFallback instead */
export const processVisionFallback = orchestrateVisionFallback;
