import type { BinReader, Frame, Vec3 } from "../reader.ts";
import { type AnimationFrame, parseAnimationFrame } from "./animation.ts";
import { type CylSphere, parseSphere, type Sphere } from "./common.ts";

export enum SetupFlags {
  HasParent = 0x1,
  HasDefaultScale = 0x2,
  AllowFreeHeading = 0x4,
  HasPhysicsBSP = 0x8,
}

export interface LocationType {
  partId: number;
  frame: Frame;
}
export interface LightInfo {
  frame: Frame;
  color: number;
  intensity: number;
  falloff: number;
  coneAngle: number;
}

/** 0x02xxxxxx: a multi-part model assembled from GfxObj parts. */
export interface Setup {
  id: number;
  flags: number;
  parts: number[];
  parentIndex: number[];
  defaultScale: Vec3[];
  holdingLocations: Map<number, LocationType>;
  connectionPoints: Map<number, LocationType>;
  placementFrames: Map<number, AnimationFrame>;
  cylSpheres: CylSphere[];
  spheres: Sphere[];
  height: number;
  radius: number;
  stepUpHeight: number;
  stepDownHeight: number;
  sortingSphere: Sphere;
  selectionSphere: Sphere;
  lights: Map<number, LightInfo>;
  defaultAnimation: number;
  defaultScript: number;
  defaultMotionTable: number;
  defaultSoundTable: number;
  defaultScriptTable: number;
}

const parseLocation = (r: BinReader): LocationType => ({ partId: r.i32(), frame: r.frame() });

export function parseSetup(r: BinReader): Setup {
  const id = r.u32();
  const flags = r.u32();
  const numParts = r.u32();
  const parts = r.fixedList(numParts, (rr) => rr.u32());
  const parentIndex = flags & SetupFlags.HasParent ? r.fixedList(numParts, (rr) => rr.u32()) : [];
  const defaultScale = flags & SetupFlags.HasDefaultScale ? r.fixedList(numParts, (rr) => rr.vec3()) : [];
  const holdingLocations = r.mapI32(parseLocation);
  const connectionPoints = r.mapI32(parseLocation);
  const numPlacements = r.i32();
  const placementFrames = new Map<number, AnimationFrame>();
  for (let i = 0; i < numPlacements; i++) {
    const key = r.i32();
    placementFrames.set(key, parseAnimationFrame(r, numParts));
  }
  const cylSpheres = r.list((rr): CylSphere => ({ origin: rr.vec3(), radius: rr.f32(), height: rr.f32() }));
  const spheres = r.list(parseSphere);
  const height = r.f32();
  const radius = r.f32();
  const stepUpHeight = r.f32();
  const stepDownHeight = r.f32();
  const sortingSphere = parseSphere(r);
  const selectionSphere = parseSphere(r);
  const lights = r.mapI32((rr): LightInfo => ({
    frame: rr.frame(),
    color: rr.u32(),
    intensity: rr.f32(),
    falloff: rr.f32(),
    coneAngle: rr.f32(),
  }));
  const defaultAnimation = r.u32();
  const defaultScript = r.u32();
  const defaultMotionTable = r.u32();
  const defaultSoundTable = r.u32();
  const defaultScriptTable = r.u32();
  return {
    id, flags, parts, parentIndex, defaultScale, holdingLocations, connectionPoints, placementFrames,
    cylSpheres, spheres, height, radius, stepUpHeight, stepDownHeight, sortingSphere, selectionSphere,
    lights, defaultAnimation, defaultScript, defaultMotionTable, defaultSoundTable, defaultScriptTable,
  };
}
