// Copies the self-hosted, single-threaded FFmpeg.wasm core into public/ffmpeg/
// so the app can lazy-load it same-origin (no CDN, no COOP/COEP needed).
//
// Runs on `postinstall`; the generated files are git-ignored and regenerated
// from node_modules on every install / deploy.
import { access, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "@ffmpeg", "core", "dist", "umd");
const dest = join(root, "public", "ffmpeg");
const files = ["ffmpeg-core.js", "ffmpeg-core.wasm"];

try {
  await access(join(src, "ffmpeg-core.wasm"));
} catch {
  console.warn("[copy-ffmpeg-core] @ffmpeg/core not installed; skipping copy.");
  process.exit(0);
}

await mkdir(dest, { recursive: true });
for (const file of files) {
  await copyFile(join(src, file), join(dest, file));
}
console.log(`[copy-ffmpeg-core] copied ${files.join(", ")} -> public/ffmpeg/`);
