import type { BinReader, Vec3 } from "../reader.ts";
import { BSPType } from "../types.ts";
import { type BSPNode, parseBSP, parsePolygon, parseVertexArray, type Polygon, type VertexArray } from "./common.ts";

export enum GfxObjFlags {
  HasPhysics = 0x1,
  HasDrawing = 0x2,
  HasDIDDegrade = 0x8,
}

/** 0x01xxxxxx: a single rigid mesh with per-polygon surface references. */
export interface GfxObj {
  id: number;
  flags: number;
  surfaces: number[];
  vertexArray: VertexArray;
  physicsPolygons: Map<number, Polygon>;
  physicsBSP?: BSPNode;
  sortCenter: Vec3;
  polygons: Map<number, Polygon>;
  drawingBSP?: BSPNode;
  didDegrade: number;
}

export function parseGfxObj(r: BinReader): GfxObj {
  const id = r.u32();
  const flags = r.u32();
  const surfaces = r.u32SmartArray();
  const vertexArray = parseVertexArray(r);
  let physicsPolygons = new Map<number, Polygon>();
  let physicsBSP: BSPNode | undefined;
  if (flags & GfxObjFlags.HasPhysics) {
    physicsPolygons = r.smartMapU16(parsePolygon);
    physicsBSP = parseBSP(r, BSPType.Physics);
  }
  const sortCenter = r.vec3();
  let polygons = new Map<number, Polygon>();
  let drawingBSP: BSPNode | undefined;
  if (flags & GfxObjFlags.HasDrawing) {
    polygons = r.smartMapU16(parsePolygon);
    drawingBSP = parseBSP(r, BSPType.Drawing);
  }
  let didDegrade = 0;
  if (flags & GfxObjFlags.HasDIDDegrade) didDegrade = r.u32();
  return { id, flags, surfaces, vertexArray, physicsPolygons, physicsBSP, sortCenter, polygons, drawingBSP, didDegrade };
}
