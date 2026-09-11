/**
 * Sky: the region's sky objects (dome, horizon, sun, moon, clouds) drawn in a
 * separate scene centred on the camera, plus keyframed sun/ambient/fog by
 * time of day, ported from the RegionDesc SkyDesc tables.
 */
import * as THREE from "three";
import type { Assets } from "./assets.ts";
import type { DayGroup, RegionDesc, SkyTimeOfDay } from "../dat/mod.ts";
import { SurfaceFlags } from "../dat/mod.ts";

interface SkyObj {
  index: number;
  desc: DayGroup["skyObjects"][number];
  group: THREE.Group;
  materials: THREE.MeshBasicMaterial[];
  baseColor: THREE.Color[];
}

export interface SkyLighting {
  sunDir: THREE.Vector3; // direction light travels (from sun into the scene)
  sunColor: THREE.Color;
  sunIntensity: number;
  ambientColor: THREE.Color;
  ambientIntensity: number;
  fogColor: THREE.Color;
  fogNear: number;
  fogFar: number;
}

function argb(c: number): THREE.Color {
  return new THREE.Color().setRGB(((c >>> 16) & 0xff) / 255, ((c >>> 8) & 0xff) / 255, (c & 0xff) / 255, THREE.SRGBColorSpace);
}

export class SkyRenderer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(65, 1, 1, 60000);
  private objects: SkyObj[] = [];
  private group: DayGroup;
  readonly lighting: SkyLighting = {
    sunDir: new THREE.Vector3(0.4, 0.3, -0.85).normalize(), sunColor: new THREE.Color(1, 1, 1), sunIntensity: 1.2,
    ambientColor: new THREE.Color(1, 1, 1), ambientIntensity: 0.6, fogColor: new THREE.Color(0xc3c8dc), fogNear: 150, fogFar: 2400,
  };
  /** 0..1 fraction of the Dereth day (0 = Darktide, 0.5 = Midsong) */
  timeOfDay = 0.5;
  private texTime = 0;

  constructor(private assets: Assets, private region: RegionDesc, dayGroupIndex = 0) {
    this.camera.up.set(0, 0, 1);
    this.group = region.sky!.dayGroups[dayGroupIndex] ?? region.sky!.dayGroups[0];
  }

  /** Pick a day group by name ("Sunny", "Clear", "Cloudy", "Rainy"); returns false if none. */
  async setWeather(name: string): Promise<boolean> {
    const g = this.region.sky!.dayGroups.find((d) => d.dayName === name);
    if (!g) return false;
    this.group = g;
    await this.build();
    return true;
  }

  async build() {
    for (const o of this.objects) this.scene.remove(o.group);
    this.objects = [];
    for (const [index, desc] of this.group.skyObjects.entries()) {
      if (desc.defaultGfxObjectId >>> 24 !== 0x01) continue; // particle setups (weather) not supported yet
      const g = await this.assets.gfxObj(desc.defaultGfxObjectId);
      const mesh = await this.assets.mesh(desc.defaultGfxObjectId);
      if (!g || !mesh) continue;
      const group = new THREE.Group();
      const materials: THREE.MeshBasicMaterial[] = [];
      const baseColor: THREE.Color[] = [];
      for (const part of mesh.groups) {
        if (!part.triangleCount) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(part.positions, 3));
        geo.setAttribute("uv", new THREE.BufferAttribute(part.uvs, 2));
        const surfaceId = g.surfaces[part.surfaceIndex] ?? g.surfaces[0];
        const s = await this.assets.surface(surfaceId);
        const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, depthWrite: false, depthTest: false, fog: false });
        if (s && s.type & (SurfaceFlags.Base1Image | SurfaceFlags.Base1ClipMap)) {
          const clip = (s.type & SurfaceFlags.Base1ClipMap) !== 0;
          // clamp: sky polygons end exactly at texture edges, repeat wrapping draws seams
          const tex = await this.assets.threeTexture(s.origTextureId, clip, s.origPaletteId, undefined, true);
          if (tex) mat.map = tex;
          if (clip) mat.alphaTest = 0.5;
          if (s.type & SurfaceFlags.Alpha || s.type & SurfaceFlags.InvAlpha) mat.transparent = true;
          if (s.type & SurfaceFlags.Additive) { mat.blending = THREE.AdditiveBlending; mat.transparent = true; }
        } else if (s) {
          mat.color = argb(s.colorValue);
        }
        baseColor.push(mat.color.clone());
        materials.push(mat);
        const m = new THREE.Mesh(geo, mat);
        m.renderOrder = index;
        m.frustumCulled = false;
        group.add(m);
      }
      this.scene.add(group);
      this.objects.push({ index, desc, group, materials, baseColor });
    }
  }

  private keyframes(t: number): [SkyTimeOfDay, SkyTimeOfDay, number] {
    const times = this.group.skyTime;
    let i = times.length - 1;
    for (let k = 0; k < times.length; k++) if (times[k].begin <= t) i = k;
    const a = times[i];
    const b = times[(i + 1) % times.length];
    const span = ((b.begin - a.begin) + 1) % 1 || 1;
    const f = Math.max(0, Math.min(1, (((t - a.begin) + 1) % 1) / span));
    return [a, b, f];
  }

  /** Advance texture scrolling and apply the time of day to sky objects and lighting. */
  update(dt: number, mainCamera: THREE.Camera) {
    this.texTime += dt;
    const t = ((this.timeOfDay % 1) + 1) % 1;
    const [a, b, f] = this.keyframes(t);
    const lerp = (x: number, y: number) => x + (y - x) * f;
    const L = this.lighting;
    // sun direction from heading (0 = north, 90 = east) and pitch above the horizon
    const heading = THREE.MathUtils.degToRad(lerp(a.dirHeading, b.dirHeading));
    const pitch = THREE.MathUtils.degToRad(lerp(a.dirPitch, b.dirPitch));
    const sun = new THREE.Vector3(Math.sin(heading) * Math.cos(pitch), Math.cos(heading) * Math.cos(pitch), Math.sin(pitch));
    L.sunDir.copy(sun).negate();
    L.sunColor.copy(argb(a.dirColor)).lerp(argb(b.dirColor), f);
    L.sunIntensity = lerp(a.dirBright, b.dirBright) * 2.2;
    L.ambientColor.copy(argb(a.ambColor)).lerp(argb(b.ambColor), f);
    L.ambientIntensity = lerp(a.ambBright, b.ambBright) * 2.0;
    L.fogColor.copy(argb(a.worldFogColor)).lerp(argb(b.worldFogColor), f);
    L.fogNear = lerp(a.minWorldFog, b.minWorldFog);
    L.fogFar = Math.max(L.fogNear + 50, lerp(a.maxWorldFog, b.maxWorldFog));

    for (const o of this.objects) {
      const d = o.desc;
      let visible = true;
      let angle = 0;
      if (d.endTime > d.beginTime) {
        visible = t >= d.beginTime && t <= d.endTime;
        angle = d.beginAngle + (t - d.beginTime) / (d.endTime - d.beginTime) * (d.endAngle - d.beginAngle);
      }
      const ra = a.skyObjReplace.find((r) => r.objectIndex === o.index);
      const rb = b.skyObjReplace.find((r) => r.objectIndex === o.index) ?? ra;
      let lum = 1, transparent = 0, rotate = 0;
      if (ra && rb) {
        lum = lerp(ra.luminosity, rb.luminosity) / 100;
        transparent = lerp(ra.transparent, rb.transparent) / 100;
        rotate = ra.rotate;
      }
      if (transparent >= 1) visible = false;
      o.group.visible = visible;
      if (!visible) continue;
      // sun/moon sweep east -> west: rotate about the north axis
      o.group.rotation.set(0, THREE.MathUtils.degToRad(-angle), THREE.MathUtils.degToRad(rotate));
      for (let i = 0; i < o.materials.length; i++) {
        const m = o.materials[i];
        m.color.copy(o.baseColor[i]).multiplyScalar(lum);
        if (transparent > 0) { m.transparent = true; m.opacity = 1 - transparent; } else if (m.opacity !== 1) { m.opacity = 1; }
        if (m.map && (d.texVelocityX || d.texVelocityY)) m.map.offset.set(d.texVelocityX * this.texTime, d.texVelocityY * this.texTime);
      }
    }
    // camera: same orientation as the main camera, at the origin
    this.camera.quaternion.copy(mainCamera.quaternion);
    if ((mainCamera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      const pc = mainCamera as THREE.PerspectiveCamera;
      this.camera.fov = pc.fov;
      this.camera.aspect = pc.aspect;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Draw the sky; call before the main scene with renderer.autoClear handled by the caller. */
  render(renderer: THREE.WebGLRenderer) {
    renderer.render(this.scene, this.camera);
  }
}

/** Dereth time of day (0..1) from a server time in seconds, given the region's day length. */
export function timeOfDayFromServerTime(serverSeconds: number, dayLengthSeconds: number): number {
  const t = serverSeconds % dayLengthSeconds;
  return ((t / dayLengthSeconds) % 1 + 1) % 1;
}
