// Tier 4 of the pipeline — the last-resort transcoder.
//
// FFmpeg.wasm (~31 MB) is NEVER touched on page entry: `@ffmpeg/ffmpeg` and
// `@ffmpeg/util` are pulled in via dynamic `import()` only inside these
// functions, and the wasm core is fetched from the self-hosted `/ffmpeg/` path
// the first time this stage actually runs.
import type { FFmpeg } from "@ffmpeg/ffmpeg";
import { VideoInputError, type PrepareHooks } from "./types";

let ffmpegPromise: Promise<FFmpeg> | null = null;

async function getFfmpeg(): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const { FFmpeg } = await import("@ffmpeg/ffmpeg");
      const ff = new FFmpeg();
      const base = window.location.origin;
      await ff.load({
        coreURL: new URL("/ffmpeg/ffmpeg-core.js", base).href,
        wasmURL: new URL("/ffmpeg/ffmpeg-core.wasm", base).href,
      });
      return ff;
    })();
  }
  return ffmpegPromise;
}

const extOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : ".bin";
};

export async function transcodeWithFfmpeg(file: File, hooks: PrepareHooks): Promise<Blob> {
  if (hooks.signal?.aborted) throw new VideoInputError("已取消", "aborted");

  const { fetchFile } = await import("@ffmpeg/util");
  const ff = await getFfmpeg();

  const onProgress = ({ progress }: { progress: number }) =>
    hooks.onProgress?.(Math.max(0, Math.min(1, progress)));
  const onAbort = () => {
    try { ff.terminate(); } finally { ffmpegPromise = null; } // a terminated core must be reloaded
  };
  ff.on("progress", onProgress);
  hooks.signal?.addEventListener("abort", onAbort, { once: true });
  // The abort may have fired while the core was loading, before the listener was
  // attached — tear down now rather than transcode a clip already cancelled.
  if (hooks.signal?.aborted) { onAbort(); throw new VideoInputError("已取消", "aborted"); }

  const inputName = `input${extOf(file.name)}`;
  const outputName = "output.mp4";
  try {
    await ff.writeFile(inputName, await fetchFile(file));
    const code = await ff.exec([
      "-i", inputName,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k",
      "-movflags", "+faststart",
      outputName,
    ]);
    if (code !== 0) throw new VideoInputError("FFmpeg 转码失败", "failed");
    const data = await ff.readFile(outputName);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    return new Blob([bytes], { type: "video/mp4" });
  } catch (err) {
    if (hooks.signal?.aborted) throw new VideoInputError("已取消", "aborted");
    if (err instanceof VideoInputError) throw err;
    throw new VideoInputError("FFmpeg 转码失败", "failed");
  } finally {
    ff.off("progress", onProgress);
    hooks.signal?.removeEventListener("abort", onAbort);
    if (ffmpegPromise) {
      // Best-effort cleanup of the in-memory FS so repeat runs stay lean.
      try { await ff.deleteFile(inputName); } catch { /* ignore */ }
      try { await ff.deleteFile(outputName); } catch { /* ignore */ }
    }
  }
}
