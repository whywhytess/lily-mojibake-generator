/**
 * Decide whether the browser can play a file directly, with no conversion.
 *
 * `canPlayType` is a fast advisory first pass, but it is frequently `""` for
 * files with an empty MIME (e.g. MKV), so we always confirm by actually loading
 * the media and waiting for a decoded frame (`loadeddata`). Waiting for
 * `loadeddata` rather than `loadedmetadata` means the video codec really decoded,
 * which is a much better signal for playability than "the container parsed".
 */
export async function canPlayNatively(file: Blob, timeoutMs = 8000): Promise<boolean> {
  if (typeof document === "undefined") return false;

  const probe = document.createElement("video");
  const url = URL.createObjectURL(file);

  try {
    return await new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        probe.removeEventListener("loadeddata", onOk);
        probe.removeEventListener("error", onErr);
        window.clearTimeout(timer);
        probe.removeAttribute("src");
        probe.load();
        resolve(ok);
      };
      const onOk = () => done(probe.videoWidth > 0);
      const onErr = () => done(false);
      const timer = window.setTimeout(() => done(false), timeoutMs);

      probe.addEventListener("loadeddata", onOk, { once: true });
      probe.addEventListener("error", onErr, { once: true });
      probe.muted = true;
      probe.preload = "auto";
      probe.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
