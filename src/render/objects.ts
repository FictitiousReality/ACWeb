/**
 * Static objects and buildings: GfxObj / Setup -> THREE.Object3D, placed by Frame.
 */
import * as THREE from "three";
import type { Assets } from "./assets.ts";
import { hex, parseEnvCell, parseEnvironment, parseLandblock, parseLandblockInfo, parseScene, Placement } from "../dat/mod.ts";
import type { Frame, Scene } from "../dat/mod.ts";
import { landblockX, landblockY, BLOCK_LENGTH, CELL_LENGTH, type LandblockGeometry } from "../world/terrain.ts";
import { buildScenery } from "../world/scenery.ts";
import { buildCellMesh } from "../world/model.ts";

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

  /** Cells (x*8+y) of a landblock covered by building footprints; scenery avoids them. */
  readonly buildingCells = new Map<number, Set<number>>();

  /** All static objects + buildings for a landblock, positioned in world space. */
  async landblockObjects(landblockId: number): Promise<THREE.Group> {
    const root = new THREE.Group();
    const cells = new Set<number>();
    this.buildingCells.set(landblockId, cells);
    const infoId = ((landblockId & 0xffff0000) | 0xfffe) >>> 0;
    const info = await this.assets.cell.get(infoId, parseLandblockInfo);
    if (!info) return root;
    const ox = landblockX(landblockId) * BLOCK_LENGTH, oy = landblockY(landblockId) * BLOCK_LENGTH;
    const box = new THREE.Box3();
    const place = async (modelId: number, frame: Frame, building: boolean) => {
      const tmpl = await this.model(modelId);
      if (!tmpl) return;
      const inst = tmpl.clone();
      applyFrame(inst, frame);
      if (building) {
        inst.updateMatrixWorld(true);
        box.setFromObject(inst);
        const x0 = Math.max(0, Math.floor(box.min.x / CELL_LENGTH)), x1 = Math.min(7, Math.floor(box.max.x / CELL_LENGTH));
        const y0 = Math.max(0, Math.floor(box.min.y / CELL_LENGTH)), y1 = Math.min(7, Math.floor(box.max.y / CELL_LENGTH));
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) cells.add(x * 8 + y);
      }
      inst.position.x += ox;
      inst.position.y += oy;
      root.add(inst);
    };
    await Promise.all([
      ...info.objects.map((o) => place(o.id, o.frame, false)),
      ...info.buildings.map((b) => place(b.modelId, b.frame, true)),
    ]);
    return root;
  }

  /** Dungeon = has indoor cells but no buildings or outdoor static objects. */
  async isDungeon(landblockId: number): Promise<boolean> {
    const info = await this.assets.cell.get(((landblockId & 0xffff0000) | 0xfffe) >>> 0, parseLandblockInfo);
    return !!info && info.numCells > 0 && info.buildings.length === 0 && info.objects.length === 0;
  }

  private sceneCache = new Map<number, Scene | null>();

  /** Preload every Scene referenced by the region so placement can run synchronously. */
  async preloadScenes(): Promise<void> {
    const region = await this.assets.region();
    const ids = new Set<number>();
    for (const st of region.scene ?? []) for (const id of st.scenes) ids.add(id);
    await Promise.all([...ids].map(async (id) => this.sceneCache.set(id, await this.assets.portal.get(id, parseScene))));
  }

  /** Procedural scenery for a landblock as instanced meshes, in world space. */
  async scenery(landblockId: number, geo: LandblockGeometry): Promise<THREE.Group> {
    const root = new THREE.Group();
    const lb = await this.assets.cell.get(landblockId, parseLandblock);
    if (!lb) return root;
    const region = await this.assets.region();
    const placements = buildScenery(lb, geo, region, { scene: (id) => this.sceneCache.get(id) ?? null },
      this.buildingCells.get(landblockId) ?? new Set());
    const byModel = new Map<number, typeof placements>();
    for (const p of placements) {
      let list = byModel.get(p.objId);
      if (!list) byModel.set(p.objId, list = []);
      list.push(p);
    }
    const ox = landblockX(landblockId) * BLOCK_LENGTH, oy = landblockY(landblockId) * BLOCK_LENGTH;
    const m = new THREE.Matrix4(), local = new THREE.Matrix4();
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
    await Promise.all([...byModel.entries()].map(async ([modelId, list]) => {
      const tmpl = await this.model(modelId);
      if (!tmpl) return;
      tmpl.updateMatrixWorld(true);
      const parts: THREE.Mesh[] = [];
      tmpl.traverse((o: THREE.Object3D) => { if ((o as THREE.Mesh).isMesh) parts.push(o as THREE.Mesh); });
      for (const part of parts) {
        const inst = new THREE.InstancedMesh(part.geometry, part.material, list.length);
        inst.name = `scenery_${hex(modelId)}`;
        local.copy(part.matrixWorld); // part transform relative to the template root
        for (let i = 0; i < list.length; i++) {
          const p = list[i];
          pos.set(p.x + ox, p.y + oy, p.z);
          quat.set(p.quaternion[0], p.quaternion[1], p.quaternion[2], p.quaternion[3]);
          scl.setScalar(p.scale);
          m.compose(pos, quat, scl).multiply(local);
          inst.setMatrixAt(i, m);
        }
        inst.instanceMatrix.needsUpdate = true;
        root.add(inst);
      }
    }));
    return root;
  }
}

export class EnvCellRenderer {
  private structCache = new Map<string, Promise<THREE.BufferGeometry[] | null>>();

  constructor(private assets: Assets, private objects: ObjectRenderer) {}

  /** Geometry per surface-index bucket for one CellStruct of an Environment. */
  private cellStruct(envId: number, structId: number): Promise<{ geo: THREE.BufferGeometry; surfaceIndex: number }[] | null> {
    const key = `${envId}:${structId}`;
    let p = this.structCache.get(key) as Promise<{ geo: THREE.BufferGeometry; surfaceIndex: number }[] | null> | undefined;
    if (!p) {
      p = (async () => {
        const env = await this.assets.portal.get(envId, parseEnvironment);
        const cs = env?.cells.get(structId);
        if (!cs) return null;
        const mesh = buildCellMesh(cs, envId);
        return mesh.groups.filter((g) => g.triangleCount > 0).map((g) => {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.BufferAttribute(g.positions, 3));
          geo.setAttribute("normal", new THREE.BufferAttribute(g.normals, 3));
          geo.setAttribute("uv", new THREE.BufferAttribute(g.uvs, 2));
          geo.computeBoundingSphere();
          return { geo, surfaceIndex: g.surfaceIndex };
        });
      })();
      this.structCache.set(key, p as never);
    }
    return p;
  }

  /** One EnvCell (interior room / dungeon cell) with its static objects, in world space. */
  async envCell(cellId: number): Promise<THREE.Group | null> {
    const ec = await this.assets.cell.get(cellId, parseEnvCell);
    if (!ec) return null;
    const parts = await this.cellStruct(ec.environmentId, ec.cellStructure);
    const group = new THREE.Group();
    group.name = `cell_${hex(cellId)}`;
    const ox = landblockX(cellId) * BLOCK_LENGTH, oy = landblockY(cellId) * BLOCK_LENGTH;
    if (parts) {
      const room = new THREE.Group();
      applyFrame(room, ec.position);
      for (const p of parts) {
        const surfaceId = ec.surfaces[p.surfaceIndex] ?? ec.surfaces[0];
        room.add(new THREE.Mesh(p.geo, await this.assets.material(surfaceId, true)));
      }
      group.add(room);
    }
    for (const stab of ec.staticObjects) {
      const tmpl = await this.objects.model(stab.id);
      if (!tmpl) continue;
      const inst = tmpl.clone();
      applyFrame(inst, stab.frame);
      group.add(inst);
    }
    group.position.set(ox, oy, 0);
    return group;
  }

  /** Every EnvCell of a landblock (building interiors and dungeons). */
  async landblockCells(landblockId: number): Promise<{ group: THREE.Group; count: number; first: THREE.Group | null }> {
    const group = new THREE.Group();
    const infoId = ((landblockId & 0xffff0000) | 0xfffe) >>> 0;
    const info = await this.assets.cell.get(infoId, parseLandblockInfo);
    let count = 0;
    let first: THREE.Group | null = null;
    if (!info || info.numCells === 0) return { group, count, first };
    const base = landblockId & 0xffff0000;
    const cells = await Promise.all(
      Array.from({ length: info.numCells }, (_, i) => this.envCell((base | (0x100 + i)) >>> 0)),
    );
    for (const c of cells) {
      if (!c) continue;
      group.add(c);
      count++;
      if (!first && c.children[0]) first = c;
    }
    return { group, count, first };
  }
}

export function applyFrame(obj: THREE.Object3D, f: Frame) {
  obj.position.set(f.origin.x, f.origin.y, f.origin.z);
  obj.quaternion.set(f.rotation.x, f.rotation.y, f.rotation.z, f.rotation.w);
}
