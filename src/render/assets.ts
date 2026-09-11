/**
 * Loads dat records and turns them into GPU-ready Three.js resources with caching.
 */
import * as THREE from "three";
import {
  DatDatabase, hex, parseGfxObj, parsePalette, parseRegion, parseSetup, parseSurface, parseSurfaceTexture,
  parseTexture, PixelFormat, REGION_ID, SurfaceFlags,
} from "../dat/mod.ts";
import type { GfxObj, RegionDesc, Setup, Surface, Texture } from "../dat/mod.ts";
import { decodeTexture, type RgbaImage } from "../world/decode.ts";
import { buildMesh, type MeshData } from "../world/model.ts";

export class Assets {
  private textures = new Map<string, Promise<THREE.Texture | null>>();
  private imageCache = new Map<string, Promise<RgbaImage | null>>();
  private meshes = new Map<number, Promise<MeshData | null>>();
  private materials = new Map<string, Promise<THREE.Material>>();
  private _region: RegionDesc | null = null;

  constructor(readonly portal: DatDatabase, readonly cell: DatDatabase, readonly highres: DatDatabase | null = null) {}

  async region(): Promise<RegionDesc> {
    if (!this._region) this._region = (await this.portal.get(REGION_ID, parseRegion))!;
    return this._region;
  }

  gfxObj(id: number): Promise<GfxObj | null> {
    return this.portal.get(id, parseGfxObj);
  }
  setup(id: number): Promise<Setup | null> {
    return this.portal.get(id, parseSetup);
  }
  surface(id: number): Promise<Surface | null> {
    return this.portal.get(id, parseSurface);
  }

  mesh(id: number): Promise<MeshData | null> {
    let p = this.meshes.get(id);
    if (!p) {
      p = this.gfxObj(id).then((g) => (g ? buildMesh(g) : null));
      this.meshes.set(id, p);
    }
    return p;
  }

  /** First texture record of a SurfaceTexture (0x05) that exists in our dats. */
  async textureRecord(surfaceTextureId: number): Promise<Texture | null> {
    const st = await this.portal.get(surfaceTextureId, parseSurfaceTexture);
    if (!st) return null;
    for (const tid of st.textures) {
      const t = (await this.portal.get(tid, parseTexture)) ?? (this.highres ? await this.highres.get(tid, parseTexture) : null);
      if (t) return t;
    }
    return null;
  }

  /** Decoded RGBA image for a SurfaceTexture id. `override` replaces the texture's own palette (clothing/skin dyes). */
  image(surfaceTextureId: number, clipMap = false, paletteId = 0, override?: PaletteOverride): Promise<RgbaImage | null> {
    const key = `${surfaceTextureId}:${clipMap ? 1 : 0}:${paletteId}:${override?.key ?? ""}`;
    let p = this.imageCache.get(key);
    if (!p) {
      p = (async () => {
        const t = await this.textureRecord(surfaceTextureId);
        if (!t) return null;
        let palette: Uint32Array | undefined;
        if (override && (t.format === PixelFormat.INDEX16 || t.format === PixelFormat.P8)) palette = override.colors;
        else {
          const pid = t.defaultPaletteId ?? paletteId;
          if (pid) palette = (await this.portal.get(pid, parsePalette))?.colors;
        }
        if (t.format === PixelFormat.CUSTOM_RAW_JPEG) return decodeJpeg(t);
        return decodeTexture(t, { palette, clipMap });
      })();
      this.imageCache.set(key, p);
    }
    return p;
  }

  private paletteCache = new Map<string, Promise<PaletteOverride | null>>();

  /**
   * Effective palette for an object: its base palette with sub-palette ranges
   * copied in from the listed palettes (offsets/lengths are in units of 8 colors,
   * length 0 meaning the whole 2048-entry palette).
   */
  objectPalette(paletteId: number, subs: { id: number; offset: number; length: number }[]): Promise<PaletteOverride | null> {
    if (!paletteId) return Promise.resolve(null);
    const key = `${paletteId}|${subs.map((s) => `${s.id}:${s.offset}:${s.length}`).join(",")}`;
    let p = this.paletteCache.get(key);
    if (!p) {
      p = (async () => {
        const base = await this.portal.get(paletteId, parsePalette);
        if (!base) return null;
        const colors = base.colors.slice();
        for (const sp of subs) {
          const pal = await this.portal.get(sp.id, parsePalette);
          if (!pal) continue;
          const offset = sp.offset * 8;
          const count = (sp.length === 0 ? 256 : sp.length) * 8;
          for (let i = offset; i < offset + count && i < colors.length && i < pal.colors.length; i++) colors[i] = pal.colors[i];
        }
        return { key, colors };
      })();
      this.paletteCache.set(key, p);
    }
    return p;
  }

  async threeTexture(surfaceTextureId: number, clipMap = false, paletteId = 0, override?: PaletteOverride, clamp = false): Promise<THREE.Texture | null> {
    const key = `${surfaceTextureId}:${clipMap ? 1 : 0}:${paletteId}:${override?.key ?? ""}:${clamp ? "c" : ""}`;
    let p = this.textures.get(key);
    if (!p) {
      p = this.image(surfaceTextureId, clipMap, paletteId, override).then((img) => {
        if (!img) return null;
        const tex = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat, THREE.UnsignedByteType);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.generateMipmaps = isPow2(img.width) && isPow2(img.height);
        tex.anisotropy = 8;
        tex.flipY = false;
        tex.needsUpdate = true;
        return tex;
      });
      this.textures.set(key, p);
    }
    return p;
  }

  /**
   * Material for a Surface (0x08) id. `changes` applies an object's appearance:
   * a replacement SurfaceTexture for the surface's original one, and/or a palette override.
   */
  material(surfaceId: number, doubleSided = false, changes?: AppearanceChanges): Promise<THREE.Material> {
    const key = `${surfaceId}:${doubleSided ? 1 : 0}:${changes?.key ?? ""}`;
    let p = this.materials.get(key);
    if (!p) {
      p = this.buildMaterial(surfaceId, doubleSided, changes);
      this.materials.set(key, p);
    }
    return p;
  }

  private async buildMaterial(surfaceId: number, doubleSided: boolean, changes?: AppearanceChanges): Promise<THREE.Material> {
    const s = await this.surface(surfaceId);
    const mat = new THREE.MeshLambertMaterial({ side: doubleSided ? THREE.DoubleSide : THREE.FrontSide });
    mat.name = hex(surfaceId);
    if (!s) {
      mat.color.set(0xff00ff);
      return mat;
    }
    const clip = (s.type & SurfaceFlags.Base1ClipMap) !== 0;
    if (s.type & (SurfaceFlags.Base1Image | SurfaceFlags.Base1ClipMap)) {
      const texId = changes?.textureChanges.get(s.origTextureId) ?? s.origTextureId;
      const tex = await this.threeTexture(texId, clip, s.origPaletteId, changes?.palette ?? undefined);
      if (tex) mat.map = tex;
      else {
        mat.color.set(0xff00ff);
        console.warn(`missing texture for surface ${hex(surfaceId)}: surfaceTexture ${hex(s.origTextureId)}`);
      }
      if (clip) {
        mat.alphaTest = 0.5;
        mat.transparent = false;
      }
    } else {
      const c = s.colorValue;
      mat.color.setRGB(((c >>> 16) & 0xff) / 255, ((c >>> 8) & 0xff) / 255, (c & 0xff) / 255, THREE.SRGBColorSpace);
    }
    if (s.translucency > 0) {
      mat.transparent = true;
      mat.opacity = 1 - s.translucency;
      mat.depthWrite = false;
    }
    if (s.luminosity > 0) mat.emissive.copy(mat.color).multiplyScalar(s.luminosity);
    return mat;
  }
}

export interface PaletteOverride {
  key: string;
  colors: Uint32Array;
}

/** Per-part appearance changes from an object's ObjDesc. */
export interface AppearanceChanges {
  key: string;
  /** old SurfaceTexture id -> new SurfaceTexture id */
  textureChanges: Map<number, number>;
  palette: PaletteOverride | null;
}

export async function iconDataUrl(assets: Assets, textureId: number): Promise<string | null> {
  if (!textureId || typeof document === "undefined") return null;
  const t = await assets.portal.get(textureId, parseTexture);
  if (!t) return null;
  let palette: Uint32Array | undefined;
  if (t.defaultPaletteId) palette = (await assets.portal.get(t.defaultPaletteId, parsePalette))?.colors;
  const img = decodeTexture(t, { palette });
  if (!img) return null;
  const canvas = document.createElement("canvas");
  canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  const id = ctx.createImageData(img.width, img.height);
  id.data.set(img.data);
  ctx.putImageData(id, 0, 0);
  return canvas.toDataURL();
}

function isPow2(n: number): boolean {
  return (n & (n - 1)) === 0;
}

async function decodeJpeg(t: Texture): Promise<RgbaImage | null> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return null;
  const blob = new Blob([t.data.slice() as Uint8Array<ArrayBuffer>], { type: "image/jpeg" });
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return { width: bmp.width, height: bmp.height, data: new Uint8Array(img.data.buffer) };
}
