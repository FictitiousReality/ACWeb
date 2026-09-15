/**
 * 0x0E00000F: spell components (scarabs, herbs, powders, potions, talismans, tapers).
 * Each carries the gesture the caster makes with it: scarabs give the windup gestures,
 * the talisman gives the cast gesture (ACE SpellFormula.WindupGestures / CastGesture).
 */
import type { BinReader } from "../reader.ts";
import { obfuscatedString, type SpellBase } from "./spells.ts";

export const SPELLCOMPONENTS_ID = 0x0e00000f;

export enum ComponentType { Scarab = 1, Herb = 2, Powder = 3, Potion = 4, Talisman = 5, Taper = 6, PotionPea = 7 }

export interface SpellComponent {
  id: number;
  name: string;
  category: number;
  icon: number;
  type: number;
  /** MotionCommand made with this component (0 = none) */
  gesture: number;
  time: number;
  /** the spoken word */
  text: string;
  cdm: number;
}

export function parseSpellComponentTable(r: BinReader): Map<number, SpellComponent> {
  r.u32(); // id
  const n = r.u16();
  r.align();
  const out = new Map<number, SpellComponent>();
  for (let i = 0; i < n; i++) {
    const id = r.u32();
    const name = obfuscatedString(r);
    const category = r.u32(), icon = r.u32(), type = r.u32(), gesture = r.u32(), time = r.f32();
    const text = obfuscatedString(r);
    const cdm = r.f32();
    out.set(id, { id, name, category, icon, type, gesture, time, text, cdm });
  }
  return out;
}

/** The gestures a cast plays: one windup gesture per scarab (none for fast-cast spells), then the talisman's. */
export function castGestures(spell: SpellBase, comps: Map<number, SpellComponent>): { windup: number[]; cast: number } {
  const windup: number[] = [];
  let cast = 0;
  for (const id of spell.formula) {
    const c = id ? comps.get(id) : undefined;
    // 0x80000000 is "no gesture": the Lead scarab of level-one spells has no windup
    if (!c || !c.gesture || c.gesture === 0x80000000) continue;
    if (c.type === ComponentType.Scarab) windup.push(c.gesture);
    else if (c.type === ComponentType.Talisman) cast = c.gesture;
  }
  if (spell.bitfield & 0x4000) windup.length = 0; // SpellFlags.FastCast
  return { windup, cast };
}
