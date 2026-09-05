// Minimal typings for gifenc (ships no declarations of its own).
declare module "gifenc" {
  interface GifWriteFrameOptions {
    palette?: number[][];
    delay?: number;
    transparent?: boolean;
    dispose?: number;
    repeat?: number;
    [key: string]: unknown;
  }
  interface GifEncoderInstance {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: GifWriteFrameOptions): void;
    finish(): void;
    bytes(): Uint8Array<ArrayBuffer>;
    bytesView(): Uint8Array<ArrayBuffer>;
    reset(): void;
  }
  export function GIFEncoder(): GifEncoderInstance;
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: Record<string, unknown>
  ): number[][];
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: string
  ): Uint8Array;
}
