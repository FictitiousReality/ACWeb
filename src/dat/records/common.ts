import type { BinReader, Frame, Vec3 } from "../reader.ts";
import { BSPType, CullMode, Stippling } from "../types.ts";

export interface Vertex {
  origin: Vec3;
  normal: Vec3;
  uvs: { u: number; v: number }[];
}

export interface VertexArray {
  type: number;
  vertices: Map<number, Vertex>;
}

export function parseVertexArray(r: BinReader): VertexArray {
  const type = r.i32();
  const n = r.u32();
  if (type !== 1) throw new Error(`Unsupported vertex array type ${type}`);
  const vertices = new Map<number, Vertex>();
  for (let i = 0; i < n; i++) {
    const key = r.u16();
    const numUVs = r.u16();
    const origin = r.vec3();
    const normal = r.vec3();
    const uvs = new Array(numUVs);
    for (let j = 0; j < numUVs; j++) uvs[j] = { u: r.f32(), v: r.f32() };
    vertices.set(key, { origin, normal, uvs });
  }
  return { type, vertices };
}

export interface Polygon {
  numPts: number;
  stippling: number;
  sidesType: CullMode;
  posSurface: number;
  negSurface: number;
  vertexIds: number[];
  posUVIndices: number[];
  negUVIndices: number[];
}

export function parsePolygon(r: BinReader): Polygon {
  const numPts = r.u8();
  const stippling = r.u8();
  const sidesType = r.i32() as CullMode;
  const posSurface = r.i16();
  let negSurface = r.i16();
  const vertexIds = new Array<number>(numPts);
  for (let i = 0; i < numPts; i++) vertexIds[i] = r.i16();
  let posUVIndices: number[] = [];
  let negUVIndices: number[] = [];
  if ((stippling & Stippling.NoPos) === 0) {
    posUVIndices = new Array<number>(numPts);
    for (let i = 0; i < numPts; i++) posUVIndices[i] = r.u8();
  }
  if (sidesType === CullMode.Clockwise && (stippling & Stippling.NoNeg) === 0) {
    negUVIndices = new Array<number>(numPts);
    for (let i = 0; i < numPts; i++) negUVIndices[i] = r.u8();
  }
  if (sidesType === CullMode.None) {
    negSurface = posSurface;
    negUVIndices = posUVIndices;
  }
  return { numPts, stippling, sidesType, posSurface, negSurface, vertexIds, posUVIndices, negUVIndices };
}

export interface Plane {
  n: Vec3;
  d: number;
}
export interface Sphere {
  origin: Vec3;
  radius: number;
}
export function parseSphere(r: BinReader): Sphere {
  return { origin: r.vec3(), radius: r.f32() };
}
export interface CylSphere extends Sphere {
  height: number;
}

// BSP node tags as little-endian u32 of the on-disk bytes.
const TAG_PORT = 0x504f5254;
const TAG_LEAF = 0x4c454146;
const TAG_BPnn = 0x42506e6e;
const TAG_BPIn = 0x4250496e;
const TAG_BpIN = 0x4270494e;
const TAG_BpnN = 0x42706e4e;
const TAG_BPIN = 0x4250494e;
const TAG_BPnN = 0x42506e4e;

export interface BSPNode {
  tag: number;
  plane?: Plane;
  pos?: BSPNode;
  neg?: BSPNode;
  sphere?: Sphere;
  inPolys?: number[];
  // leaf
  leafIndex?: number;
  solid?: number;
  // portal
  inPortals?: { portalIndex: number; polygonId: number }[];
}

export function parseBSP(r: BinReader, type: BSPType): BSPNode {
  const tag = r.u32();
  if (tag === TAG_LEAF) {
    const node: BSPNode = { tag, leafIndex: r.i32() };
    if (type === BSPType.Physics) {
      node.solid = r.i32();
      node.sphere = parseSphere(r);
      const n = r.u32();
      node.inPolys = new Array(n);
      for (let i = 0; i < n; i++) node.inPolys[i] = r.u16();
    }
    return node;
  }
  if (tag === TAG_PORT) {
    const node: BSPNode = { tag, plane: { n: r.vec3(), d: r.f32() } };
    node.pos = parseBSP(r, type);
    node.neg = parseBSP(r, type);
    if (type === BSPType.Drawing) {
      node.sphere = parseSphere(r);
      const numPolys = r.u32();
      const numPortals = r.u32();
      node.inPolys = new Array(numPolys);
      for (let i = 0; i < numPolys; i++) node.inPolys[i] = r.u16();
      node.inPortals = new Array(numPortals);
      for (let i = 0; i < numPortals; i++) node.inPortals[i] = { portalIndex: r.i16(), polygonId: r.i16() };
    }
    return node;
  }
  const node: BSPNode = { tag, plane: { n: r.vec3(), d: r.f32() } };
  switch (tag) {
    case TAG_BPnn:
    case TAG_BPIn:
      node.pos = parseBSP(r, type);
      break;
    case TAG_BpIN:
    case TAG_BpnN:
      node.neg = parseBSP(r, type);
      break;
    case TAG_BPIN:
    case TAG_BPnN:
      node.pos = parseBSP(r, type);
      node.neg = parseBSP(r, type);
      break;
    default:
      // Other tags (e.g. BPOL, BPFL, BpIn) carry no children; matches ACE's handling.
      break;
  }
  if (type === BSPType.Cell) return node;
  node.sphere = parseSphere(r);
  if (type === BSPType.Physics) return node;
  const n = r.u32();
  node.inPolys = new Array(n);
  for (let i = 0; i < n; i++) node.inPolys[i] = r.u16();
  return node;
}

export interface Stab {
  id: number;
  frame: Frame;
}
export function parseStab(r: BinReader): Stab {
  return { id: r.u32(), frame: r.frame() };
}
