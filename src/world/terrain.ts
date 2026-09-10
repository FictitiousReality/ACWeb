/**
 * Outdoor terrain: landblock vertex grid, cell triangulation and the
 * TexMerge surface selection (which textures/alpha masks blend in each cell).
 * Ported from ACE.Server.Physics.Common (LandblockStruct, TexMerge, LandSurf).
 */
import type { Landblock } from "../dat/records/cell.ts";
import type { RegionDesc, RoadAlphaMap, TerrainAlphaMap, TerrainTex } from "../dat/records/region.ts";

export const BLOCK_LENGTH = 192;
export const CELL_LENGTH = 24;
export const VERTEX_DIM = 9;
export const BLOCK_SIDE = 8;
export const ROAD_TYPE = 0x20;
export const LAND_LENGTH = 2040; // cells per world side

export type Rotation = 0 | 1 | 2 | 3;

/** Corner index convention: 0=SW (x,y), 1=SE (x+1,y), 2=NE (x+1,y+1), 3=NW (x,y+1). */
export const LAND_UVS: readonly (readonly [number, number])[] = [[0, 1], [1, 1], [1, 0], [0, 0]];

export function rotatedUV(rot: Rotation, corner: number): readonly [number, number] {
  return LAND_UVS[(corner - rot + 4) & 3];
}

export function landblockX(id: number): number {
  return id >>> 24;
}
export function landblockY(id: number): number {
  return (id >>> 16) & 0xff;
}
export function landblockId(x: number, y: number): number {
  return (((x << 8) | y) << 16 | 0xffff) >>> 0;
}

/** True when the cell diagonal runs NW-SE (triangles SW,SE,NW and NE,NW,SE). */
export function splitNWSE(globalCellX: number, globalCellY: number): boolean {
  const x = globalCellX | 0, y = globalCellY | 0;
  const dw = (Math.imul(Math.imul(x, y), 0x0ccac033) - Math.imul(x, 0x421be3bd) +
    Math.imul(y, 0x6c1ac587) - 0x519b8f25) | 0;
  return dw >= 0;
}

export interface OverlayDesc {
  tex: TerrainTex;
  alpha: TerrainAlphaMap;
  rot: Rotation;
}
export interface RoadDesc {
  tex: TerrainTex;
  alphas: { alpha: RoadAlphaMap; rot: Rotation }[];
}
/** What gets blended in one cell: base texture, up to 3 terrain overlays, optional road. */
export interface CellSurface {
  palCode: number;
  base: TerrainTex;
  overlays: OverlayDesc[];
  road: RoadDesc | null;
  allRoad: boolean;
}

export function palCodeFor(lb: Landblock, cx: number, cy: number): number {
  const i = VERTEX_DIM * cx + cy;
  const j = i + VERTEX_DIM;
  const c = [lb.terrain[i], lb.terrain[j], lb.terrain[j + 1], lb.terrain[i + 1]]; // SW SE NE NW
  const t = c.map((v) => (v & 0x7f) >> 2);
  const r = c.map((v) => v & 3);
  const terrainBits = (t[0] << 15) | (t[1] << 10) | (t[2] << 5) | t[3];
  const roadBits = (r[0] << 26) | (r[1] << 24) | (r[2] << 22) | (r[3] << 20);
  return ((1 << 28) | roadBits | terrainBits) >>> 0;
}

export class TexMergeTable {
  private cache = new Map<number, CellSurface>();
  readonly road: TerrainTex;

  constructor(readonly region: RegionDesc) {
    this.road = this.terrainTex(ROAD_TYPE);
  }

  terrainTex(type: number): TerrainTex {
    const list = this.region.texMerge.terrainDesc;
    for (const d of list) if (d.terrainType === type) return d.terrainTex;
    return list[0].terrainTex;
  }

  surface(palCode: number): CellSurface {
    let s = this.cache.get(palCode);
    if (!s) {
      s = this.build(palCode);
      this.cache.set(palCode, s);
    }
    return s;
  }

  private build(pcode: number): CellSurface {
    const { terrainTex, tcode } = this.getTerrain(pcode);
    const { rcode, allRoad } = getRoadCode(pcode);
    if (allRoad) return { palCode: pcode, base: this.road, overlays: [], road: null, allRoad: true };
    const overlays: OverlayDesc[] = [];
    for (let i = 0; i < 3; i++) {
      if (tcode[i] === 0) break;
      const found = this.findTerrainAlpha(pcode, tcode[i]);
      if (!found) break;
      overlays.push({ tex: terrainTex[i + 1], alpha: found.alpha, rot: found.rot });
    }
    let road: RoadDesc | null = null;
    for (let i = 0; i < 2; i++) {
      if (rcode[i] === 0) break;
      const found = this.findRoadAlpha(pcode, rcode[i]);
      if (!found) break;
      if (!road) road = { tex: this.road, alphas: [] };
      road.alphas.push(found);
    }
    return { palCode: pcode, base: terrainTex[0], overlays, road, allRoad: false };
  }

  private getTerrain(pcode: number): { terrainTex: TerrainTex[]; tcode: number[] } {
    const pcodes = [(pcode >>> 15) & 0x1f, (pcode >>> 10) & 0x1f, (pcode >>> 5) & 0x1f, pcode & 0x1f];
    const tcode = [0, 0, 0];
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        if (pcodes[i] === pcodes[j]) return { terrainTex: this.buildTCodes(pcodes, tcode, i), tcode };
      }
    }
    const terrainTex = pcodes.map((p) => this.terrainTex(p));
    for (let i = 0; i < 3; i++) tcode[i] = 1 << (i + 1);
    return { terrainTex, tcode };
  }

  private buildTCodes(pcodes: number[], tcode: number[], i: number): TerrainTex[] {
    const out: TerrainTex[] = [this.terrainTex(pcodes[i]), this.road, this.road];
    const t1 = pcodes[i];
    let t2 = -1;
    for (let k = 0; k < 4; k++) {
      if (t1 === pcodes[k]) continue;
      if (tcode[0] === 0) {
        tcode[0] = 1 << k;
        t2 = pcodes[k];
        out[1] = this.terrainTex(t2);
      } else {
        if (t2 === pcodes[k] && tcode[0] === 1 << (k - 1)) {
          tcode[0] += 1 << k;
        } else {
          out[2] = this.terrainTex(pcodes[k]);
          tcode[1] = 1 << k;
        }
        break;
      }
    }
    return out;
  }

  private findTerrainAlpha(pcode: number, tcode: number): { alpha: TerrainAlphaMap; rot: Rotation } | null {
    const corner = tcode === 1 || tcode === 2 || tcode === 4 || tcode === 8;
    const maps = corner ? this.region.texMerge.cornerTerrainMaps : this.region.texMerge.sideTerrainMaps;
    const n = maps.length;
    if (n === 0) return null;
    let prng = Math.floor(prngOf(pcode) * n);
    if (prng >= n) prng = 0;
    const alpha = maps[prng];
    let code = alpha.tcode;
    let i = 0;
    while (code !== tcode) {
      code *= 2;
      if (code >= 16) code -= 15;
      if (++i >= 4) return null;
    }
    return { alpha, rot: i as Rotation };
  }

  private findRoadAlpha(pcode: number, rcode: number): { alpha: RoadAlphaMap; rot: Rotation } | null {
    const maps = this.region.texMerge.roadMaps;
    const n = maps.length;
    if (n === 0) return null;
    const prng = Math.floor(prngOf(pcode) * n);
    for (let i = 0; i < n; i++) {
      const alpha = maps[(i + prng) % n];
      let code = alpha.rcode;
      for (let j = 0; j < 4; j++) {
        if (code === rcode) return { alpha, rot: j as Rotation };
        code *= 2;
        if (code >= 16) code -= 15;
      }
    }
    return null;
  }
}

/** Client PRNG: (1379576222 * pcode - 1372186442) as uint32, scaled to [0,1). */
function prngOf(pcode: number): number {
  return ((Math.imul(1379576222, pcode) - 1372186442) >>> 0) * 2.3283064e-10;
}

function getRoadCode(pcode: number): { rcode: number[]; allRoad: boolean } {
  let mask = 0;
  if (pcode & 0xc000000) mask |= 1;
  if (pcode & 0x3000000) mask |= 2;
  if (pcode & 0xc00000) mask |= 4;
  if (pcode & 0x300000) mask |= 8;
  const rcode = [0, 0];
  let allRoad = false;
  switch (mask) {
    case 0xf: allRoad = true; break;
    case 0xe: rcode[0] = 6; rcode[1] = 12; break;
    case 0xd: rcode[0] = 9; rcode[1] = 12; break;
    case 0xb: rcode[0] = 9; rcode[1] = 3; break;
    case 0x7: rcode[0] = 3; rcode[1] = 6; break;
    case 0x0: break;
    default: rcode[0] = mask;
  }
  return { rcode, allRoad };
}

export interface CellTriangles {
  cx: number;
  cy: number;
  nwse: boolean;
  /** Two triangles, each three corner indices (0=SW,1=SE,2=NE,3=NW). */
  tris: [number, number, number][];
  surface: CellSurface;
}

export interface LandblockGeometry {
  id: number;
  /** world x/y origin of the block */
  originX: number;
  originY: number;
  /** 81 vertex positions (block-local), index = x*9 + y */
  positions: Float32Array;
  normals: Float32Array;
  cells: CellTriangles[];
  hasWater: boolean;
}

const WATER_TYPES = new Set([16, 17, 18, 19, 20]);

/** Corner index -> vertex grid index for cell (cx, cy). */
export function cornerVertex(cx: number, cy: number, corner: number): number {
  switch (corner) {
    case 0: return cx * VERTEX_DIM + cy;
    case 1: return (cx + 1) * VERTEX_DIM + cy;
    case 2: return (cx + 1) * VERTEX_DIM + cy + 1;
    default: return cx * VERTEX_DIM + cy + 1;
  }
}

export function buildLandblockGeometry(lb: Landblock, region: RegionDesc, texMerge: TexMergeTable): LandblockGeometry {
  const lbx = landblockX(lb.id), lby = landblockY(lb.id);
  const table = region.landDefs.landHeightTable;
  const positions = new Float32Array(81 * 3);
  for (let x = 0; x < VERTEX_DIM; x++) {
    for (let y = 0; y < VERTEX_DIM; y++) {
      const i = x * VERTEX_DIM + y;
      positions[i * 3] = x * CELL_LENGTH;
      positions[i * 3 + 1] = y * CELL_LENGTH;
      positions[i * 3 + 2] = table[lb.height[i]];
    }
  }
  // Smooth normals from central differences of the height field.
  const normals = new Float32Array(81 * 3);
  const z = (x: number, y: number) => {
    x = Math.max(0, Math.min(8, x));
    y = Math.max(0, Math.min(8, y));
    return positions[(x * VERTEX_DIM + y) * 3 + 2];
  };
  for (let x = 0; x < VERTEX_DIM; x++) {
    for (let y = 0; y < VERTEX_DIM; y++) {
      const dx = (z(x + 1, y) - z(x - 1, y)) / ((Math.min(8, x + 1) - Math.max(0, x - 1)) * CELL_LENGTH);
      const dy = (z(x, y + 1) - z(x, y - 1)) / ((Math.min(8, y + 1) - Math.max(0, y - 1)) * CELL_LENGTH);
      let nx = -dx, ny = -dy, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = (x * VERTEX_DIM + y) * 3;
      normals[i] = nx; normals[i + 1] = ny; normals[i + 2] = nz;
    }
  }
  const cells: CellTriangles[] = [];
  let hasWater = false;
  for (let cx = 0; cx < BLOCK_SIDE; cx++) {
    for (let cy = 0; cy < BLOCK_SIDE; cy++) {
      const nwse = splitNWSE(lbx * BLOCK_SIDE + cx, lby * BLOCK_SIDE + cy);
      const tris: [number, number, number][] = nwse ? [[0, 1, 3], [2, 3, 1]] : [[0, 1, 2], [0, 2, 3]];
      const surface = texMerge.surface(palCodeFor(lb, cx, cy));
      cells.push({ cx, cy, nwse, tris, surface });
      for (let c = 0; c < 4; c++) {
        if (WATER_TYPES.has((lb.terrain[cornerVertex(cx, cy, c)] & 0x7f) >> 2)) hasWater = true;
      }
    }
  }
  return { id: lb.id, originX: lbx * BLOCK_LENGTH, originY: lby * BLOCK_LENGTH, positions, normals, cells, hasWater };
}
