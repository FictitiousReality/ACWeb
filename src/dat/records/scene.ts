import type { BinReader, Frame } from "../reader.ts";

export interface ObjectDesc {
  objId: number;
  baseLoc: Frame;
  freq: number;
  displaceX: number;
  displaceY: number;
  minScale: number;
  maxScale: number;
  maxRotation: number;
  minSlope: number;
  maxSlope: number;
  align: number;
  orient: number;
  weenieObj: number;
}

/** 0x12xxxxxx: a set of scenery object descriptions placed procedurally per terrain vertex. */
export interface Scene {
  id: number;
  objects: ObjectDesc[];
}

export function parseScene(r: BinReader): Scene {
  const id = r.u32();
  const objects = r.list((rr): ObjectDesc => ({
    objId: rr.u32(),
    baseLoc: rr.frame(),
    freq: rr.f32(),
    displaceX: rr.f32(),
    displaceY: rr.f32(),
    minScale: rr.f32(),
    maxScale: rr.f32(),
    maxRotation: rr.f32(),
    minSlope: rr.f32(),
    maxSlope: rr.f32(),
    align: rr.u32(),
    orient: rr.u32(),
    weenieObj: rr.u32(),
  }));
  return { id, objects };
}
