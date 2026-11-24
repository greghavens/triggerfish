/** Atomically publish bounded, private operator-managed Sentinel data. */
import { dirname } from "@std/path";
import { MAX_SNAPSHOT_BYTES } from "./chat_mode.ts";

export async function publishSentinelInput(
  output: string,
  value: unknown,
): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > MAX_SNAPSHOT_BYTES) {
    throw new Error("Sentinel chat input exceeds 1 MiB");
  }
  const dir = dirname(output);
  await Deno.mkdir(dir, { mode: 0o700, recursive: true });
  const temp = await Deno.makeTempFile({ dir, prefix: ".sentinel-" });
  try {
    await Deno.writeFile(temp, bytes);
    await Deno.rename(temp, output);
  } catch (error) {
    await Deno.remove(temp).catch(() => {});
    throw error;
  }
}
