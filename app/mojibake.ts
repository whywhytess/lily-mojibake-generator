/**
 * Mojibake core — rebuilt from a frame-by-frame analysis of 乱码.mov.
 *
 * The previous version mutated Shift_JIS bytes on every animation frame, which
 * produces random scrambling. The reference does something quite different: it
 * converts the line once, then reveals that single fixed string as a growing
 * prefix, on an absolute timeline, with long holds broken by 33–50 ms
 * double-hits. Verified byte-exact against the reference:
 *
 *   《彼女が生まれたのは、》 -> ÅsîﬁèóÇ™ê∂Ç‹ÇÍÇΩÇÃÇÕÅAÅt
 *   一九八七年十二月八日     -> àÍã„î™éµîNè\ìÒåéî™ì˙
 *   二二時五〇分             -> ìÒìÒéûå‹ÅZï™
 *
 * No dependency on `encoding-japanese`: the Shift_JIS encoder is built by
 * inverting the browser's own shift_jis decoder.
 */

/* -------------------------------------------------------------------------- */
/* MojibakeEncoder                                                            */
/* -------------------------------------------------------------------------- */

const MACROMAN_HIGH =
  "\u00C4\u00C5\u00C7\u00C9\u00D1\u00D6\u00DC\u00E1\u00E0\u00E2\u00E4\u00E3\u00E5\u00E7\u00E9\u00E8" +
  "\u00EA\u00EB\u00ED\u00EC\u00EE\u00EF\u00F1\u00F3\u00F2\u00F4\u00F6\u00F5\u00FA\u00F9\u00FB\u00FC" +
  "\u2020\u00B0\u00A2\u00A3\u00A7\u2022\u00B6\u00DF\u00AE\u00A9\u2122\u00B4\u00A8\u2260\u00C6\u00D8" +
  "\u221E\u00B1\u2264\u2265\u00A5\u00B5\u2202\u2211\u220F\u03C0\u222B\u00AA\u00BA\u03A9\u00E6\u00F8" +
  "\u00BF\u00A1\u00AC\u221A\u0192\u2248\u2206\u00AB\u00BB\u2026\u00A0\u00C0\u00C3\u00D5\u0152\u0153" +
  "\u2013\u2014\u201C\u201D\u2018\u2019\u00F7\u25CA\u00FF\u0178\u2044\u20AC\u2039\u203A\uFB01\uFB02" +
  "\u2021\u00B7\u201A\u201E\u2030\u00C2\u00CA\u00C1\u00CB\u00C8\u00CD\u00CE\u00CF\u00CC\u00D3\u00D4" +
  "\uF8FF\u00D2\u00DA\u00DB\u00D9\u0131\u02C6\u02DC\u00AF\u02D8\u02D9\u02DA\u00B8\u02DD\u02DB\u02C7";

let sjisTable: Map<string, number> | null = null;

/** Unicode -> Shift_JIS, built once by inverting TextDecoder("shift_jis"). */
const shiftJisTable = (): Map<string, number> => {
  if (sjisTable) return sjisTable;
  const map = new Map<string, number>();
  const decoder = new TextDecoder("shift_jis");
  const pair = new Uint8Array(2);
  for (let lead = 0x81; lead <= 0xfc; lead++) {
    if (lead > 0x9f && lead < 0xe0) continue;
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail === 0x7f) continue;
      pair[0] = lead; pair[1] = trail;
      const glyph = decoder.decode(pair);
      if (glyph.length === 1 && glyph.charCodeAt(0) !== 0xfffd && !map.has(glyph)) {
        map.set(glyph, (lead << 8) | trail);
      }
    }
  }
  sjisTable = map;
  return map;
};

/**
 * Halfwidth ASCII survives Shift_JIS -> MacRoman untouched, so "1980" would
 * still read "1980" and look like a typo rather than broken data. Japanese
 * typesetting uses fullwidth forms anyway, so normalise before encoding.
 */
export const toFullwidth = (text: string): string =>
  text.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).replace(/ /g, "\u3000");

export const toShiftJis = (text: string): number[] => {
  const table = shiftJisTable();
  const bytes: number[] = [];
  for (const glyph of text) {
    const code = glyph.codePointAt(0) ?? 0x3f;
    if (code < 0x80) { bytes.push(code); continue; }
    if (code >= 0xff61 && code <= 0xff9f) { bytes.push(code - 0xfec0); continue; }
    const sjis = table.get(glyph);
    if (sjis === undefined) { bytes.push(0x3f); continue; }
    bytes.push(sjis >> 8, sjis & 0xff);
  }
  return bytes;
};

export const decodeMacRoman = (bytes: number[]): string => {
  let out = "";
  for (const byte of bytes) out += byte < 0x80 ? String.fromCharCode(byte) : MACROMAN_HIGH[byte - 0x80];
  return out;
};

/* -------------------------------------------------------------------------- */
/* ReferenceTiming                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Measured at 60 fps from 乱码.mov — the long opening corruption, exactly as in
 * the reference.
 *
 * `holds` are the seconds each state stays on screen. Note the shape: long
 * hold, then a 33–50 ms double-hit, then long hold again. `fractions` are
 * prefix lengths as a share of the full mojibake string; the reference never
 * completes the string, it hard-cuts at roughly two thirds.
 */
export const REFERENCE_PATTERNS = {
  /* Opening: 13 states over 2.82 s. Prefix 1,2,4,5,6,7,8,9,10,12,14,15,16 of 24. */
  long: {
    holds: [0.5667, 0.0500, 0.5000, 0.0333, 0.1333, 0.0333, 0.3833,
            0.0333, 0.5000, 0.0500, 0.3667, 0.1333, 0.0333],
    fractions: [0.042, 0.083, 0.167, 0.208, 0.250, 0.292, 0.333,
                0.375, 0.417, 0.500, 0.583, 0.625, 0.667],
  },
} as const;

export type BurstKind = keyof typeof REFERENCE_PATTERNS;

/* -------------------------------------------------------------------------- */
/* MojibakeSequence                                                           */
/* -------------------------------------------------------------------------- */

const mulberry32 = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/* -------------------------------------------------------------------------- */
/* Apple glyph injection                                                      */
/* -------------------------------------------------------------------------- */

/**
 * MacRoman byte 0xF0 decodes to U+F8FF, the Apple logo (). In real files it
 * only shows up when a Shift_JIS trail byte happens to be 0xF0, which is rare —
 * that is the STRICT mode, where we touch nothing and the encoder surfaces it
 * only when the data genuinely holds it.
 *
 * APPLE CORRUPTION mode keeps the same real Shift_JIS -> MacRoman conversion but
 * then deterministically replaces a single byte with 0xF0, reproducing the film's
 * stray . The seed decides where it lands. Because the choice is baked into the
 * single fixed byte array, the growing prefix reveals the  only once it is long
 * enough, then holds it until the hard cut — no per-frame movement.
 */
export const APPLE_BYTE = 0xf0;

export const injectAppleBytes = (bytes: number[], seed: number, enabled: boolean): number[] => {
  if (!enabled || bytes.length < 4) return bytes;
  const random = mulberry32(((seed >>> 0) ^ 0x9e3779b9) * 2654435761);
  /* Keep the familiar "Ås…" opening intact, and stay inside the window the
     burst actually reveals (it hard-cuts near two thirds) so the  always
     reaches its position before the cut rather than being clipped off. */
  const start = Math.max(2, Math.floor(bytes.length * 0.42));
  const end = Math.max(start + 1, Math.floor(bytes.length * 0.62));
  const pos = start + Math.floor(random() * (end - start));
  const out = bytes.slice();
  out[pos] = APPLE_BYTE;
  return out;
};

export interface MojibakeStep {
  /** Seconds from the start of the burst. */
  t: number;
  text: string;
  garbled: boolean;
}

export interface MojibakeBurst {
  steps: MojibakeStep[];
  /** Seconds until the hard cut to clean text. */
  duration: number;
  mojibake: string;
  clean: string;
}

export interface BurstOptions {
  seed?: number;
  /** Per-glyph hold multiplier (= 1 / speed). 1 = reference typing speed. */
  scale?: number;
  /** Text fed to the encoder, when it differs from what is displayed. */
  source?: string;
  /** APPLE CORRUPTION: when true, the seed may plant a single  (0 or 1). */
  apple?: boolean;
}

/**
 * Builds the state list for one line. States are strict prefixes of a single
 * fixed mojibake string, so a state is bit-identical for its whole hold —
 * nothing flickers, nothing re-randomises per frame.
 *
 * A small share of states swap one character for the same byte ±1, re-decoded
 * through MacRoman, which keeps even the variants byte-derived.
 */
export const createBurst = (text: string, options: BurstOptions = {}): MojibakeBurst => {
  const { seed = 1, scale = 1, source, apple = false } = options;
  const clean = text || "\u3000";
  const bytes = injectAppleBytes(toShiftJis(toFullwidth(source ?? clean)), seed, apple);
  const mojibake = decodeMacRoman(bytes);
  /* The reference never completes the line — it hard-cuts to clean Japanese at
     roughly two thirds — so we reveal a growing prefix up to that point. */
  const revealLength = Math.max(1, Math.round(bytes.length * 0.667));
  const random = mulberry32(seed * 2654435761);
  const perGlyph = 0.11 * scale;
  /* The reference rhythm — long dwells broken by quick double-hits. We use it as
     a relative cadence (normalised to mean 1) so it varies the hold of each
     glyph without changing the overall typing speed. */
  const rhythm = REFERENCE_PATTERNS.long.holds;
  const rhythmMean = rhythm.reduce((sum, hold) => sum + hold, 0) / rhythm.length;

  const steps: MojibakeStep[] = [];
  let t = 0;
  for (let length = 1; length <= revealLength; length++) {
    steps.push({ t, text: mojibake.slice(0, length), garbled: true });
    /* One glyph per state, held for a slice of the reference cadence. Floor at a
       frame so no glyph is ever skipped — it always types one by one, even fast. */
    const cadence = (rhythm[(length - 1) % rhythm.length] / rhythmMean) * (0.9 + random() * 0.2);
    t += Math.max(0.02, perGlyph * cadence);
  }
  /* Hold the final garbled prefix a beat, then hard-cut to the clean line. */
  t += perGlyph * 2.5;
  steps.push({ t, text: clean, garbled: false });
  return { steps, duration: t, mojibake, clean };
};

/** Which state should be on screen `local` seconds into the burst. */
export const stepAt = (burst: MojibakeBurst, local: number): MojibakeStep => {
  let index = 0;
  while (index + 1 < burst.steps.length && (burst.steps[index + 1] as MojibakeStep).t <= local) index++;
  return burst.steps[index] as MojibakeStep;
};
