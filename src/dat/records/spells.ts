/**
 * 0x0E00000E: the spell table — every spell's name, description, school, icon and
 * the effects played on caster and target. Names and descriptions are stored with
 * each byte's nibbles swapped ("obfuscated" in the client's terms).
 */
import type { BinReader } from "../reader.ts";

export const SPELLTABLE_ID = 0x0e00000e;

export enum SpellType {
  Enchantment = 1,
  Boost = 2,
  Projectile = 3,
  Transfer = 4,
  PortalLink = 5,
  PortalRecall = 6,
  PortalSummon = 7,
  PortalSending = 8,
  Dispel = 9,
  LifeProjectile = 10,
  EnchantmentProjectile = 11,
  FellowEnchantment = 12,
  FellowPortalSending = 13,
  FellowDispel = 14,
  FellowBoost = 15,
}

export enum MagicSchool { None = 0, WarMagic = 1, LifeMagic = 2, ItemEnchantment = 3, CreatureEnchantment = 4, VoidMagic = 5 }

export interface SpellBase {
  id: number;
  name: string;
  description: string;
  school: number;
  iconId: number;
  category: number;
  bitfield: number;
  baseMana: number;
  power: number;
  metaSpellType: number;
  metaSpellId: number;
  /** enchantments only: seconds the effect lasts */
  duration: number;
  /** components by SpellComponentTable id (0 = unused slot) */
  formula: number[];
  /** PlayScript run on the caster (buffs) and on the target (debuffs) */
  casterEffect: number;
  targetEffect: number;
  displayOrder: number;
}

/** name / description strings: 16-bit length, then bytes with swapped nibbles, aligned to 4 */
function obfuscatedString(r: BinReader): string {
  const n = r.u16();
  let s = "";
  for (let i = 0; i < n; i++) {
    const b = r.u8();
    s += String.fromCharCode(((b >> 4) | (b << 4)) & 0xff);
  }
  r.align();
  return s;
}

export function parseSpell(r: BinReader, id: number): SpellBase {
  const name = obfuscatedString(r);
  const description = obfuscatedString(r);
  const school = r.u32();
  const iconId = r.u32();
  const category = r.u32();
  const bitfield = r.u32();
  const baseMana = r.u32();
  r.f32(); // base range constant
  r.f32(); // base range mod
  const power = r.u32();
  r.f32(); // spell economy mod
  r.u32(); // formula version
  r.f32(); // component loss
  const metaSpellType = r.u32();
  const metaSpellId = r.u32();
  let duration = 0;
  if (metaSpellType === SpellType.Enchantment || metaSpellType === SpellType.FellowEnchantment) {
    duration = r.f64();
    r.f32(); // degrade modifier
    r.f32(); // degrade limit
  } else if (metaSpellType === SpellType.PortalSummon) {
    duration = r.f64(); // portal lifetime
  }
  const formula: number[] = [];
  for (let i = 0; i < 8; i++) formula.push(r.u32());
  const casterEffect = r.u32();
  const targetEffect = r.u32();
  r.u32(); // fizzle effect (always 0)
  r.f64(); // recovery interval
  r.f32(); // recovery amount
  const displayOrder = r.u32();
  r.u32(); // non-component target type
  r.u32(); // mana mod
  return { id, name, description, school, iconId, category, bitfield, baseMana, power, metaSpellType, metaSpellId, duration, formula, casterEffect, targetEffect, displayOrder };
}

/** 0x0E00000E: spells keyed by spell id (the spell-set table that follows is not read). */
export function parseSpellTable(r: BinReader): Map<number, SpellBase> {
  r.u32(); // id
  const count = r.u16();
  r.u16(); // buckets
  const out = new Map<number, SpellBase>();
  for (let i = 0; i < count; i++) {
    const id = r.u32();
    out.set(id, parseSpell(r, id));
  }
  return out;
}
