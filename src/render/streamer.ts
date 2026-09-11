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
  private loaded = new Map<number, { objs: THREE.Object3D[]; detail: boolean }>();
  private loading = new Set<number>();
  private centerX = -1;
  private centerY = -1;
  /** landblocks with objects, scenery and interiors around the player */
  radius = 2;
  /** landblocks with terrain only, beyond `radius` */
  terrainRadius = 5;
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

  /** Distance (world units) to the edge of loaded terrain; fog should end before this. */
  get viewDistance(): number {
    return (this.terrainRadius + 0.5) * BLOCK_LENGTH;
  }

  /** Call whenever the player moves; loads/unloads as the center landblock changes. */
  update(worldX: number, worldY: number) {
    const cx = Math.floor(worldX / BLOCK_LENGTH), cy = Math.floor(worldY / BLOCK_LENGTH);
    const mode = this.inDungeon ? "dungeon" : "outdoor";
    if (cx === this.centerX && cy === this.centerY && mode === this.mode) return;
    this.centerX = cx;
    this.centerY = cy;
    this.mode = mode;
    const want = new Map<number, boolean>(); // id -> wants detail
    if (mode === "dungeon") {
      // a dungeon is one landblock; neighbouring dungeon landblocks overlap it in space, so load only this one
      want.set((this.playerBlock! | 0xffff) >>> 0, true);
    } else {
      const R = Math.max(this.radius, this.terrainRadius);
      for (let x = cx - R; x <= cx + R; x++) {
        for (let y = cy - R; y <= cy + R; y++) {
          if (x < 0 || y < 0 || x > 0xfe || y > 0xfe) continue;
          const detail = Math.abs(x - cx) <= this.radius && Math.abs(y - cy) <= this.radius;
          want.set(landblockId(x, y), detail);
        }
      }
    }
    for (const [id, entry] of this.loaded) {
      const w = want.get(id);
      if (w === undefined || (entry.detail && !w)) {
        // unload entirely, or drop detail (everything but the terrain mesh) when it drifts out of the detail ring
        const keep = w !== undefined ? entry.objs.filter((o) => o.name.startsWith("lb_")) : [];
        for (const o of entry.objs) if (!keep.includes(o)) o.parent?.remove(o);
        for (const cid of [...this.envcells.cells.keys()]) if ((cid & 0xffff0000) === (id & 0xffff0000)) this.envcells.cells.delete(cid);
        if (w === undefined) this.loaded.delete(id);
        else this.loaded.set(id, { objs: keep, detail: false });
      }
    }
    // nearest first so the player's surroundings appear before the horizon
    const order = [...want.entries()].sort((a, b) => {
      const da = Math.hypot((a[0] >>> 24) - cx, ((a[0] >>> 16) & 0xff) - cy), db = Math.hypot((b[0] >>> 24) - cx, ((b[0] >>> 16) & 0xff) - cy);
      return da - db;
    });
    for (const [id, detail] of order) {
      const entry = this.loaded.get(id);
      if (this.loading.has(id)) continue;
      if (!entry) this.load(id, detail);
      else if (detail && !entry.detail) this.load(id, true, entry.objs);
    }
  }

  private async load(id: number, detail: boolean, existing: THREE.Object3D[] = []) {
    this.loading.add(id);
    const objs: THREE.Object3D[] = [...existing];
    try {
      const dungeon = await this.objects.isDungeon(id);
      if (!existing.length) {
        const mesh = dungeon ? null : await this.terrain.landblock(id);
        if (mesh) { this.outdoor.add(mesh); objs.push(mesh); }
      }
      if (detail) {
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
      }
      this.loaded.set(id, { objs, detail });
    } catch (e) {
      this.onLog?.(`landblock ${id.toString(16)} failed: ${(e as Error).message} (will retry)`);
      for (const o of objs) o.parent?.remove(o);
      // retry on the next update pass
      setTimeout(() => { this.centerX = -1; }, 2000);
    } finally {
      this.loading.delete(id);
    }
  }

  /** True once the landblock under a point has at least its terrain loaded. */
  isLoaded(worldX: number, worldY: number): boolean {
    return this.loaded.has(landblockId(Math.floor(worldX / BLOCK_LENGTH), Math.floor(worldY / BLOCK_LENGTH)));
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
      const mesh = this.loaded.get(id)?.objs.find((o) => o.name.startsWith("lb_"));
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
