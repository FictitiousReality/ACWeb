/**
 * Turn GfxObj polygons into flat triangle lists grouped by surface, and
 * resolve Setup part placement. Pure data; the renderer maps to GPU buffers.
 */
import type { GfxObj } from "../dat/records/gfxobj.ts";
import type { Polygon } from "../dat/records/common.ts";
import { CullMode } from "../dat/types.ts";

export interface MeshGroup {
  /** index into GfxObj.surfaces */
  surfaceIndex: number;
  doubleSided: boolean;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  triangleCount: number;
}

export interface MeshData {
  id: number;
  groups: MeshGroup[];
}

function triangulate(poly: Polygon, g: GfxObj, pos: number[], nrm: number[], uv: number[], flip: boolean, useNeg: boolean) {
  const ids = poly.vertexIds;
  const uvIdx = useNeg ? poly.negUVIndices : poly.posUVIndices;
  const n = ids.length;
  const push = (k: number) => {
    const v = g.vertexArray.vertices.get(ids[k] & 0xffff);
    if (!v) throw new Error(`GfxObj ${g.id.toString(16)}: missing vertex ${ids[k]}`);
    pos.push(v.origin.x, v.origin.y, v.origin.z);
    const s = useNeg ? -1 : 1;
    nrm.push(v.normal.x * s, v.normal.y * s, v.normal.z * s);
    const t = v.uvs[uvIdx[k] ?? 0];
    uv.push(t ? t.u : 0, t ? t.v : 0);
  };
  for (let k = 1; k + 1 < n; k++) {
    if (flip) { push(0); push(k + 1); push(k); }
    else { push(0); push(k); push(k + 1); }
  }
}

/**
 * AC polygon vertex order is already counter-clockwise for front faces in a
 * right-handed Z-up world, so it maps to Three.js FrontSide unchanged.
 */
export function buildMesh(g: GfxObj): MeshData {
  const buckets = new Map<string, { surfaceIndex: number; doubleSided: boolean; pos: number[]; nrm: number[]; uv: number[] }>();
  const bucket = (surfaceIndex: number, doubleSided: boolean) => {
    const key = `${surfaceIndex}:${doubleSided ? 1 : 0}`;
    let b = buckets.get(key);
    if (!b) {
      b = { surfaceIndex, doubleSided, pos: [], nrm: [], uv: [] };
      buckets.set(key, b);
    }
    return b;
  };
  for (const poly of g.polygons.values()) {
    if (poly.vertexIds.length < 3) continue;
    if (poly.sidesType === CullMode.None) {
      const b = bucket(poly.posSurface, true);
      triangulate(poly, g, b.pos, b.nrm, b.uv, false, false);
    } else if (poly.sidesType === CullMode.Clockwise) {
      // two-sided with distinct back surface
      const f = bucket(poly.posSurface, false);
      triangulate(poly, g, f.pos, f.nrm, f.uv, false, false);
      const b = bucket(poly.negSurface, false);
      triangulate(poly, g, b.pos, b.nrm, b.uv, true, true);
    } else {
      const b = bucket(poly.posSurface, false);
      triangulate(poly, g, b.pos, b.nrm, b.uv, false, false);
    }
  }
  const groups: MeshGroup[] = [];
  for (const b of buckets.values()) {
    groups.push({
      surfaceIndex: b.surfaceIndex,
      doubleSided: b.doubleSided,
      positions: new Float32Array(b.pos),
      normals: new Float32Array(b.nrm),
      uvs: new Float32Array(b.uv),
      triangleCount: b.pos.length / 9,
    });
  }
  return { id: g.id, groups };
}

import type { CellStruct } from "../dat/records/cell.ts";

/**
 * Indoor cell geometry. Surface indices refer to the owning EnvCell's surface
 * list. Polygons with stippling == NoPos are portal openings and are skipped.
 */
export function buildCellMesh(cell: CellStruct, id: number): MeshData {
  const buckets = new Map<number, { pos: number[]; nrm: number[]; uv: number[] }>();
  const verts = cell.vertexArray.vertices;
  for (const poly of cell.polygons.values()) {
    if (poly.vertexIds.length < 3) continue;
    if (poly.stippling === 4 /* NoPos: portal / invisible */) continue;
    let b = buckets.get(poly.posSurface);
    if (!b) buckets.set(poly.posSurface, b = { pos: [], nrm: [], uv: [] });
    const n = poly.vertexIds.length;
    const push = (k: number) => {
      const v = verts.get(poly.vertexIds[k] & 0xffff);
      if (!v) throw new Error(`CellStruct ${id.toString(16)}: missing vertex ${poly.vertexIds[k]}`);
      b!.pos.push(v.origin.x, v.origin.y, v.origin.z);
      b!.nrm.push(v.normal.x, v.normal.y, v.normal.z);
      const t = v.uvs[poly.posUVIndices[k] ?? 0];
      b!.uv.push(t ? t.u : 0, t ? t.v : 0);
    };
    for (let k = 1; k + 1 < n; k++) { push(0); push(k); push(k + 1); }
  }
  const groups: MeshGroup[] = [];
  for (const [surfaceIndex, b] of buckets) {
    groups.push({
      surfaceIndex, doubleSided: true,
      positions: new Float32Array(b.pos), normals: new Float32Array(b.nrm), uvs: new Float32Array(b.uv),
      triangleCount: b.pos.length / 9,
    });
  }
  return { id, groups };
}
