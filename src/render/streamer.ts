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
  /** landblock (id & 0xffff0000) of the player's server-reported cell, or null */
  playerBlock: number | null = null;
  private dungeonCache = new Map<number, boolean>();
  private mode: "outdoor" | "dungeon" | null = null;

  /** Tell the streamer which landblock the server says the player is in. */
  async setPlayerCell(cell: number) {
    const block = (cell & 0xffff0000) >>> 0;
    if (block === this.playerBlock) return;
    this.playerBlock = block;
    if (!this.dungeonCache.has(block)) this.dungeonCache.set(block, await this.objects.isDungeon((block | 0xffff) >>> 0));
    this.centerX = -1; // force a reload decision
  }

  get inDungeon(): boolean {
    return this.playerBlock !== null && this.dungeonCache.get(this.playerBlock) === true;
  }

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
    const mode = this.inDungeon ? "dungeon" : "outdoor";
    if (cx === this.centerX && cy === this.centerY && mode === this.mode) return;
    this.centerX = cx;
    this.centerY = cy;
    this.mode = mode;
    const want = new Set<number>();
    if (mode === "dungeon") {
      // a dungeon is one landblock; neighbouring dungeon landblocks overlap it in space, so load only this one
      want.add((this.playerBlock! | 0xffff) >>> 0);
    } else {
      for (let x = cx - this.radius; x <= cx + this.radius; x++) {
        for (let y = cy - this.radius; y <= cy + this.radius; y++) {
          if (x < 0 || y < 0 || x > 0xfe || y > 0xfe) continue;
          want.add(landblockId(x, y));
        }
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
      this.onLog?.(`landblock ${id.toString(16)} failed: ${(e as Error).message} (will retry)`);
      for (const o of objs) o.parent?.remove(o);
      // retry on the next update pass
      setTimeout(() => { this.centerX = -1; }, 2000);
    } finally {
      this.loading.delete(id);
    }
  }

  geometryAt(worldX: number, worldY: number): LandblockGeometry | undefined {
    const id = landblockId(Math.floor(worldX / BLOCK_LENGTH), Math.floor(worldY / BLOCK_LENGTH));
    return this.terrain.geometries.get(id);
  }

  private raycaster = new THREE.Raycaster();

  /**
   * Floor height under a world position: nearest surface below (x, y, z + up)
   * among the current cell (and its visible cells) or the terrain block.
   */
  floorAt(x: number, y: number, z: number, up = 1.2, down = 6): number | null {
    const cell = this.envcells.findCell(new THREE.Vector3(x, y, z), this.playerBlock);
    let candidates: THREE.Object3D[];
    if (cell) {
      const block = cell.id & 0xffff0000;
      candidates = [cell.group];
      for (const v of cell.envCell.visibleCells) {
        const c = this.envcells.cells.get((block | v) >>> 0);
        if (c) candidates.push(c.group);
      }
    } else {
      const id = landblockId(Math.floor(x / BLOCK_LENGTH), Math.floor(y / BLOCK_LENGTH));
      const mesh = this.loaded.get(id)?.[0];
      candidates = mesh ? [mesh] : [];
      // also allow standing on interior floors of buildings when detection missed
      for (const c of this.envcells.cells.values()) if (c.box.containsPoint(new THREE.Vector3(x, y, z))) candidates.push(c.group);
    }
    if (!candidates.length) return this.heightAt(x, y);
    this.raycaster.set(new THREE.Vector3(x, y, z + up), new THREE.Vector3(0, 0, -1));
    this.raycaster.far = up + down;
    const hits = this.raycaster.intersectObjects(candidates, true);
    if (hits.length) return hits[0].point.z;
    return cell ? null : this.heightAt(x, y);
  }

  /** Terrain height at a world position, or null if that block isn't loaded. */
  heightAt(worldX: number, worldY: number): number | null {
    const geo = this.geometryAt(worldX, worldY);
    if (!geo) return null;
    const s = sampleTerrain(geo, worldX - geo.originX, worldY - geo.originY);
    return s ? s.z : null;
  }
}
