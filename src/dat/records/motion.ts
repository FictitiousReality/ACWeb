import type { BinReader, Vec3 } from "../reader.ts";

export interface AnimData {
  animId: number;
  lowFrame: number;
  highFrame: number;
  /** frames per second; negative plays in reverse */
  framerate: number;
}

export interface MotionData {
  bitfield: number;
  flags: number;
  anims: AnimData[];
  velocity?: Vec3;
  omega?: Vec3;
}

function parseMotionData(r: BinReader): MotionData {
  const numAnims = r.u8();
  const bitfield = r.u8();
  const flags = r.u8();
  r.align();
  const anims = r.fixedList(numAnims, (rr): AnimData => ({
    animId: rr.u32(), lowFrame: rr.i32(), highFrame: rr.i32(), framerate: rr.f32(),
  }));
  const md: MotionData = { bitfield, flags, anims };
  if (flags & 1) md.velocity = r.vec3();
  if (flags & 2) md.omega = r.vec3();
  return md;
}

/**
 * 0x09xxxxxx: maps (stance, motion command) to animation sequences.
 * Keys are (stance << 16 | command & 0xFFFFF); links are keyed by the current
 * motion and then by the target command.
 */
export interface MotionTable {
  id: number;
  defaultStyle: number;
  styleDefaults: Map<number, number>;
  cycles: Map<number, MotionData>;
  modifiers: Map<number, MotionData>;
  links: Map<number, Map<number, MotionData>>;
}

export function parseMotionTable(r: BinReader): MotionTable {
  const id = r.u32();
  const defaultStyle = r.u32();
  const n = r.u32();
  const styleDefaults = new Map<number, number>();
  for (let i = 0; i < n; i++) styleDefaults.set(r.u32(), r.u32());
  const cycles = r.mapU32(parseMotionData);
  const modifiers = r.mapU32(parseMotionData);
  const links = r.mapU32((rr) => rr.mapU32(parseMotionData));
  return { id, defaultStyle, styleDefaults, cycles, modifiers, links };
}
