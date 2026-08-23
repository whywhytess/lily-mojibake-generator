import { VideoInputError } from "./types";

/** Soft ceiling — in-browser transcoding above this gets painful. */
const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

/**
 * Container magic-byte sniffers. Many containers (notably Matroska/MKV) arrive
 * with an empty `File.type`, so we look at the header rather than trusting the
 * reported MIME string.
 */
const MAGIC: { label: string; test: (b: Uint8Array) => boolean }[] = [
  // ISO-BMFF: MP4 / MOV / M4V — "ftyp" box type at bytes 4..8
  { label: "mp4", test: (b) => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 },
  // Matroska / WebM — EBML header 1A 45 DF A3
  { label: "matroska", test: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  // AVI — "RIFF"...."AVI "
  { label: "avi", test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x41 && b[9] === 0x56 && b[10] === 0x49 },
  // FLV — "FLV"
  { label: "flv", test: (b) => b[0] === 0x46 && b[1] === 0x4c && b[2] === 0x56 },
  // Ogg — "OggS"
  { label: "ogg", test: (b) => b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53 },
];

/** Extensions we treat as video even when MIME + magic are inconclusive. */
const VIDEO_EXT = /\.(mp4|m4v|mov|qt|mkv|webm|avi|flv|ts|m2ts|mts|wmv|asf|mpg|mpeg|m2v|ogv|3gp|3g2|vob|divx)$/i;

export interface ValidationResult {
  /** Sniffed container label, or "unknown". */
  container: string;
}

/**
 * Cheap gate before any heavy work: reject empty / oversized / clearly-non-video
 * uploads, but stay permissive about unusual containers so the pipeline can try
 * to convert them.
 */
export async function validateFile(file: File): Promise<ValidationResult> {
  if (!file || file.size === 0) throw new VideoInputError("空文件", "invalid");
  if (file.size > MAX_BYTES) throw new VideoInputError("文件过大(超过 2GB)", "invalid");

  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const hit = MAGIC.find((m) => m.test(head));
  const looksVideo = file.type.startsWith("video/") || file.type.startsWith("audio/");
  const extOk = VIDEO_EXT.test(file.name);

  if (!hit && !looksVideo && !extOk) {
    throw new VideoInputError("无法识别为视频文件", "invalid");
  }
  return { container: hit?.label ?? "unknown" };
}
