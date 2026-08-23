// Tiers 2 & 3 of the pipeline, powered by Mediabunny + WebCodecs.
//
// IMPORTANT: `mediabunny` is only ever pulled in via the dynamic `import()`
// below. The top-level `import type` is erased at compile time, so nothing here
// adds Mediabunny to the entry bundle — it loads on demand, when a non-native
// file first appears.
import type { ConversionOptions, Input, InputVideoTrack } from "mediabunny";
import { canPlayNatively } from "./native";
import { VideoInputError, type PrepareHooks } from "./types";

type Mediabunny = typeof import("mediabunny");
type ConversionTrackOptions = Pick<ConversionOptions, "video" | "audio">;

/** Video codecs that play inside an MP4 container across all target browsers, */
/** so swapping the container alone (remux, no re-encode) is enough. */
const REMUX_VIDEO_OK = new Set(["avc"]); // H.264
const REMUX_AUDIO_OK = new Set(["aac", "mp3"]);

export interface ConvertResult {
  blob: Blob;
  source: "remux" | "webcodecs";
}

export async function convert(file: File, hooks: PrepareHooks): Promise<ConvertResult> {
  const mb = await import("mediabunny");
  const { Input, BlobSource, ALL_FORMATS, canEncodeVideo, canEncodeAudio } = mb;

  const inspect = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let videoTrack: InputVideoTrack | null;
  try {
    videoTrack = await inspect.getPrimaryVideoTrack();
  } catch {
    throw new VideoInputError("无法解析该文件", "unsupported");
  }
  if (!videoTrack) throw new VideoInputError("文件中没有视频轨", "unsupported");

  const audioTrack = await inspect.getPrimaryAudioTrack();
  const vCodec = videoTrack.codec;
  const aCodec = audioTrack?.codec ?? null;

  // --- Tier 2: remux (container swap only, no re-encode) ---
  if (vCodec && REMUX_VIDEO_OK.has(vCodec) && (!aCodec || REMUX_AUDIO_OK.has(aCodec))) {
    hooks.onStage?.("remuxing");
    const blob = await runConversion(mb, file, {}, hooks);
    // Confirm the remuxed file really is natively playable before trusting it.
    if (await canPlayNatively(blob)) return { blob, source: "remux" };
    // Otherwise fall through to a full transcode.
  }

  // --- Tier 3: WebCodecs transcode to H.264 / AAC ---
  hooks.onStage?.("transcoding");
  const [videoDecodable, h264Encodable] = await Promise.all([
    videoTrack.canDecode(),
    canEncodeVideo("avc"),
  ]);
  const audioDecodable = audioTrack ? await audioTrack.canDecode() : true;
  const aacEncodable = audioTrack ? await canEncodeAudio("aac") : true;
  if (!videoDecodable || !h264Encodable || !audioDecodable || !aacEncodable) {
    // WebCodecs can't handle this input — let the caller fall back to FFmpeg.
    throw new VideoInputError("WebCodecs 无法处理此格式", "unsupported");
  }

  const blob = await runConversion(
    mb,
    file,
    {
      video: { codec: "avc", forceTranscode: true },
      audio: { codec: "aac", forceTranscode: true },
    },
    hooks,
  );
  return { blob, source: "webcodecs" };
}

async function runConversion(
  mb: Mediabunny,
  file: File,
  tracks: ConversionTrackOptions,
  hooks: PrepareHooks,
): Promise<Blob> {
  const { Input, BlobSource, ALL_FORMATS, Output, Mp4OutputFormat, BufferTarget, Conversion, ConversionCanceledError } = mb;

  if (hooks.signal?.aborted) throw new VideoInputError("已取消", "aborted");

  // A fresh Input per conversion so tiers don't share a consumed reader.
  const input: Input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });
  const conversion = await Conversion.init({ input, output, ...tracks });

  if (!conversion.isValid) throw new VideoInputError("无法转换该文件", "unsupported");
  if (hooks.onProgress) conversion.onProgress = (p) => hooks.onProgress?.(p);

  const onAbort = () => { void conversion.cancel(); };
  hooks.signal?.addEventListener("abort", onAbort, { once: true });
  // Abort may have fired while Mediabunny was loading / initialising, before the
  // listener above was attached — cancel now so we don't start a stale convert.
  if (hooks.signal?.aborted) { void conversion.cancel(); throw new VideoInputError("已取消", "aborted"); }

  try {
    await conversion.execute();
  } catch (err) {
    if (err instanceof ConversionCanceledError) throw new VideoInputError("已取消", "aborted");
    throw new VideoInputError("转换失败", "failed");
  } finally {
    hooks.signal?.removeEventListener("abort", onAbort);
  }

  if (!target.buffer) throw new VideoInputError("转换输出为空", "failed");
  return new Blob([target.buffer], { type: "video/mp4" });
}
