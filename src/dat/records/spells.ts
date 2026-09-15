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
  /** component ids in the SpellComponentTable (decrypted; scarab first, then herbs, powders, potions, talisman, tapers) */
  formula: number[];
  /** PlayScript run on the caster (buffs) and on the target (debuffs) */
  casterEffect: number;
  targetEffect: number;
  displayOrder: number;
}

/**
 * The client's string hash (ACE SpellTable.ComputeHash): each Windows-1252 byte, taken as a
 * signed byte, is added to the running value shifted left four bits, folding the top nibble
 * back in whenever it is set. Our strings hold one byte per character already.
 */
export function acHash(text: string): number {
  let result = 0n;
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i) & 0xff;
    if (c > 127) c -= 256;
    result = BigInt.asIntN(64, BigInt(c) + (result << 4n));
    if ((result & 0xf0000000n) !== 0n) result = (result ^ ((result & 0xf0000000n) >> 24n)) & 0x0fffffffn;
  }
  return Number(BigInt.asUintN(32, result));
}

const HIGHEST_COMP_ID = 198;
/** Component ids from a stored formula: subtract a key derived from the spell's name and description. */
export function decryptFormula(raw: number[], name: string, description: string): number[] {
  const key = ((acHash(name) % 0x12107680) + (acHash(description) % 0xbeadcf45)) >>> 0;
  return raw.map((c) => {
    let v = (c - key) >>> 0;
    if (v > HIGHEST_COMP_ID) v &= 0xff;
    return v;
  });
}

/** name / description strings: 16-bit length, then bytes with swapped nibbles, aligned to 4 */
export function obfuscatedString(r: BinReader): string {
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
  // components are stored encrypted with a key made from the name and description (ACE DecryptFormula)
  const raw: number[] = [];
  for (let i = 0; i < 8; i++) { const c = r.u32(); if (c > 0) raw.push(c); }
  const formula = decryptFormula(raw, name, description);
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
