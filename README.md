# Lily Mojibake Studio (demo)

## deployed on lily.whywhyte55.com

A browser-based **mojibake (文字化け / garbled-text) subtitle video editor**, inspired
by the open, borderless web space around Shunji Iwai's film
*All About Lily Chou-Chou* (リリイ・シュシュのすべて).

Drop in a clip, place timed text events on a timeline, and render authentic
Shift_JIS→MacRoman corruption bursts over the video — then export to MP4/WebM,
entirely client-side.

## Features

- **Source video** — upload MP4/MOV/WEBM, or work on a plain black/white colour
  card when no clip is loaded
- **Text events** — add subtitles with independent start times and durations,
  arranged on a draggable/resizable timeline
- **Mojibake engine** — text is converted once to Shift_JIS and decoded as
  MacRoman to produce a fixed, byte-exact garbled string, then revealed as a
  growing prefix on the reference film's measured typing rhythm (see
  `app/mojibake.ts`); optional Apple-logo () byte injection
- **Transition modes** — black card, white flash, or none
- **Trim** — set in/out points on the video clip
- **Export** — records the canvas + audio via `MediaRecorder`, preferring MP4
  (`avc1`) and falling back to WebM

## Tech stack

- [vinext](https://github.com/cloudflare/vinext) (React 19 / RSC on Cloudflare
  Workers) + [Vite](https://vite.dev)
- TypeScript, Tailwind CSS
- Cloudflare Workers runtime (`worker/index.ts`) for asset serving and image
  optimization
- Optional Cloudflare D1 + Drizzle scaffold (currently unused; `db/schema.ts` is
  intentionally empty)

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev      # start local dev server
npm run build    # production build
npm test         # build + verify the rendered editor shell
```

Cloudflare bindings are declared in `wrangler.jsonc` (read by both `vite.config.ts`
for local dev and `wrangler deploy`). The FFmpeg core (`ffmpeg-core.js` / `.wasm`)
is served from the `assets` R2 bucket via the `/ffmpeg/*` route in
`worker/index.ts`.

## Project Structure

```text
app/
├── page.tsx          # Main editor interface: video preview, timeline, inspector, and export workflow
├── mojibake.ts       # Lily Chou-Chou style mojibake engine: Shift_JIS → MacRoman corruption logic
├── layout.tsx        # Application document shell
└── globals.css       # Global UI styling

video/
├── format handling   # Video validation and browser compatibility processing
└── FFmpeg pipeline   # Client-side transcoding support

scripts/
└── setup scripts     # Build-time utilities and asset preparation

public/
└── assets/           # Reference images and visual materials

worker/
└── Cloudflare Worker entry for deployment assets and optimization

tests/
└── Server-render and functionality smoke tests
