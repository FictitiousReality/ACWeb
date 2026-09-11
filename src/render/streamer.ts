/** Keeps the landblocks around a world position loaded (terrain, objects, scenery, cells). */
import * as THREE from "three";
import type { Assets } from "./assets.ts";
import { TerrainRenderer } from "./terrain.ts";
import { EnvCellRenderer, ObjectRenderer } from "./objects.ts";
import { BLOCK_LENGTH, landblockId, type LandblockGeometry } from "../world/terrain.ts";
import { sampleTerrain } from "../world/scenery.ts";
import type { RegionDesc } from "../dat/mod.ts";

export class WorldStreamer {
  readonly outdoor = new THREE.Group();
  readonly indoor = new THREE.Group();
  readonly terrain: TerrainRenderer;
  readonly objects: ObjectRenderer;
  readonly envcells: EnvCellRenderer;
  private loaded = new Map<number, THREE.Object3D[]>();
  private loading = new Set<number>();
  private centerX = -1;
  private centerY = -1;
  radius = 1;
  scenery = true;
  interiors = true;
  onLog: ((s: string) => void) | null = null;

  constructor(private assets: Assets, region: RegionDesc) {
    this.terrain = new TerrainRenderer(assets, region);
    this.objects = new ObjectRenderer(assets);
    this.envcells = new EnvCellRenderer(assets, this.objects);
  }

  async init() {
    if (this.scenery) await this.objects.preloadScenes();
  }

  /** Call whenever the player moves; loads/unloads as the center landblock changes. */
  update(worldX: number, worldY: number) {
    const cx = Math.floor(worldX / BLOCK_LENGTH), cy = Math.floor(worldY / BLOCK_LENGTH);
    if (cx === this.centerX && cy === this.centerY) return;
    this.centerX = cx;
    this.centerY = cy;
    const want = new Set<number>();
    for (let x = cx - this.radius; x <= cx + this.radius; x++) {
      for (let y = cy - this.radius; y <= cy + this.radius; y++) {
        if (x < 0 || y < 0 || x > 0xfe || y > 0xfe) continue;
        want.add(landblockId(x, y));
      }
    }
    for (const [id, objs] of this.loaded) {
      if (!want.has(id)) {
        for (const o of objs) o.parent?.remove(o);
        this.loaded.delete(id);
        for (const cid of [...this.envcells.cells.keys()]) if ((cid & 0xffff0000) === (id & 0xffff0000)) this.envcells.cells.delete(cid);
      }
    }
    for (const id of want) if (!this.loaded.has(id) && !this.loading.has(id)) this.load(id);
  }

  private async load(id: number) {
    this.loading.add(id);
    const objs: THREE.Object3D[] = [];
    try {
      const dungeon = await this.objects.isDungeon(id);
      const mesh = dungeon ? null : await this.terrain.landblock(id);
      if (mesh) { this.outdoor.add(mesh); objs.push(mesh); }
      const g = await this.objects.landblockObjects(id);
      this.outdoor.add(g); objs.push(g);
      if (this.interiors) {
        const r = await this.envcells.landblockCells(id);
        this.indoor.add(r.group); objs.push(r.group);
      }
      if (this.scenery && !dungeon) {
        const geo = this.terrain.geometries.get(id);
        if (geo) { const s = await this.objects.scenery(id, geo); this.outdoor.add(s); objs.push(s); }
      }
      this.loaded.set(id, objs);
    } catch (e) {
      this.onLog?.(`landblock ${id.toString(16)} failed: ${(e as Error).message}`);
    } finally {
      this.loading.delete(id);
    }
  }

  geometryAt(worldX: number, worldY: number): LandblockGeometry | undefined {
    const id = landblockId(Math.floor(worldX / BLOCK_LENGTH), Math.floor(worldY / BLOCK_LENGTH));
    return this.terrain.geometries.get(id);
  }

  /** Terrain height at a world position, or null if that block isn't loaded. */
  heightAt(worldX: number, worldY: number): number | null {
    const geo = this.geometryAt(worldX, worldY);
    if (!geo) return null;
    const s = sampleTerrain(geo, worldX - geo.originX, worldY - geo.originY);
    return s ? s.z : null;
  }
}
