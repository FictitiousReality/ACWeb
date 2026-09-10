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
  private images = new Map<number, Promise<RgbaImage | null>>();
  private meshes = new Map<number, Promise<MeshData | null>>();
  private materials = new Map<number, Promise<THREE.Material>>();
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

  /** Decoded RGBA image for a SurfaceTexture id. */
  image(surfaceTextureId: number, clipMap = false, paletteId = 0): Promise<RgbaImage | null> {
    const key = surfaceTextureId ^ (clipMap ? 0x80000000 : 0) ^ paletteId;
    let p = this.images.get(key);
    if (!p) {
      p = (async () => {
        const t = await this.textureRecord(surfaceTextureId);
        if (!t) return null;
        let palette: Uint32Array | undefined;
        const pid = t.defaultPaletteId ?? paletteId;
        if (pid) palette = (await this.portal.get(pid, parsePalette))?.colors;
        if (t.format === PixelFormat.CUSTOM_RAW_JPEG) return decodeJpeg(t);
        return decodeTexture(t, { palette, clipMap });
      })();
      this.images.set(key, p);
    }
    return p;
  }

  async threeTexture(surfaceTextureId: number, clipMap = false): Promise<THREE.Texture | null> {
    const key = `${surfaceTextureId}:${clipMap ? 1 : 0}`;
    let p = this.textures.get(key);
    if (!p) {
      p = this.image(surfaceTextureId, clipMap).then((img) => {
        if (!img) return null;
        const tex = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat, THREE.UnsignedByteType);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
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

  /** Material for a Surface (0x08) id. */
  material(surfaceId: number, doubleSided = false): Promise<THREE.Material> {
    const key = surfaceId ^ (doubleSided ? 0x80000000 : 0);
    let p = this.materials.get(key);
    if (!p) {
      p = this.buildMaterial(surfaceId, doubleSided);
      this.materials.set(key, p);
    }
    return p;
  }

  private async buildMaterial(surfaceId: number, doubleSided: boolean): Promise<THREE.Material> {
    const s = await this.surface(surfaceId);
    const mat = new THREE.MeshLambertMaterial({ side: doubleSided ? THREE.DoubleSide : THREE.FrontSide });
    mat.name = hex(surfaceId);
    if (!s) {
      mat.color.set(0xff00ff);
      return mat;
    }
    const clip = (s.type & SurfaceFlags.Base1ClipMap) !== 0;
    if (s.type & (SurfaceFlags.Base1Image | SurfaceFlags.Base1ClipMap)) {
      const tex = await this.threeTexture(s.origTextureId, clip);
      if (tex) mat.map = tex;
      else mat.color.set(0xff00ff);
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
