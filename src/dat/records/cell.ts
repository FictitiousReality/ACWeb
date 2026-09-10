import type { BinReader, Frame } from "../reader.ts";
import { BSPType } from "../types.ts";
import { type BSPNode, parseBSP, parsePolygon, parseStab, parseVertexArray, type Polygon, type Stab, type VertexArray } from "./common.ts";

/** xxxxFFFF in client_cell: outdoor terrain of one 192x192 landblock (9x9 vertices). */
export interface Landblock {
  id: number;
  hasObjects: boolean;
  /** 81 entries, index = x*9 + y. bits: road 0-1, type 2-6, scenery 11-15 */
  terrain: Uint16Array;
  /** 81 entries, index into RegionDesc.landDefs.landHeightTable */
  height: Uint8Array;
}
export function parseLandblock(r: BinReader): Landblock {
  const id = r.u32();
  const hasObjects = r.u32() === 1;
  const terrain = new Uint16Array(81);
  for (let i = 0; i < 81; i++) terrain[i] = r.u16();
  const height = new Uint8Array(81);
  for (let i = 0; i < 81; i++) height[i] = r.u8();
  r.align();
  return { id, hasObjects, terrain, height };
}

export const terrainRoad = (t: number) => t & 0x3;
export const terrainType = (t: number) => (t & 0x7c) >> 2;
export const terrainScenery = (t: number) => (t & 0xf800) >> 11;

export interface BldPortal {
  flags: number;
  otherCellId: number;
  otherPortalId: number;
  stabs: number[];
}
export interface BuildInfo {
  modelId: number;
  frame: Frame;
  numLeaves: number;
  portals: BldPortal[];
}

/** xxxxFFFE in client_cell: static objects, buildings and dungeon cell count for a landblock. */
export interface LandblockInfo {
  id: number;
  numCells: number;
  objects: Stab[];
  packMask: number;
  buildings: BuildInfo[];
  restrictionTables: Map<number, number>;
}
export function parseLandblockInfo(r: BinReader): LandblockInfo {
  const id = r.u32();
  const numCells = r.u32();
  const objects = r.list(parseStab);
  const numBuildings = r.u16();
  const packMask = r.u16();
  const buildings = r.fixedList(numBuildings, (rr): BuildInfo => {
    const modelId = rr.u32();
    const frame = rr.frame();
    const numLeaves = rr.u32();
    const portals = rr.list((p): BldPortal => {
      const flags = p.u16();
      const otherCellId = p.u16();
      const otherPortalId = p.u16();
      const n = p.u16();
      const stabs = new Array<number>(n);
      for (let i = 0; i < n; i++) stabs[i] = p.u16();
      p.align();
      return { flags, otherCellId, otherPortalId, stabs };
    });
    return { modelId, frame, numLeaves, portals };
  });
  const restrictionTables = packMask & 1 ? r.packedHashTable((rr) => rr.u32()) : new Map<number, number>();
  return { id, numCells, objects, packMask, buildings, restrictionTables };
}

export enum EnvCellFlags {
  SeenOutside = 0x1,
  HasStaticObjs = 0x2,
  HasRestrictionObj = 0x8,
}
export interface CellPortal {
  flags: number;
  polygonId: number;
  otherCellId: number;
  otherPortalId: number;
}

/** xxxx0100+ in client_cell: one indoor cell (dungeon / building interior). */
export interface EnvCell {
  id: number;
  flags: number;
  surfaces: number[];
  environmentId: number;
  cellStructure: number;
  position: Frame;
  portals: CellPortal[];
  visibleCells: number[];
  staticObjects: Stab[];
  restrictionObj: number;
}
export function parseEnvCell(r: BinReader): EnvCell {
  const id = r.u32();
  const flags = r.u32();
  r.skip(4); // cell id repeated
  const numSurfaces = r.u8();
  const numPortals = r.u8();
  const numStabs = r.u16();
  const surfaces = new Array<number>(numSurfaces);
  for (let i = 0; i < numSurfaces; i++) surfaces[i] = (0x08000000 | r.u16()) >>> 0;
  const environmentId = (0x0d000000 | r.u16()) >>> 0;
  const cellStructure = r.u16();
  const position = r.frame();
  const portals = r.fixedList(numPortals, (rr): CellPortal => ({
    flags: rr.u16(), polygonId: rr.u16(), otherCellId: rr.u16(), otherPortalId: rr.u16(),
  }));
  const visibleCells = new Array<number>(numStabs);
  for (let i = 0; i < numStabs; i++) visibleCells[i] = r.u16();
  const staticObjects = flags & EnvCellFlags.HasStaticObjs ? r.list(parseStab) : [];
  const restrictionObj = flags & EnvCellFlags.HasRestrictionObj ? r.u32() : 0;
  return { id, flags, surfaces, environmentId, cellStructure, position, portals, visibleCells, staticObjects, restrictionObj };
}

export interface CellStruct {
  vertexArray: VertexArray;
  polygons: Map<number, Polygon>;
  portals: number[];
  cellBSP: BSPNode;
  physicsPolygons: Map<number, Polygon>;
  physicsBSP: BSPNode;
  drawingBSP?: BSPNode;
}
function parseCellStruct(r: BinReader): CellStruct {
  const numPolygons = r.u32();
  const numPhysicsPolygons = r.u32();
  const numPortals = r.u32();
  const vertexArray = parseVertexArray(r);
  const polygons = new Map<number, Polygon>();
  for (let i = 0; i < numPolygons; i++) {
    const key = r.u16();
    polygons.set(key, parsePolygon(r));
  }
  const portals = new Array<number>(numPortals);
  for (let i = 0; i < numPortals; i++) portals[i] = r.u16();
  r.align();
  const cellBSP = parseBSP(r, BSPType.Cell);
  const physicsPolygons = new Map<number, Polygon>();
  for (let i = 0; i < numPhysicsPolygons; i++) {
    const key = r.u16();
    physicsPolygons.set(key, parsePolygon(r));
  }
  const physicsBSP = parseBSP(r, BSPType.Physics);
  const hasDrawingBSP = r.u32();
  const drawingBSP = hasDrawingBSP !== 0 ? parseBSP(r, BSPType.Drawing) : undefined;
  r.align();
  return { vertexArray, polygons, portals, cellBSP, physicsPolygons, physicsBSP, drawingBSP };
}

/** 0x0Dxxxxxx in portal: prefab geometry for indoor cells. */
export interface Environment {
  id: number;
  cells: Map<number, CellStruct>;
}
export function parseEnvironment(r: BinReader): Environment {
  const id = r.u32();
  return { id, cells: r.mapU32(parseCellStruct) };
}
