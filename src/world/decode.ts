/**
 * Decode AC texture records into RGBA8 pixels (row 0 = top, DirectX layout).
 */
import { PixelFormat } from "../dat/types.ts";
import type { Texture } from "../dat/records/surface.ts";

export interface RgbaImage {
  width: number;
  height: number;
  /** width*height*4 bytes, RGBA */
  data: Uint8Array;
}

export interface DecodeOptions {
  /** ARGB palette colors for INDEX16 / P8 textures. */
  palette?: Uint32Array;
  /** Clip maps: palette indices < 8 are fully transparent. */
  clipMap?: boolean;
}

/** Returns null for formats needing a platform image decoder (JPEG). */
export function decodeTexture(t: Texture, opts: DecodeOptions = {}): RgbaImage | null {
  const { width, height, data } = t;
  const n = width * height;
  const out = new Uint8Array(n * 4);
  switch (t.format) {
    case PixelFormat.A8R8G8B8: // stored as little-endian ARGB dwords -> bytes B,G,R,A
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        out[j] = data[j + 2];
        out[j + 1] = data[j + 1];
        out[j + 2] = data[j];
        out[j + 3] = data[j + 3];
      }
      break;
    case PixelFormat.X8R8G8B8:
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        out[j] = data[j + 2];
        out[j + 1] = data[j + 1];
        out[j + 2] = data[j];
        out[j + 3] = 255;
      }
      break;
    case PixelFormat.R8G8B8: // stored B,G,R
      for (let i = 0, s = 0, j = 0; i < n; i++, s += 3, j += 4) {
        out[j] = data[s + 2];
        out[j + 1] = data[s + 1];
        out[j + 2] = data[s];
        out[j + 3] = 255;
      }
      break;
    case PixelFormat.CUSTOM_LSCAPE_R8G8B8: // stored R,G,B
      for (let i = 0, s = 0, j = 0; i < n; i++, s += 3, j += 4) {
        out[j] = data[s];
        out[j + 1] = data[s + 1];
        out[j + 2] = data[s + 2];
        out[j + 3] = 255;
      }
      break;
    case PixelFormat.A8:
    case PixelFormat.CUSTOM_LSCAPE_ALPHA:
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const v = data[i];
        out[j] = v;
        out[j + 1] = v;
        out[j + 2] = v;
        out[j + 3] = v;
      }
      break;
    case PixelFormat.INDEX16:
    case PixelFormat.P8: {
      const pal = opts.palette;
      if (!pal) throw new Error(`Palette required for texture ${t.id.toString(16)}`);
      const is16 = t.format === PixelFormat.INDEX16;
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const idx = is16 ? data[i * 2] | (data[i * 2 + 1] << 8) : data[i];
        if (opts.clipMap && idx < 8) {
          out[j] = out[j + 1] = out[j + 2] = out[j + 3] = 0;
          continue;
        }
        const c = pal[idx] ?? 0;
        out[j] = (c >>> 16) & 0xff;
        out[j + 1] = (c >>> 8) & 0xff;
        out[j + 2] = c & 0xff;
        out[j + 3] = (c >>> 24) & 0xff;
      }
      break;
    }
    case PixelFormat.R5G6B5:
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const v = data[i * 2] | (data[i * 2 + 1] << 8);
        const r5 = v >> 11, g6 = (v >> 5) & 0x3f, b5 = v & 0x1f;
        out[j] = (r5 << 3) | (r5 >> 2);
        out[j + 1] = (g6 << 2) | (g6 >> 4);
        out[j + 2] = (b5 << 3) | (b5 >> 2);
        out[j + 3] = 255;
      }
      break;
    case PixelFormat.A4R4G4B4:
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const v = data[i * 2] | (data[i * 2 + 1] << 8);
        out[j] = ((v >> 8) & 0xf) * 17;
        out[j + 1] = ((v >> 4) & 0xf) * 17;
        out[j + 2] = (v & 0xf) * 17;
        out[j + 3] = ((v >> 12) & 0xf) * 17;
      }
      break;
    case PixelFormat.DXT1:
      decodeDxt(data, width, height, out, 1);
      break;
    case PixelFormat.DXT3:
      decodeDxt(data, width, height, out, 3);
      break;
    case PixelFormat.DXT5:
      decodeDxt(data, width, height, out, 5);
      break;
    case PixelFormat.CUSTOM_RAW_JPEG:
      return null;
    default:
      throw new Error(`Unsupported pixel format ${t.format} in texture ${t.id.toString(16)}`);
  }
  return { width, height, data: out };
}

function rgb565(c: number): [number, number, number] {
  const r5 = c >> 11, g6 = (c >> 5) & 0x3f, b5 = c & 0x1f;
  return [(r5 << 3) | (r5 >> 2), (g6 << 2) | (g6 >> 4), (b5 << 3) | (b5 >> 2)];
}

function decodeDxt(src: Uint8Array, width: number, height: number, out: Uint8Array, kind: 1 | 3 | 5): void {
  const bw = (width + 3) >> 2, bh = (height + 3) >> 2;
  const blockBytes = kind === 1 ? 8 : 16;
  let p = 0;
  const alpha = new Uint8Array(16);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      if (kind === 3) {
        for (let i = 0; i < 8; i++) {
          const b = src[p + i];
          alpha[i * 2] = (b & 0x0f) * 17;
          alpha[i * 2 + 1] = (b >> 4) * 17;
        }
        p += 8;
      } else if (kind === 5) {
        const a0 = src[p], a1 = src[p + 1];
        let bits = 0n;
        for (let i = 0; i < 6; i++) bits |= BigInt(src[p + 2 + i]) << BigInt(8 * i);
        for (let i = 0; i < 16; i++) {
          const ai = Number((bits >> BigInt(3 * i)) & 7n);
          let a: number;
          if (ai === 0) a = a0;
          else if (ai === 1) a = a1;
          else if (a0 > a1) a = ((8 - ai) * a0 + (ai - 1) * a1) / 7;
          else if (ai === 6) a = 0;
          else if (ai === 7) a = 255;
          else a = ((6 - ai) * a0 + (ai - 1) * a1) / 5;
          alpha[i] = a | 0;
        }
        p += 8;
      }
      const c0 = src[p] | (src[p + 1] << 8);
      const c1 = src[p + 2] | (src[p + 3] << 8);
      const lut = (src[p + 4] | (src[p + 5] << 8) | (src[p + 6] << 16) | (src[p + 7] << 24)) >>> 0;
      p += 8;
      const [r0, g0, b0] = rgb565(c0);
      const [r1, g1, b1] = rgb565(c1);
      for (let i = 0; i < 16; i++) {
        const px = (bx << 2) + (i & 3), py = (by << 2) + (i >> 2);
        if (px >= width || py >= height) continue;
        const idx = (lut >>> (2 * i)) & 3;
        let r = 0, g = 0, b = 0, a = kind === 1 ? 255 : alpha[i];
        if (kind !== 1 || c0 > c1) {
          if (idx === 0) { r = r0; g = g0; b = b0; }
          else if (idx === 1) { r = r1; g = g1; b = b1; }
          else if (idx === 2) { r = (2 * r0 + r1) / 3; g = (2 * g0 + g1) / 3; b = (2 * b0 + b1) / 3; }
          else { r = (r0 + 2 * r1) / 3; g = (g0 + 2 * g1) / 3; b = (b0 + 2 * b1) / 3; }
        } else {
          if (idx === 0) { r = r0; g = g0; b = b0; }
          else if (idx === 1) { r = r1; g = g1; b = b1; }
          else if (idx === 2) { r = (r0 + r1) / 2; g = (g0 + g1) / 2; b = (b0 + b1) / 2; }
          else { r = g = b = 0; a = 0; }
        }
        const o = (py * width + px) * 4;
        out[o] = r | 0;
        out[o + 1] = g | 0;
        out[o + 2] = b | 0;
        out[o + 3] = a;
      }
      void blockBytes;
    }
  }
}
