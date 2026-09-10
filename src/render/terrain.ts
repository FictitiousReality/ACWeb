/**
 * Landscape rendering: two texture arrays (terrain textures, alpha masks) and
 * a single-pass blend shader ported from ACViewer's LandscapeSinglePass.
 */
import * as THREE from "three";
import type { Assets } from "./assets.ts";
import { buildLandblockGeometry, cornerVertex, type LandblockGeometry, rotatedUV, LAND_UVS, TexMergeTable } from "../world/terrain.ts";
import type { Landblock } from "../dat/mod.ts";
import { parseLandblock } from "../dat/mod.ts";

const ATLAS_SIZE = 512;

/** Fixed-size 2D texture array with lazily uploaded layers keyed by SurfaceTexture id. */
class TextureArray {
  readonly texture: THREE.DataArrayTexture;
  private layers = new Map<number, number>();
  private loading = new Map<number, Promise<number>>();
  private next = 0;

  constructor(readonly depth: number, private assets: Assets, srgb: boolean) {
    const data = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4 * depth);
    this.texture = new THREE.DataArrayTexture(data, ATLAS_SIZE, ATLAS_SIZE, depth);
    this.texture.format = THREE.RGBAFormat;
    this.texture.type = THREE.UnsignedByteType;
    this.texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.generateMipmaps = true;
    this.texture.anisotropy = 8;
    this.texture.needsUpdate = true;
  }

  layer(surfaceTextureId: number): Promise<number> {
    const have = this.layers.get(surfaceTextureId);
    if (have !== undefined) return Promise.resolve(have);
    let p = this.loading.get(surfaceTextureId);
    if (!p) {
      p = (async () => {
        const idx = this.next++;
        if (idx >= this.depth) throw new Error("texture array full");
        this.layers.set(surfaceTextureId, idx);
        const img = await this.assets.image(surfaceTextureId);
        if (img) {
          const data = this.texture.image.data as Uint8Array;
          const off = idx * ATLAS_SIZE * ATLAS_SIZE * 4;
          if (img.width === ATLAS_SIZE && img.height === ATLAS_SIZE) data.set(img.data, off);
          else resample(img.data, img.width, img.height, data.subarray(off, off + ATLAS_SIZE * ATLAS_SIZE * 4));
          this.texture.needsUpdate = true;
        }
        return idx;
      })();
      this.loading.set(surfaceTextureId, p);
    }
    return p;
  }
}

function resample(src: Uint8Array, sw: number, sh: number, dst: Uint8Array) {
  for (let y = 0; y < ATLAS_SIZE; y++) {
    const sy = Math.floor((y * sh) / ATLAS_SIZE);
    for (let x = 0; x < ATLAS_SIZE; x++) {
      const sx = Math.floor((x * sw) / ATLAS_SIZE);
      const s = (sy * sw + sx) * 4, d = (y * ATLAS_SIZE + x) * 4;
      dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2]; dst[d + 3] = src[s + 3];
    }
  }
}

const vertexShader = /* glsl */ `
in vec3 aBase;
in vec4 aOv0;
in vec4 aOv1;
in vec4 aOv2;
in vec4 aRoad0;
in vec4 aRoad1;
out vec3 vBase;
out vec4 vOv0;
out vec4 vOv1;
out vec4 vOv2;
out vec4 vRoad0;
out vec4 vRoad1;
out vec3 vNormal;
out float vDist;
void main() {
  vBase = aBase; vOv0 = aOv0; vOv1 = aOv1; vOv2 = aOv2; vRoad0 = aRoad0; vRoad1 = aRoad1;
  vNormal = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const fragmentShader = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray uOverlays;
uniform sampler2DArray uAlphas;
uniform vec3 uLightDir;
uniform float uAmbient;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
in vec3 vBase;
in vec4 vOv0;
in vec4 vOv1;
in vec4 vOv2;
in vec4 vRoad0;
in vec4 vRoad1;
in vec3 vNormal;
in float vDist;
out vec4 outColor;

vec4 maskBlend3(vec4 t0, vec4 t1, vec4 t2, float h0, float h1, float h2) {
  float a0 = h0 == 0.0 ? 1.0 : t0.a;
  float a1 = h1 == 0.0 ? 1.0 : t1.a;
  float a2 = h2 == 0.0 ? 1.0 : t2.a;
  float aR = 1.0 - (a0 * a1 * a2);
  a0 = 1.0 - a0; a1 = 1.0 - a1; a2 = 1.0 - a2;
  vec3 r0 = a0 * t0.rgb + (1.0 - a0) * a1 * t1.rgb + (1.0 - a1) * a2 * t2.rgb;
  return vec4(aR > 0.0 ? r0 / aR : vec3(0.0), aR);
}

vec4 combineOverlays(vec2 uvb) {
  float h0 = vOv0.z < 0.0 ? 0.0 : 1.0;
  float h1 = vOv1.z < 0.0 ? 0.0 : 1.0;
  float h2 = vOv2.z < 0.0 ? 0.0 : 1.0;
  vec4 o0 = vec4(0.0), o1 = vec4(0.0), o2 = vec4(0.0);
  if (h0 > 0.0) { o0 = texture(uOverlays, vec3(uvb, vOv0.z)); o0.a = texture(uAlphas, vec3(vOv0.xy, vOv0.w)).a; }
  if (h1 > 0.0) { o1 = texture(uOverlays, vec3(uvb, vOv1.z)); o1.a = texture(uAlphas, vec3(vOv1.xy, vOv1.w)).a; }
  if (h2 > 0.0) { o2 = texture(uOverlays, vec3(uvb, vOv2.z)); o2.a = texture(uAlphas, vec3(vOv2.xy, vOv2.w)).a; }
  return maskBlend3(o0, o1, o2, h0, h1, h2);
}

vec4 combineRoad(vec2 uvb) {
  vec4 result = vec4(0.0);
  if (vRoad0.z >= 0.0) {
    result = texture(uOverlays, vec3(uvb, vRoad0.z));
    float ra0 = texture(uAlphas, vec3(vRoad0.xy, vRoad0.w)).a;
    result.a = 1.0 - ra0;
    if (vRoad1.z >= 0.0) {
      float ra1 = texture(uAlphas, vec3(vRoad1.xy, vRoad1.w)).a;
      result.a = 1.0 - (ra0 * ra1);
    }
  }
  return result;
}

void main() {
  vec2 uvb = vBase.xy;
  vec4 baseColor = texture(uOverlays, vec3(uvb, vBase.z));
  vec4 ov = vOv0.z >= 0.0 ? combineOverlays(uvb) : vec4(0.0);
  vec4 rd = vRoad0.z >= 0.0 ? combineRoad(uvb) : vec4(0.0);
  vec3 baseMasked = clamp(baseColor.rgb * ((1.0 - ov.a) * (1.0 - rd.a)), 0.0, 1.0);
  vec3 ovMasked = clamp(ov.rgb * (ov.a * (1.0 - rd.a)), 0.0, 1.0);
  vec3 roadMasked = rd.rgb * rd.a;
  vec3 color = baseMasked + ovMasked + roadMasked;
  float light = clamp(dot(normalize(vNormal), -uLightDir), 0.0, 1.0) * (1.0 - uAmbient) + uAmbient;
  color *= light;
  float fog = clamp((vDist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
  color = mix(color, uFogColor, fog);
  outColor = linearToOutputTexel(vec4(color, 1.0));
}`;

export class TerrainRenderer {
  readonly overlays: TextureArray;
  readonly alphas: TextureArray;
  readonly material: THREE.ShaderMaterial;
  readonly texMerge: TexMergeTable;
  private cache = new Map<number, Promise<THREE.Mesh | null>>();

  constructor(private assets: Assets, region: Parameters<typeof buildLandblockGeometry>[1]) {
    this.texMerge = new TexMergeTable(region);
    const tm = region.texMerge;
    const overlayIds = new Set(tm.terrainDesc.map((d) => d.terrainTex.texGID));
    const alphaIds = new Set([
      ...tm.cornerTerrainMaps.map((m) => m.texGID), ...tm.sideTerrainMaps.map((m) => m.texGID),
      ...tm.roadMaps.map((m) => m.roadTexGID),
    ]);
    this.overlays = new TextureArray(overlayIds.size, assets, true);
    this.alphas = new TextureArray(alphaIds.size, assets, false);
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader,
      fragmentShader,
      uniforms: {
        uOverlays: { value: this.overlays.texture },
        uAlphas: { value: this.alphas.texture },
        uLightDir: { value: new THREE.Vector3(0.4, 0.3, -0.85).normalize() },
        uAmbient: { value: 0.45 },
        uFogColor: { value: new THREE.Color(0x9fb4c8) },
        uFogNear: { value: 600 },
        uFogFar: { value: 1400 },
      },
    });
  }

  /** Light direction is given in world space; convert to view space each frame. */
  updateLight(camera: THREE.Camera, worldDir: THREE.Vector3) {
    const v = worldDir.clone().transformDirection(camera.matrixWorldInverse);
    (this.material.uniforms.uLightDir.value as THREE.Vector3).copy(v);
  }

  landblock(id: number): Promise<THREE.Mesh | null> {
    let p = this.cache.get(id);
    if (!p) {
      p = this.build(id);
      this.cache.set(id, p);
    }
    return p;
  }

  private async build(id: number): Promise<THREE.Mesh | null> {
    const lb = await this.assets.cell.get(id, parseLandblock);
    if (!lb) return null;
    const region = await this.assets.region();
    const geo = buildLandblockGeometry(lb as Landblock, region, this.texMerge);
    return this.toMesh(geo);
  }

  private async toMesh(geo: LandblockGeometry): Promise<THREE.Mesh> {
    const vertsPerBlock = 64 * 2 * 3;
    const pos = new Float32Array(vertsPerBlock * 3);
    const nrm = new Float32Array(vertsPerBlock * 3);
    const base = new Float32Array(vertsPerBlock * 3);
    const ov = [0, 1, 2].map(() => new Float32Array(vertsPerBlock * 4).fill(-1));
    const road = [0, 1].map(() => new Float32Array(vertsPerBlock * 4).fill(-1));
    let v = 0;
    for (const cell of geo.cells) {
      const s = cell.surface;
      const baseLayer = await this.overlays.layer(s.base.texGID);
      const ovLayers = await Promise.all(s.overlays.map(async (o) => [
        await this.overlays.layer(o.tex.texGID), await this.alphas.layer(o.alpha.texGID),
      ]));
      const roadLayer = s.road ? await this.overlays.layer(s.road.tex.texGID) : -1;
      const roadAlphas = s.road ? await Promise.all(s.road.alphas.map((a) => this.alphas.layer(a.alpha.roadTexGID))) : [];
      for (const tri of cell.tris) {
        for (const corner of tri) {
          const vi = cornerVertex(cell.cx, cell.cy, corner);
          pos[v * 3] = geo.positions[vi * 3];
          pos[v * 3 + 1] = geo.positions[vi * 3 + 1];
          pos[v * 3 + 2] = geo.positions[vi * 3 + 2];
          nrm[v * 3] = geo.normals[vi * 3];
          nrm[v * 3 + 1] = geo.normals[vi * 3 + 1];
          nrm[v * 3 + 2] = geo.normals[vi * 3 + 2];
          const uv = LAND_UVS[corner];
          base[v * 3] = uv[0]; base[v * 3 + 1] = uv[1]; base[v * 3 + 2] = baseLayer;
          s.overlays.forEach((o, i) => {
            const r = rotatedUV(o.rot, corner);
            ov[i][v * 4] = r[0]; ov[i][v * 4 + 1] = r[1]; ov[i][v * 4 + 2] = ovLayers[i][0]; ov[i][v * 4 + 3] = ovLayers[i][1];
          });
          s.road?.alphas.forEach((a, i) => {
            const r = rotatedUV(a.rot, corner);
            road[i][v * 4] = r[0]; road[i][v * 4 + 1] = r[1]; road[i][v * 4 + 2] = roadLayer; road[i][v * 4 + 3] = roadAlphas[i];
          });
          v++;
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    g.setAttribute("aBase", new THREE.BufferAttribute(base, 3));
    g.setAttribute("aOv0", new THREE.BufferAttribute(ov[0], 4));
    g.setAttribute("aOv1", new THREE.BufferAttribute(ov[1], 4));
    g.setAttribute("aOv2", new THREE.BufferAttribute(ov[2], 4));
    g.setAttribute("aRoad0", new THREE.BufferAttribute(road[0], 4));
    g.setAttribute("aRoad1", new THREE.BufferAttribute(road[1], 4));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.material);
    mesh.position.set(geo.originX, geo.originY, 0);
    mesh.name = `lb_${geo.id.toString(16)}`;
    return mesh;
  }
}
