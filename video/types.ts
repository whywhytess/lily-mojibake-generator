/**
 * Shared types for the video input pipeline.
 *
 * The pipeline turns an arbitrary uploaded file into a source the browser can
 * play, escalating through progressively heavier stages and stopping at the
 * first that succeeds:
 *
 *   1. native     — the browser can already play it, no conversion
 *   2. remux      — Mediabunny swaps the container only (no re-encode)
 *   3. webcodecs  — Mediabunny re-encodes via WebCodecs (hardware) to H.264/AAC
 *   4. ffmpeg     — lazy-loaded FFmpeg.wasm transcodes as a last resort
 */

export type PrepareStage =
  | "validating"
  | "probing"
  | "inspecting"
  | "remuxing"
  | "transcoding"
  | "ffmpeg";

export type PrepareSource = "native" | "remux" | "webcodecs" | "ffmpeg";

export type VideoErrorCode = "invalid" | "unsupported" | "aborted" | "failed";

export interface PrepareHooks {
  /** Called as the pipeline advances through its stages. */
  onStage?: (stage: PrepareStage) => void;
  /** Progress within a remux/transcode stage, 0..1. */
  onProgress?: (ratio: number) => void;
  /** Abort the whole preparation (cancels an in-flight remux/transcode). */
  signal?: AbortSignal;
}

export interface PrepareResult {
  /** A `blob:` URL the browser can play. */
  url: string;
  /** Which stage produced the result. */
  source: PrepareSource;
  /** False only when the original file was used untouched (native). */
  transformed: boolean;
  /** Original upload name. */
  fileName: string;
  /** Revokes the object URL. Call when the source is replaced or removed. */
  cleanup: () => void;
}

export class VideoInputError extends Error {
  code: VideoErrorCode;
  constructor(message: string, code: VideoErrorCode) {
    super(message);
    this.name = "VideoInputError";
    this.code = code;
  }
}
