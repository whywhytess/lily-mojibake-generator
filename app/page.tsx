"use client";

import type { CSSProperties, ChangeEvent, DragEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBurst, stepAt, type MojibakeBurst } from "./mojibake";
import { prepareVideo, VideoInputError, type PrepareStage } from "@/video";
import { GIFEncoder, quantize, applyPalette } from "gifenc";

// Free trial export: a short, silent GIF. The full version (original audio,
// full length, video export) lives at the paid site.
const FULL_VERSION_URL = "lily.whywhyte55.com";
const GIF_MAX_SECONDS = 5;
const GIF_FPS = 12;
const GIF_WIDTH = 480;
const GIF_HEIGHT = 270;

const STAGE_TEXT: Record<PrepareStage, string> = {
  validating: "校验文件…",
  probing: "检测浏览器兼容性…",
  inspecting: "解析容器 / 编码…",
  remuxing: "重封装容器(不重编码)…",
  transcoding: "硬件转码中…",
  ffmpeg: "FFmpeg 转码中…",
};

type TransitionMode = "black" | "flash" | "none";
type TextEvent = { id: number; start: number; duration: number; text: string; seed: number; speed: number; apple: boolean };

const randomSeed = () => Math.floor(Math.random() * 9000) + 1000;

const formatTime = (value: number) => {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  const minutes = Math.floor(safe / 60).toString().padStart(2, "0");
  const seconds = Math.floor(safe % 60).toString().padStart(2, "0");
  const frames = Math.floor((safe % 1) * 25).toString().padStart(2, "0");
  return `${minutes}:${seconds}:${frames}`;
};

const drawCover = (ctx: CanvasRenderingContext2D, video: HTMLVideoElement, width: number, height: number) => {
  const videoRatio = video.videoWidth / video.videoHeight;
  const outputRatio = width / height;
  let sw = video.videoWidth, sh = video.videoHeight, sx = 0, sy = 0;
  if (videoRatio > outputRatio) { sw = video.videoHeight * outputRatio; sx = (video.videoWidth - sw) / 2; }
  else { sh = video.videoWidth / outputRatio; sy = (video.videoHeight - sh) / 2; }
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);
};

const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/* Seek a paused <video> to a time and resolve once the frame is ready. A short
   timeout guards against a stalled seek trapping the export loop. */
const seekVideo = (video: HTMLVideoElement, time: number) => new Promise<void>((resolve) => {
  let done = false;
  const finish = () => { if (done) return; done = true; video.removeEventListener("seeked", finish); resolve(); };
  video.addEventListener("seeked", finish, { once: true });
  video.currentTime = time;
  window.setTimeout(finish, 200);
});

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const cancelExportRef = useRef(false);
  const prepareAbortRef = useRef<AbortController | null>(null);
  const nextTextId = useRef(2);
  const [videoUrl, setVideoUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const [videoSize, setVideoSize] = useState("— × —");
  const [stageHeight, setStageHeight] = useState(0);
  const [duration, setDuration] = useState(12);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(12);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [textEvents, setTextEvents] = useState<TextEvent[]>([{ id: 1, start: 1, duration: 4.2, text: "《彼女が生まれたのは、》", seed: 4179, speed: 1, apple: false }]);
  const [selectedTextId, setSelectedTextId] = useState(1);
  const [fontScale, setFontScale] = useState(4.61);
  const [mode, setMode] = useState<TransitionMode>("black");
  const [isDragging, setIsDragging] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [notice, setNotice] = useState("SELECT SOURCE 上传视频后即可开始剪辑");
  const [showUpsell, setShowUpsell] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [prepareProgress, setPrepareProgress] = useState(0);

  const segmentDuration = Math.max(.1, trimEnd - trimStart);
  const selectedText = textEvents.find((event) => event.id === selectedTextId) ?? textEvents[0];
  const activeText = textEvents.find((event) => currentTime >= event.start && currentTime < event.start + event.duration);
  /* With no source video the preview runs on a plain colour card whose length
     tracks the subtitles — long enough to hold the last line plus a short tail. */
  const contentDuration = useMemo(() => Math.max(4, textEvents.reduce((max, event) => Math.max(max, event.start + event.duration), 0) + 0.6), [textEvents]);
  /* The timeline spans the whole clip so the trim region and every subtitle can
     be dragged inside it against one absolute scale. While a clip is being
     dragged the scale is frozen, so moving one clip never re-scales — and so
     visibly shifts — the others. */
  const [frozenTimeline, setFrozenTimeline] = useState<number | null>(null);
  const timelineDuration = frozenTimeline ?? Math.max(.1, videoUrl ? duration : contentDuration);

  /* One burst per text event, rebuilt only when the line or its settings change
     — never per frame. Playback is a lookup into an absolute timeline. */
  const bursts = useMemo(() => {
    const map = new Map<number, MojibakeBurst>();
    textEvents.forEach((event) => map.set(event.id, createBurst(event.text, {
      seed: event.seed, scale: 1 / event.speed,
      apple: event.apple,
    })));
    return map;
  }, [textEvents]);

  const activeBurst = activeText ? bursts.get(activeText.id) : undefined;
  const activeStep = activeText && activeBurst ? stepAt(activeBurst, currentTime - activeText.start) : null;
  const garbledText = activeStep?.text ?? "";
  const cardVisible = Boolean(activeStep?.garbled) && mode !== "none";

  const updateEvent = (id: number, patch: Partial<TextEvent>) => setTextEvents((events) => events.map((event) => event.id === id ? { ...event, ...patch } : event));
  const updateText = (patch: Partial<TextEvent>) => updateEvent(selectedTextId, patch);

  /* Timeline dragging. A track's own box is the 0…timelineDuration span, so
     clientX maps straight to a time. Drag a text clip to move its start; drag a
     video trim handle to shorten the clip. */
  const timeFromClientX = (clientX: number, trackEl: HTMLElement) => {
    const rect = trackEl.getBoundingClientRect();
    return Math.max(0, Math.min(timelineDuration, ((clientX - rect.left) / rect.width) * timelineDuration));
  };
  const beginClipDrag = (event: React.PointerEvent<HTMLButtonElement>, clip: TextEvent) => {
    const track = (event.currentTarget as HTMLElement).closest(".timeline-track") as HTMLElement | null;
    if (!track) return;
    setSelectedTextId(clip.id);
    setFrozenTimeline(timelineDuration);
    const grab = timeFromClientX(event.clientX, track) - clip.start;
    /* Only this clip moves; its neighbours stay put, so the drag is confined to
       the gap between them. It can butt right up against a neighbour but never
       overlap one, and no other subtitle track is touched. */
    const others = textEvents.filter((other) => other.id !== clip.id);
    const minStart = others.filter((other) => other.start <= clip.start).reduce((edge, other) => Math.max(edge, other.start + other.duration), 0);
    const rightEdge = others.filter((other) => other.start > clip.start).reduce((edge, other) => Math.min(edge, other.start), timelineDuration);
    const maxStart = Math.max(minStart, Math.min(timelineDuration - clip.duration, rightEdge - clip.duration));
    let moved = false;
    const move = (pointer: PointerEvent) => {
      const next = Math.max(minStart, Math.min(maxStart, timeFromClientX(pointer.clientX, track) - grab));
      if (Math.abs(next - clip.start) > 0.02) moved = true;
      updateEvent(clip.id, { start: Number(next.toFixed(2)) });
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); setFrozenTimeline(null); if (!moved) seek(clip.start); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const beginTrimDrag = (event: React.PointerEvent, edge: "start" | "end") => {
    event.stopPropagation();
    const track = (event.currentTarget as HTMLElement).closest(".timeline-track") as HTMLElement | null;
    if (!track) return;
    const move = (pointer: PointerEvent) => { const t = timeFromClientX(pointer.clientX, track); if (edge === "start") setInPoint(t); else setOutPoint(t); };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  /* Drag a clip edge to restretch its duration. The far edge stays pinned, and
     the moving edge is capped by the nearest neighbour so it can't overlap. */
  const beginClipResize = (event: React.PointerEvent, clip: TextEvent, edge: "left" | "right") => {
    event.stopPropagation();
    const track = (event.currentTarget as HTMLElement).closest(".timeline-track") as HTMLElement | null;
    if (!track) return;
    setSelectedTextId(clip.id);
    setFrozenTimeline(timelineDuration);
    const others = textEvents.filter((other) => other.id !== clip.id);
    const minDuration = 0.2;
    const end = clip.start + clip.duration;
    const rightLimit = others.filter((other) => other.start >= clip.start).reduce((limit, other) => Math.min(limit, other.start), timelineDuration);
    const leftLimit = others.filter((other) => other.start < clip.start).reduce((limit, other) => Math.max(limit, other.start + other.duration), 0);
    const move = (pointer: PointerEvent) => {
      const t = timeFromClientX(pointer.clientX, track);
      if (edge === "right") {
        const newEnd = Math.max(clip.start + minDuration, Math.min(rightLimit, t));
        updateEvent(clip.id, { duration: Number((newEnd - clip.start).toFixed(2)) });
      } else {
        const newStart = Math.max(leftLimit, Math.min(end - minDuration, t));
        updateEvent(clip.id, { start: Number(newStart.toFixed(2)), duration: Number((end - newStart).toFixed(2)) });
      }
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); setFrozenTimeline(null); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  /* Click anywhere on the video track to move the playhead there. */
  const seekFromTimeline = (event: React.PointerEvent<HTMLDivElement>) => seek(timeFromClientX(event.clientX, event.currentTarget));
  const selectMode = (value: TransitionMode) => {
    setMode(value);
    if (videoUrl) return;
    if (value === "none") setNotice("“不遮挡”需要背景视频 · 请先上传 MP4 / MOV / WEBM");
    else setNotice(value === "flash" ? "未上传视频 · 预览使用白场纯白背景" : "未上传视频 · 预览使用黑场纯黑背景");
  };
  const addTextAtPlayhead = () => {
    const id = nextTextId.current++;
    const event: TextEvent = { id, start: Math.max(trimStart, currentTime), duration: Math.min(3.6, Math.max(.5, trimEnd - currentTime)), text: `TEXT_${String(id).padStart(2, "0")}`, seed: randomSeed(), speed: 1, apple: false };
    setTextEvents((events) => [...events, event].sort((a, b) => a.start - b.start));
    setSelectedTextId(id); setNotice(`TEXT_${String(id).padStart(2, "0")} inserted @ ${formatTime(event.start)}`);
  };
  const deleteSelectedText = () => {
    if (!selectedText) return;
    setTextEvents((events) => events.filter((event) => event.id !== selectedText.id));
    setSelectedTextId(textEvents.find((event) => event.id !== selectedText.id)?.id ?? 0);
    setNotice("已删除所选字幕片段");
  };

  /* Keep the black-card timeline in step with the subtitles until a real video
     replaces it (onLoadedMetadata then takes over the bounds). */
  useEffect(() => {
    if (videoUrl || frozenTimeline !== null) return;
    const timer = setTimeout(() => { setDuration(contentDuration); setTrimStart(0); setTrimEnd(contentDuration); }, 0);
    return () => clearTimeout(timer);
  }, [videoUrl, contentDuration, frozenTimeline]);

  useEffect(() => {
    if (videoUrl || !isPlaying) return;
    let animation = 0;
    let previous = performance.now();
    const tick = () => {
      const now = performance.now();
      const delta = (now - previous) / 1000;
      previous = now;
      setCurrentTime((value) => value + delta >= trimEnd ? trimStart : value + delta);
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [videoUrl, isPlaying, trimStart, trimEnd]);

  useEffect(() => () => { if (videoUrl.startsWith("blob:")) URL.revokeObjectURL(videoUrl); }, [videoUrl]);
  useEffect(() => () => prepareAbortRef.current?.abort(), []);

  useEffect(() => {
    if (!showUpsell) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setShowUpsell(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showUpsell]);

  /* Measure the real stage height so the preview subtitle is fontScale% of it —
     the same fraction the 720px export canvas uses. Container-query units proved
     unreliable here, so we size off the observed height directly. */
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setStageHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /* Upload → validate → native probe → Mediabunny remux/WebCodecs → FFmpeg,
     stopping at the first stage that yields a browser-playable source. The heavy
     stages live in @/video and are lazy-loaded, so the editor never pulls them
     in on entry. */
  const loadFile = useCallback(async (file?: File) => {
    if (!file) return;
    prepareAbortRef.current?.abort();
    const controller = new AbortController();
    prepareAbortRef.current = controller;
    setPreparing(true); setPrepareProgress(0); setIsPlaying(false);
    let stage: PrepareStage = "validating";
    try {
      const result = await prepareVideo(file, {
        signal: controller.signal,
        onStage: (next) => { stage = next; setPrepareProgress(0); setNotice(STAGE_TEXT[next]); },
        onProgress: (ratio) => { setPrepareProgress(ratio); setNotice(`${STAGE_TEXT[stage]} ${Math.round(ratio * 100)}%`); },
      });
      if (controller.signal.aborted) { result.cleanup(); return; }
      setVideoUrl((previous) => { if (previous) URL.revokeObjectURL(previous); return result.url; });
      setFileName(file.name); setCurrentTime(0); setTrimStart(0);
      setNotice(result.transformed
        ? `已转码为可编辑格式(${result.source})・可在播放头处插入字幕`
        : "背景视频已载入・可在播放头处插入多个字幕片段");
    } catch (error) {
      if (error instanceof VideoInputError && error.code === "aborted") { setNotice("已取消视频处理"); return; }
      setNotice(error instanceof VideoInputError ? `无法载入:${error.message}` : "视频处理失败,请换个文件再试");
    } finally {
      if (prepareAbortRef.current === controller) { prepareAbortRef.current = null; setPreparing(false); setPrepareProgress(0); }
      /* Clear the picker so re-selecting the same file (after a cancel) re-fires. */
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, []);

  const removeVideo = () => {
    prepareAbortRef.current?.abort();
    setVideoUrl((previous) => { if (previous.startsWith("blob:")) URL.revokeObjectURL(previous); return ""; });
    setFileName(""); setVideoSize("— × —"); setCurrentTime(0); setTrimStart(0); setIsPlaying(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setNotice("已移除背景视频 · 预览回到默认色卡");
  };

  const onLoadedMetadata = () => {
    const video = videoRef.current; if (!video) return;
    const next = Number.isFinite(video.duration) ? video.duration : 12;
    setVideoSize(`${video.videoWidth} × ${video.videoHeight}`);
    setDuration(next); setTrimStart(0); setTrimEnd(next); setCurrentTime(0);
  };
  const seek = (time: number) => { const next = Math.min(trimEnd, Math.max(trimStart, time)); setCurrentTime(next); if (videoRef.current) videoRef.current.currentTime = next; };
  const togglePlayback = async () => {
    const video = videoRef.current;
    if (!videoUrl || !video) { setIsPlaying((value) => !value); return; }
    if (video.paused) { if (video.currentTime < trimStart || video.currentTime >= trimEnd) seek(trimStart); await video.play(); }
    else video.pause();
  };
  const setInPoint = (value: number) => { const next = Math.min(Math.max(0, value), trimEnd - .1); setTrimStart(next); if (currentTime < next) seek(next); };
  const setOutPoint = (value: number) => { const next = Math.max(trimStart + .1, Math.min(duration, value)); setTrimEnd(next); if (currentTime > next) seek(next); };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.code === "Space") { event.preventDefault(); void togglePlayback(); }
      if (event.key.toLowerCase() === "i") setInPoint(currentTime);
      if (event.key.toLowerCase() === "o") setOutPoint(currentTime);
      if (event.key.toLowerCase() === "t") addTextAtPlayhead();
      if (event.key === "ArrowLeft") seek(currentTime - .04);
      if (event.key === "ArrowRight") seek(currentTime + .04);
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  });

  /* Export path runs the identical state machine as the preview, so what is
     recorded is what was on screen. Font metrics match the reference and the
     preview: fontScale% of frame height, Mincho, centred on the exact middle. */
  const drawSubtitle = (ctx: CanvasRenderingContext2D, videoTime: number, width: number, height: number, solidBg = false) => {
    const event = textEvents.find((item) => videoTime >= item.start && videoTime < item.start + item.duration);
    if (!event) return;
    const burst = bursts.get(event.id);
    if (!burst) return;
    const step = stepAt(burst, videoTime - event.start);
    const showCard = step.garbled && mode !== "none";
    if (showCard) {
      ctx.fillStyle = mode === "flash" ? "#fff" : "#000";
      ctx.fillRect(0, 0, width, height);
    }
    /* On a solid colour card the whole frame is already opaque, so text takes
       the card's contrast colour and drops its drop-shadow. */
    const onWhite = mode === "flash" && (showCard || solidBg);
    const flat = showCard || solidBg;
    ctx.fillStyle = onWhite ? "#0a0c0a" : "rgb(236,250,253)";
    ctx.font = `400 ${height * (fontScale / 100)}px "Hiragino Mincho ProN", "Yu Mincho", "MS Mincho", serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.shadowColor = flat ? "transparent" : "rgba(0,0,0,.85)";
    ctx.shadowBlur = flat ? 0 : height * .012;
    ctx.fillText(step.text, width / 2, height / 2);
    ctx.shadowBlur = 0;
  };

  /* Flag the loop to stop; the finally then leaves recording mode (the timeout
     race below guarantees it runs even if onstop never fires). */
  const cancelExport = () => { if (!isRecording) return; cancelExportRef.current = true; setNotice("正在取消导出…"); };

  /* Free trial export: render the trimmed clip (capped at GIF_MAX_SECONDS) to a
     small, SILENT GIF — the only format a web page can hand a phone that saves
     straight to the album. The full-length, original-audio video export is the
     paid feature at FULL_VERSION_URL. */
  const exportGif = async () => {
    const video = videoRef.current;
    const hasVideo = Boolean(video && videoUrl);
    if (isRecording) return;
    if (!hasVideo && mode === "none") { setNotice("“不遮挡”没有可导出的背景 · 请上传视频，或改用切黑场 / 切白场生成纯色卡"); return; }
    cancelExportRef.current = false;
    setIsRecording(true); setRenderProgress(0);

    const clipLen = Math.max(0.1, trimEnd - trimStart);
    const capped = clipLen > GIF_MAX_SECONDS;
    const exportLen = Math.min(clipLen, GIF_MAX_SECONDS);
    const exportEnd = trimStart + exportLen;
    setNotice(capped ? `体验版限 ${GIF_MAX_SECONDS} 秒 · 正在导出 GIF(仅前 ${GIF_MAX_SECONDS} 秒)…` : "正在导出 GIF…");

    const previousTime = video?.currentTime ?? 0;
    const canvas = document.createElement("canvas");
    canvas.width = GIF_WIDTH; canvas.height = GIF_HEIGHT;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) { setIsRecording(false); return; }

    try {
      if (hasVideo && video) video.pause();
      const gif = GIFEncoder();
      const delay = Math.round(1000 / GIF_FPS);
      const frameCount = Math.max(1, Math.round(exportLen * GIF_FPS));
      const base = mode === "flash" ? "#fff" : "#000";

      for (let i = 0; i < frameCount && !cancelExportRef.current; i++) {
        const t = Math.min(exportEnd, trimStart + i / GIF_FPS);
        if (hasVideo && video) {
          await seekVideo(video, t);
          drawCover(ctx, video, canvas.width, canvas.height);
          drawSubtitle(ctx, t, canvas.width, canvas.height);
        } else {
          ctx.fillStyle = base; ctx.fillRect(0, 0, canvas.width, canvas.height);
          drawSubtitle(ctx, t, canvas.width, canvas.height, true);
          setCurrentTime(t);
        }
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const palette = quantize(data, 256);
        const index = applyPalette(data, palette);
        gif.writeFrame(index, canvas.width, canvas.height, { palette, delay });
        setRenderProgress((i + 1) / frameCount);
        await nextPaint();
      }

      const cancelled = cancelExportRef.current;
      if (!cancelled) {
        gif.finish();
        const blob = new Blob([gif.bytes()], { type: "image/gif" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `ETHER_${fileName.replace(/\.[^.]+$/, "") || (hasVideo ? "clip" : "card")}.gif`;
        document.body.appendChild(link); link.click(); link.remove();
        window.setTimeout(() => URL.revokeObjectURL(link.href), 2000);
        setShowUpsell(true);
      }
      setRenderProgress(cancelled ? 0 : 1);
      setNotice(cancelled ? "已取消导出 · 未保存文件" : `GIF 已导出(限 ${GIF_MAX_SECONDS} 秒)`);
    } catch (error) {
      setNotice(`导出失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (hasVideo && video) { video.currentTime = Math.min(trimEnd, Math.max(trimStart, previousTime)); setCurrentTime(video.currentTime); }
      else setCurrentTime(trimStart);
      /* Whatever happened — success, cancel, or error — leave export mode so the
         button returns to EXPORT instead of staying on CANCEL. */
      setIsPlaying(false); setIsRecording(false);
    }
  };

  const playhead = (currentTime / timelineDuration) * 100;
  const timelineStyle = { "--playhead": `${playhead}%` } as CSSProperties;
  const stageClass = `stage mode-${mode} ${cardVisible ? "card-visible" : ""} ${isDragging ? "is-dragging" : ""} ${videoUrl ? "" : "no-video"}`;

  return <main className="app-shell">
    <section className="heritage-masthead" aria-label="All About Lily Chou-Chou visual archive">
      <div className="heritage-note"><span className="heritage-apple" role="img" aria-label="绿色苹果参考图" /><p><b>ETHER FILM ARCHIVE / 2001—2026</b><span>Inspired by the open, borderless web space surrounding Shunji Iwai&apos;s film — video, writing, music and memory.</span></p></div>
      <div className="heritage-field">
        <div className="heritage-sigil" aria-hidden="true"><span className="sigil-c">Ç</span><span className="sigil-cross">†</span></div>
        <div className="heritage-title"><i>A Shunji Iwai Film</i><strong>All About Lily Chou-Chou</strong><em>MOJIBAKE VIDEO STUDIO</em></div>
      </div>
      <nav className="heritage-nav"><a href="#editor">VIDEO</a><a href="#editor">TEXT</a><a href="#timeline">TIMELINE</a><a href="#export">EXPORT</a></nav>
    </section>
    <header className="topbar"><div className="brand"><span className="brand-mark">ETHER</span><span className="brand-sub">LILY MOJIBAKE VIDEO GENERATOR</span></div></header>
    <section className="workspace" id="editor">
      <div className="stage-column">
        <div className="section-heading"><span>PREVIEW</span><span>{fileName || "UNTITLED_PROJECT"}</span></div>
        <div ref={stageRef} className={stageClass} onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setIsDragging(false)} onDrop={(event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setIsDragging(false); void loadFile(event.dataTransfer.files?.[0]); }}>
          {videoUrl ? <video ref={videoRef} src={videoUrl} playsInline onLoadedMetadata={onLoadedMetadata} onTimeUpdate={(event) => { const time = event.currentTarget.currentTime; if (time >= trimEnd) { event.currentTarget.pause(); event.currentTarget.currentTime = trimStart; setCurrentTime(trimStart); } else setCurrentTime(time); }} onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)}><track kind="captions" src="/empty.vtt" srcLang="zh" label="无字幕" default /></video> : mode === "none" ? <div className="empty-film"><span>NO SIGNAL · 上传视频</span><i /></div> : <div className={`default-bg ${mode === "flash" ? "is-white" : ""}`} aria-hidden="true" />}
          {activeText && <div className="subtitle-layer" style={{ "--subtitle-size": stageHeight ? `${(stageHeight * fontScale) / 100}px` : `${fontScale}cqh` } as CSSProperties}><div className="main-title" data-garbled={activeStep?.garbled ? "1" : "0"}>{garbledText}</div></div>}
          <button className="upload-callout" disabled={preparing} onClick={() => fileInputRef.current?.click()}><span className="upload-plus">＋</span><span>{fileName ? "REPLACE SOURCE" : "SELECT SOURCE"}</span><small>点击或拖入视频・支持更多格式,必要时自动转码</small></button>
          {videoUrl && !preparing && <button className="remove-source" onClick={removeVideo} title="移除背景视频">✕ 移除视频</button>}
          <input ref={fileInputRef} className="visually-hidden" type="file" accept="video/*,.mkv,.avi,.flv,.ts,.m2ts,.mts,.wmv,.mov,.webm,.mp4,.m4v,.ogv,.3gp" onChange={(event: ChangeEvent<HTMLInputElement>) => { void loadFile(event.target.files?.[0]); }} />
          {preparing && <div className="convert-overlay" role="status" aria-live="polite"><span className="convert-stage">{notice}</span><div className="convert-bar"><i style={{ width: `${Math.round(prepareProgress * 100)}%` }} /></div><button className="convert-cancel" onClick={() => prepareAbortRef.current?.abort()}>CANCEL CONVERSION ✕</button></div>}
          <div className="stage-meta">{`${videoUrl ? videoSize : "16:9"} / ${formatTime(currentTime)}`}</div>{isDragging && <div className="drop-mask">释放以载入视频</div>}
        </div>
        <div className="transport"><button onClick={() => seek(trimStart)}>|◀</button><button className="play" onClick={togglePlayback}>{isPlaying ? "Ⅱ" : "▶"}</button><div className="timecode">{formatTime(currentTime)} <span>/ {formatTime(trimEnd)}</span></div><input className="seekbar" aria-label="播放位置" type="range" min={trimStart} max={trimEnd} step=".01" value={Math.min(trimEnd, Math.max(trimStart, currentTime))} onChange={(event) => seek(Number(event.target.value))} /><button onClick={() => seek(currentTime - 1)}>−1s</button><button onClick={() => seek(currentTime + 1)}>+1s</button></div>
        <section className="timeline-panel" id="timeline" style={timelineStyle}><div className="section-heading"><span>TIMELINE</span><span>TOTAL {formatTime(timelineDuration)} · 剪切 {formatTime(segmentDuration)}</span></div><div className="timeline-ruler">{[0,.25,.5,.75,1].map((ratio) => <span key={ratio}>{formatTime(timelineDuration * ratio).slice(0,5)}</span>)}</div><TimelineRow name="V1" label="VIDEO" className="video-track" onPointerDown={seekFromTimeline}><div className="clip-block" style={{ left: `${Math.max(0, Math.min(100, (trimStart / timelineDuration) * 100))}%`, width: `${Math.max(1, Math.min(100, ((trimEnd - trimStart) / timelineDuration) * 100))}%` }}><div className="clip-label">{fileName || "BACKGROUND_01.MP4"}</div><div className="clip-stripes" /><i className="trim-handle start" onPointerDown={(event) => beginTrimDrag(event, "start")} title="拖动设置入点" /><i className="trim-handle end" onPointerDown={(event) => beginTrimDrag(event, "end")} title="拖动设置出点" /></div><div className="playhead"><span>{formatTime(currentTime)}</span></div></TimelineRow><TimelineRow name="T1" label="TEXT" className="text-track">{textEvents.map((event) => <button key={event.id} className={`text-clip ${event.id === selectedTextId ? "selected" : ""}`} style={{ left: `${(event.start / timelineDuration) * 100}%`, width: `${(event.duration / timelineDuration) * 100}%` }} onPointerDown={(pointer) => beginClipDrag(pointer, event)}><i className="event-handle left" onPointerDown={(pointer) => beginClipResize(pointer, event, "left")} title="拖动改变开始时间" /><span>{event.text}</span><i className="event-handle right" onPointerDown={(pointer) => beginClipResize(pointer, event, "right")} title="拖动改变持续时间" /></button>)}</TimelineRow></section>
      </div>
      <aside className="inspector">
        <div className="section-heading"><span>TEXT EVENTS</span><span>{textEvents.length} CLIPS</span></div>
        <button className="add-text-button" onClick={addTextAtPlayhead}>+ 在播放头处新增乱码字幕 [T]</button>
        {selectedText ? <>
          <label className="field-label" htmlFor="subtitle">所选字幕 / TEXT_{String(selectedText.id).padStart(2, "0")}</label><textarea id="subtitle" value={selectedText.text} maxLength={100} onChange={(event) => updateText({ text: event.target.value })} />
          <div className="text-time-fields"><label>开始<input type="number" min={0} max={trimEnd} step={0.1} value={selectedText.start.toFixed(1)} onChange={(event) => updateText({ start: Number(event.target.value) })} /></label><label>持续<input type="number" min={.1} max={Math.max(.1, trimEnd - selectedText.start)} step={0.1} value={selectedText.duration.toFixed(1)} onChange={(event) => updateText({ duration: Number(event.target.value) })} /></label><button onClick={deleteSelectedText}>删除</button></div>
        </> : <div className="empty-selection">未选择字幕片段</div>}
        <div className="quick-row"><button disabled={!selectedText} onClick={() => updateText({ seed: randomSeed() })}>重新乱码</button></div>
        <div className="field-label label-strong">苹果字符 / APPLE </div>
        <label className="check-line audio-toggle"><input type="checkbox" disabled={!selectedText} checked={selectedText?.apple ?? false} onChange={(event) => updateText({ apple: event.target.checked })} /> APPLE MOJIBAKE <span>{selectedText?.apple ? "苹果乱码 · 随机一个  字节" : "STRICT · 仅真实 0xF0"}</span></label>
        <Control label="乱码速度" value={selectedText?.speed ?? 1} suffix="×" min={.25} max={5} step={.05} disabled={!selectedText} onChange={(value) => updateText({ speed: value })} /><Control label="字幕字号" value={fontScale} suffix=" %H" min={1.5} max={16} step={.05} onChange={setFontScale} />
        <div className="field-label">乱码期间画面</div><div className="transition-grid">{([['black','01','切黑场'],['flash','02','切白场'],['none','03','不遮挡']] as const).map(([value, number, label]) => <button key={value} className={mode === value ? "active" : ""} onClick={() => selectMode(value)}><b>{number}</b> {label}</button>)}</div>
        <div id="export"><div className="field-label">EXPORT</div><button className="render-button" disabled={preparing || (!isRecording && !videoUrl && mode === "none")} onClick={isRecording ? cancelExport : exportGif}><span>{isRecording ? `CANCEL · RENDERING ${Math.round(renderProgress * 100)}%` : "EXPORT GIF"}</span><span>{isRecording ? "✕" : "↗"}</span>{isRecording && <i style={{ width: `${renderProgress * 100}%` }} />}</button></div><div className="notice" aria-live="polite">&gt; {notice}</div>
      </aside>
    </section>
    <footer><span>ETHER / 2026</span></footer>
    {showUpsell && <div className="upsell-backdrop">
      <div className="upsell-modal" role="dialog" aria-modal="true" aria-label="体验版提示">
        <button className="upsell-x" aria-label="关闭" onClick={() => setShowUpsell(false)}>✕</button>
        <div className="upsell-kicker">体验版 / TRIAL</div>
        <p className="upsell-lead">已导出 {GIF_MAX_SECONDS} 秒 GIF。</p>
        <p className="upsell-text">想要<b>带原音的完整视频版</b>(不限时长)?前往完整版继续制作。</p>
        <a className="upsell-cta" href={`https://${FULL_VERSION_URL}`} target="_blank" rel="noreferrer">前往 {FULL_VERSION_URL} ↗</a>
        <button className="upsell-dismiss" onClick={() => setShowUpsell(false)}>继续体验</button>
      </div>
    </div>}
  </main>;
}

function TimelineRow({ name, label, className, children, onPointerDown }: { name: string; label: string; className: string; children: React.ReactNode; onPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void }) { return <div className={`timeline-track ${className}`} onPointerDown={onPointerDown}><div className="track-name"><b>{name}</b><span>{label}</span></div>{children}</div>; }

function Control({ label, value, suffix, min, max, step, onChange, disabled = false }: { label: string; value: number; suffix: string; min: number; max: number; step: number; onChange: (value: number) => void; disabled?: boolean; }) {
  const fill = (value - min) / (max - min) * 100;
  return <div className="control-row"><label>{label}<output>{Number.isInteger(value) ? value : value.toFixed(2)}{suffix}</output></label><input type="range" min={min} max={max} step={step} value={value} disabled={disabled} style={{ "--fill": `${fill}%` } as CSSProperties} onChange={(event) => onChange(Number(event.target.value))} /></div>;
}
