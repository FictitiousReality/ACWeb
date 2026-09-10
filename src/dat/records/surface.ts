import type { BinReader } from "../reader.ts";
import { PixelFormat, SurfaceFlags } from "../types.ts";

/** 0x04xxxxxx: ARGB color table. */
export interface Palette {
  id: number;
  colors: Uint32Array;
}
export function parsePalette(r: BinReader): Palette {
  const id = r.u32();
  const n = r.u32();
  const colors = new Uint32Array(n);
  for (let i = 0; i < n; i++) colors[i] = r.u32();
  return { id, colors };
}

/** 0x0Fxxxxxx: list of palettes (used by clothing). */
export interface PaletteSet {
  id: number;
  palettes: number[];
}
export function parsePaletteSet(r: BinReader): PaletteSet {
  const id = r.u32();
  return { id, palettes: r.u32List() };
}

/** 0x06xxxxxx: raw image data. */
export interface Texture {
  id: number;
  unknown: number;
  width: number;
  height: number;
  format: PixelFormat;
  data: Uint8Array;
  defaultPaletteId: number | null;
}
export function parseTexture(r: BinReader): Texture {
  const id = r.u32();
  const unknown = r.i32();
  const width = r.i32();
  const height = r.i32();
  const format = r.u32() as PixelFormat;
  const length = r.i32();
  const data = r.bytes(length);
  let defaultPaletteId: number | null = null;
  if (format === PixelFormat.INDEX16 || format === PixelFormat.P8) defaultPaletteId = r.u32();
  return { id, unknown, width, height, format, data, defaultPaletteId };
}

/** 0x05xxxxxx: a list of 0x06 textures (mip chain / variants). */
export interface SurfaceTexture {
  id: number;
  unknown: number;
  unknownByte: number;
  textures: number[];
}
export function parseSurfaceTexture(r: BinReader): SurfaceTexture {
  const id = r.u32();
  const unknown = r.i32();
  const unknownByte = r.u8();
  return { id, unknown, unknownByte, textures: r.u32List() };
}

/** 0x08xxxxxx: material. Either a texture reference or a solid color. Note: no leading id field. */
export interface Surface {
  type: number;
  origTextureId: number;
  origPaletteId: number;
  colorValue: number;
  translucency: number;
  luminosity: number;
  diffuse: number;
}
export function parseSurface(r: BinReader): Surface {
  const type = r.u32();
  let origTextureId = 0, origPaletteId = 0, colorValue = 0;
  if (type & (SurfaceFlags.Base1Image | SurfaceFlags.Base1ClipMap)) {
    origTextureId = r.u32();
    origPaletteId = r.u32();
  } else {
    colorValue = r.u32();
  }
  return { type, origTextureId, origPaletteId, colorValue, translucency: r.f32(), luminosity: r.f32(), diffuse: r.f32() };
}
