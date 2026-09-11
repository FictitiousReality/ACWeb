import type { BinReader, Vec3 } from "../reader.ts";
import { type AnimationHook, parseHook } from "./animation.ts";

/** 0x32xxxxxx: how an emitter spawns and moves particles. */
export interface ParticleEmitterInfo {
  id: number;
  emitterType: number; // 1 per second, 2 per meter
  particleType: number;
  gfxObjId: number;
  hwGfxObjId: number;
  birthrate: number;
  maxParticles: number;
  initialParticles: number;
  totalParticles: number;
  totalSeconds: number;
  lifespan: number;
  lifespanRand: number;
  offsetDir: Vec3;
  minOffset: number;
  maxOffset: number;
  a: Vec3; minA: number; maxA: number;
  b: Vec3; minB: number; maxB: number;
  c: Vec3; minC: number; maxC: number;
  startScale: number;
  finalScale: number;
  scaleRand: number;
  startTrans: number;
  finalTrans: number;
  transRand: number;
  isParentLocal: number;
}

export function parseParticleEmitterInfo(r: BinReader): ParticleEmitterInfo {
  const id = r.u32();
  r.u32();
  return {
    id, emitterType: r.i32(), particleType: r.i32(), gfxObjId: r.u32(), hwGfxObjId: r.u32(),
    birthrate: r.f64(), maxParticles: r.i32(), initialParticles: r.i32(), totalParticles: r.i32(), totalSeconds: r.f64(),
    lifespan: r.f64(), lifespanRand: r.f64(),
    offsetDir: r.vec3(), minOffset: r.f32(), maxOffset: r.f32(),
    a: r.vec3(), minA: r.f32(), maxA: r.f32(),
    b: r.vec3(), minB: r.f32(), maxB: r.f32(),
    c: r.vec3(), minC: r.f32(), maxC: r.f32(),
    startScale: r.f32(), finalScale: r.f32(), scaleRand: r.f32(),
    startTrans: r.f32(), finalTrans: r.f32(), transRand: r.f32(),
    isParentLocal: r.i32(),
  };
}

/** 0x33xxxxxx: timed list of hooks (create/destroy particle emitters, sounds, ...). */
export interface PhysicsScript {
  id: number;
  data: { startTime: number; hook: AnimationHook }[];
}
export function parsePhysicsScript(r: BinReader): PhysicsScript {
  const id = r.u32();
  const data = r.list((rr) => ({ startTime: rr.f64(), hook: parseHook(rr) }));
  return { id, data };
}

/** 0x34xxxxxx: PlayScript id -> [(mod, physics script id)]. */
export interface PhysicsScriptTable {
  id: number;
  scripts: Map<number, { mod: number; scriptId: number }[]>;
}
export function parsePhysicsScriptTable(r: BinReader): PhysicsScriptTable {
  const id = r.u32();
  const scripts = r.mapU32((rr) => rr.list((q) => ({ mod: q.f32(), scriptId: q.u32() })));
  return { id, scripts };
}

/** Pick the script for a PlayScript and mod like the client does (highest mod <= requested, else first). */
export function selectScript(table: PhysicsScriptTable, playScript: number, mod: number): number {
  const entries = table.scripts.get(playScript);
  if (!entries || !entries.length) return 0;
  const sorted = [...entries].sort((a, b) => b.mod - a.mod);
  for (const e of sorted) if (mod >= e.mod) return e.scriptId;
  return sorted[0].scriptId;
}
