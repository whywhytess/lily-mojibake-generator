// Public entry point for the video input pipeline.
//
// Only the lightweight stages (validate + native probe) are imported statically.
// Mediabunny (tiers 2/3) and FFmpeg.wasm (tier 4) live behind dynamic `import()`
// so the app never pays for them on entry — they load on demand.
import { canPlayNatively } from "./native";
import { validateFile } from "./validate";
import { VideoInputError, type PrepareHooks, type PrepareResult, type PrepareSource } from "./types";

export * from "./types";

export async function prepareVideo(file: File, hooks: PrepareHooks = {}): Promise<PrepareResult> {
  const abortCheck = () => {
    if (hooks.signal?.aborted) throw new VideoInputError("已取消", "aborted");
  };

  hooks.onStage?.("validating");
  await validateFile(file);
  abortCheck();

  // Tier 1 — the browser can already play it, use as-is.
  hooks.onStage?.("probing");
  if (await canPlayNatively(file)) {
    return makeResult(file, "native", false, file.name);
  }
  abortCheck();

  // Tiers 2 & 3 — Mediabunny remux / WebCodecs transcode (lazy-loaded).
  hooks.onStage?.("inspecting");
  try {
    const { convert } = await import("./convert");
    const { blob, source } = await convert(file, hooks);
    abortCheck();
    return makeResult(blob, source, true, file.name);
  } catch (err) {
    // A cancel is final; anything else (unsupported / failed) falls through to
    // the FFmpeg last resort.
    if (err instanceof VideoInputError && err.code === "aborted") throw err;

    // Tier 4 — FFmpeg.wasm (lazy-loaded, heaviest).
    hooks.onStage?.("ffmpeg");
    const { transcodeWithFfmpeg } = await import("./ffmpeg");
    const blob = await transcodeWithFfmpeg(file, hooks);
    abortCheck();
    return makeResult(blob, "ffmpeg", true, file.name);
  }
}

function makeResult(source: Blob, kind: PrepareSource, transformed: boolean, fileName: string): PrepareResult {
  const url = URL.createObjectURL(source);
  return { url, source: kind, transformed, fileName, cleanup: () => URL.revokeObjectURL(url) };
}
