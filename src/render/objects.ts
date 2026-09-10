/**
 * Static objects and buildings: GfxObj / Setup -> THREE.Object3D, placed by Frame.
 */
import * as THREE from "three";
import type { Assets } from "./assets.ts";
import { hex, parseLandblockInfo, Placement } from "../dat/mod.ts";
import type { Frame } from "../dat/mod.ts";
import { landblockX, landblockY, BLOCK_LENGTH } from "../world/terrain.ts";

export class ObjectRenderer {
  private gfxCache = new Map<number, Promise<THREE.Group | null>>();
  private setupCache = new Map<number, Promise<THREE.Group | null>>();

  constructor(private assets: Assets) {}

  /** A reusable template group for a GfxObj; callers clone it. */
  gfxObj(id: number): Promise<THREE.Group | null> {
    let p = this.gfxCache.get(id);
    if (!p) {
      p = this.buildGfxObj(id);
      this.gfxCache.set(id, p);
    }
    return p;
  }

  private async buildGfxObj(id: number): Promise<THREE.Group | null> {
    const g = await this.assets.gfxObj(id);
    const mesh = await this.assets.mesh(id);
    if (!g || !mesh) return null;
    const group = new THREE.Group();
    group.name = hex(id);
    for (const part of mesh.groups) {
      if (part.triangleCount === 0) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(part.positions, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(part.normals, 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(part.uvs, 2));
      geo.computeBoundingSphere();
      const surfaceId = g.surfaces[part.surfaceIndex] ?? g.surfaces[0];
      const mat = await this.assets.material(surfaceId, part.doubleSided);
      group.add(new THREE.Mesh(geo, mat));
    }
    return group;
  }

  /** Template group for a Setup (0x02) or a bare GfxObj (0x01). */
  model(id: number): Promise<THREE.Group | null> {
    if (id >>> 24 === 0x01) return this.gfxObj(id);
    let p = this.setupCache.get(id);
    if (!p) {
      p = this.buildSetup(id);
      this.setupCache.set(id, p);
    }
    return p;
  }

  private async buildSetup(id: number): Promise<THREE.Group | null> {
    const setup = await this.assets.setup(id);
    if (!setup) return null;
    const group = new THREE.Group();
    group.name = hex(id);
    const placement = setup.placementFrames.get(Placement.Resting) ?? setup.placementFrames.get(Placement.Default) ??
      setup.placementFrames.values().next().value;
    for (let i = 0; i < setup.parts.length; i++) {
      const tmpl = await this.gfxObj(setup.parts[i]);
      if (!tmpl) continue;
      const part = tmpl.clone();
      const frame = placement?.frames[i];
      if (frame) applyFrame(part, frame);
      const scale = setup.defaultScale[i];
      if (scale) part.scale.set(scale.x, scale.y, scale.z);
      group.add(part);
    }
    return group;
  }

  /** All static objects + buildings for a landblock, positioned in world space. */
  async landblockObjects(landblockId: number): Promise<THREE.Group> {
    const root = new THREE.Group();
    const infoId = ((landblockId & 0xffff0000) | 0xfffe) >>> 0;
    const info = await this.assets.cell.get(infoId, parseLandblockInfo);
    if (!info) return root;
    const ox = landblockX(landblockId) * BLOCK_LENGTH, oy = landblockY(landblockId) * BLOCK_LENGTH;
    const place = async (modelId: number, frame: Frame) => {
      const tmpl = await this.model(modelId);
      if (!tmpl) return;
      const inst = tmpl.clone();
      applyFrame(inst, frame);
      inst.position.x += ox;
      inst.position.y += oy;
      root.add(inst);
    };
    await Promise.all([
      ...info.objects.map((o) => place(o.id, o.frame)),
      ...info.buildings.map((b) => place(b.modelId, b.frame)),
    ]);
    return root;
  }
}

export function applyFrame(obj: THREE.Object3D, f: Frame) {
  obj.position.set(f.origin.x, f.origin.y, f.origin.z);
  obj.quaternion.set(f.rotation.x, f.rotation.y, f.rotation.z, f.rotation.w);
}
