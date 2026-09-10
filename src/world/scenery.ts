/**
 * Procedural scenery (trees, rocks, shrubs) placed per terrain vertex from
 * Scene (0x12) descriptions. Ported from ACE Landblock.get_land_scenes and
 * ObjectDesc; all PRNG math is uint32-wrapped like the original client.
 */
import type { Landblock, RegionDesc, Scene, ObjectDesc } from "../dat/mod.ts";
import { BLOCK_LENGTH, CELL_LENGTH, cornerVertex, VERTEX_DIM, type LandblockGeometry } from "./terrain.ts";

const ROAD_WIDTH = 5;

export interface SceneryPlacement {
  objId: number;
  /** block-local position */
  x: number;
  y: number;
  z: number;
  /** rotation about +Z in radians (applied after baseLoc orientation is ignored, as in ACE) */
  quaternion: [number, number, number, number];
  scale: number;
}

const u32 = (v: number) => v >>> 0;
const mul = (a: number, b: number) => Math.imul(a | 0, b | 0);
const frac = (v: number) => u32(v) * 2.3283064e-10;

export interface SceneSource {
  scene(id: number): Scene | null;
}

/** Terrain sampling helpers on a built landblock geometry. */
export function sampleTerrain(geo: LandblockGeometry, x: number, y: number): { z: number; nx: number; ny: number; nz: number } | null {
  if (x < 0 || y < 0 || x >= BLOCK_LENGTH || y >= BLOCK_LENGTH) return null;
  const cx = Math.floor(x / CELL_LENGTH), cy = Math.floor(y / CELL_LENGTH);
  const cell = geo.cells[cx * 8 + cy];
  const lx = x - cx * CELL_LENGTH, ly = y - cy * CELL_LENGTH;
  // pick the triangle containing the point
  let tri: [number, number, number];
  if (cell.nwse) tri = lx + ly < CELL_LENGTH ? cell.tris[0] : cell.tris[1];
  else tri = lx >= ly ? cell.tris[0] : cell.tris[1];
  const p = tri.map((c) => {
    const vi = cornerVertex(cx, cy, c) * 3;
    return [geo.positions[vi], geo.positions[vi + 1], geo.positions[vi + 2]];
  });
  const ax = p[1][0] - p[0][0], ay = p[1][1] - p[0][1], az = p[1][2] - p[0][2];
  const bx = p[2][0] - p[0][0], by = p[2][1] - p[0][1], bz = p[2][2] - p[0][2];
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  if (Math.abs(nz) < 1e-6) return null;
  const d = -(nx * p[0][0] + ny * p[0][1] + nz * p[0][2]);
  const z = -(nx * x + ny * y + d) / nz;
  return { z, nx, ny, nz };
}

function road(lb: Landblock, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= VERTEX_DIM || y >= VERTEX_DIM) return 0;
  return lb.terrain[x * VERTEX_DIM + y] & 3;
}

/** Port of Landblock.OnRoad: is the point within ROAD_WIDTH of a road edge/corner. */
export function onRoad(lb: Landblock, px: number, py: number): boolean {
  const x = Math.floor(px / CELL_LENGTH), y = Math.floor(py / CELL_LENGTH);
  const rMin = ROAD_WIDTH, rMax = CELL_LENGTH - ROAD_WIDTH, T = CELL_LENGTH;
  const r0 = road(lb, x, y), r1 = road(lb, x, y + 1), r2 = road(lb, x + 1, y), r3 = road(lb, x + 1, y + 1);
  if (!r0 && !r1 && !r2 && !r3) return false;
  const dx = px - x * T, dy = py - y * T;
  const key = (r0 ? 8 : 0) | (r1 ? 4 : 0) | (r2 ? 2 : 0) | (r3 ? 1 : 0);
  switch (key) {
    case 0b1111: return true;
    case 0b1110: return dx < rMin || dy < rMin;
    case 0b1101: return dx < rMin || dy > rMax;
    case 0b1100: return dx < rMin;
    case 0b1011: return dx > rMax || dy < rMin;
    case 0b1010: return dy < rMin;
    case 0b1001: return Math.abs(dx - dy) < rMin;
    case 0b1000: return dx + dy < rMin;
    case 0b0111: return dx > rMax || dy > rMax;
    case 0b0110: return Math.abs(dx + dy - T) < rMin;
    case 0b0101: return dy > rMax;
    case 0b0100: return dx + (T - dy) < rMin;
    case 0b0011: return dx > rMax;
    case 0b0010: return (T - dx) + dy < rMin;
    case 0b0001: return (T - dx) + (T - dy) < rMin;
    default: return false;
  }
}

function displace(obj: ObjectDesc, ix: number, iy: number, iq: number): [number, number, number] {
  const loc = obj.baseLoc.origin;
  const base = (k: number) => frac(mul(1813693831, iy) - mul(iq + k, mul(mul(1360117743, iy), ix) + 1888038839) - mul(1109124029, ix));
  const x = obj.displaceX <= 0 ? loc.x : base(45773) * obj.displaceX + loc.x;
  const y = obj.displaceY <= 0 ? loc.y : base(72719) * obj.displaceY + loc.y;
  const z = loc.z;
  const quadrant = frac(mul(1813693831, iy) - mul(ix, mul(1870387557, iy) + 1109124029) - 402451965);
  if (quadrant >= 0.75) return [y, -x, z];
  if (quadrant >= 0.5) return [-x, -y, z];
  if (quadrant >= 0.25) return [-y, x, z];
  return [x, y, z];
}

function scaleObj(obj: ObjectDesc, x: number, y: number, k: number): number {
  if (obj.minScale === obj.maxScale) return obj.maxScale;
  const t = frac(mul(1813693831, y) - mul(k + 32593, mul(mul(1360117743, y), x) + 1888038839) - mul(1109124029, x));
  return Math.pow(obj.maxScale / obj.minScale, t) * obj.minScale;
}

/** AFrame.set_heading(degrees): rotation about +Z by -degrees (0 = north, clockwise). */
function headingQuat(degrees: number): [number, number, number, number] {
  const zDeg = 450 - (90 - degrees); // heading vector (sin, cos) -> atan2 = 90 - degrees
  const zRot = -((zDeg % 360) * Math.PI / 180);
  return [0, 0, Math.sin(zRot / 2), Math.cos(zRot / 2)];
}

function alignQuat(nx: number, ny: number): [number, number, number, number] {
  // ObjAlign: heading from the negated plane normal
  const hx = -nx, hy = -ny;
  if (Math.hypot(hx, hy) < 1e-6) return headingQuat(0);
  const heading = (450 - Math.atan2(hy, hx) * 180 / Math.PI) % 360;
  return headingQuat(heading);
}

export function buildScenery(
  lb: Landblock, geo: LandblockGeometry, region: RegionDesc, scenes: SceneSource, buildingCells: Set<number>,
): SceneryPlacement[] {
  const out: SceneryPlacement[] = [];
  if (!region.scene) return out;
  const blockX = (lb.id >>> 24) * 8, blockY = ((lb.id >>> 16) & 0xff) * 8;
  for (let i = 0; i < 81; i++) {
    const terrain = lb.terrain[i];
    const terrainType = (terrain >> 2) & 0x1f;
    const sceneType = terrain >> 11;
    const tt = region.terrainTypes[terrainType];
    if (!tt) continue;
    const sceneInfo = tt.sceneTypes[sceneType];
    const sceneList = region.scene[sceneInfo]?.scenes;
    if (!sceneList || sceneList.length === 0) continue;
    const cellX = Math.floor(i / VERTEX_DIM), cellY = i % VERTEX_DIM;
    const gx = cellX + blockX, gy = cellY + blockY;
    let cellMat = u32(mul(gy, mul(712977289, gx) + 1813693831) - mul(1109124029, gx) + 2139937281);
    let sceneIdx = Math.floor(sceneList.length * cellMat * 2.3283064e-10);
    if (sceneIdx >= sceneList.length) sceneIdx = 0;
    const scene = scenes.scene(sceneList[sceneIdx]);
    if (!scene) continue;
    const cellXMat = mul(-1109124029, gx), cellYMat = mul(1813693831, gy);
    cellMat = mul(mul(1360117743, gx), gy) + 1888038839;
    for (let j = 0; j < scene.objects.length; j++) {
      const obj = scene.objects[j];
      const noise = frac(cellXMat + cellYMat - mul(cellMat, 23399 + j));
      if (!(noise < obj.freq && obj.weenieObj === 0)) continue;
      const [px, py] = displace(obj, gx, gy, j);
      const lx = cellX * CELL_LENGTH + px, ly = cellY * CELL_LENGTH + py;
      if (lx < 0 || ly < 0 || lx >= BLOCK_LENGTH || ly >= BLOCK_LENGTH) continue;
      if (onRoad(lb, lx, ly)) continue;
      const cell = Math.floor(lx / CELL_LENGTH) * 8 + Math.floor(ly / CELL_LENGTH);
      if (buildingCells.has(cell)) continue;
      const s = sampleTerrain(geo, lx, ly);
      if (!s) continue;
      if (!(s.nz >= obj.minSlope && s.nz <= obj.maxSlope)) continue;
      let quaternion: [number, number, number, number];
      if (obj.align !== 0) quaternion = alignQuat(s.nx, s.ny);
      else if (obj.maxRotation > 0) {
        const deg = frac(mul(1813693831, gy) - mul(j + 63127, mul(mul(1360117743, gy), gx) + 1888038839) - mul(1109124029, gx)) * obj.maxRotation;
        quaternion = headingQuat(deg);
      } else {
        const q = obj.baseLoc.rotation;
        quaternion = [q.x, q.y, q.z, q.w];
      }
      out.push({ objId: obj.objId, x: lx, y: ly, z: s.z, quaternion, scale: scaleObj(obj, gx, gy, j) });
    }
  }
  return out;
}
