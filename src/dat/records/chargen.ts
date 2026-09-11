import type { BinReader, Frame } from "../reader.ts";

export const CHARGEN_ID = 0x0e000002;
export const SKILLTABLE_ID = 0x0e000004;

export interface DatObjDesc {
  paletteId: number;
  subPalettes: { id: number; offset: number; numColors: number }[];
  textureChanges: { part: number; oldTexture: number; newTexture: number }[];
  animPartChanges: { index: number; partId: number }[];
}
export function parseDatObjDesc(r: BinReader): DatObjDesc {
  r.align();
  r.u8(); // 0x11
  const nPal = r.u8(), nTex = r.u8(), nAnim = r.u8();
  const d: DatObjDesc = { paletteId: 0, subPalettes: [], textureChanges: [], animPartChanges: [] };
  if (nPal > 0) d.paletteId = r.dataIdOfKnownType(0x04000000);
  for (let i = 0; i < nPal; i++) {
    const id = r.dataIdOfKnownType(0x04000000);
    const offset = r.u8() * 8;
    let numColors = r.u8();
    if (numColors === 0) numColors = 256;
    d.subPalettes.push({ id, offset, numColors: numColors * 8 });
  }
  for (let i = 0; i < nTex; i++) d.textureChanges.push({ part: r.u8(), oldTexture: r.dataIdOfKnownType(0x05000000), newTexture: r.dataIdOfKnownType(0x05000000) });
  for (let i = 0; i < nAnim; i++) d.animPartChanges.push({ index: r.u8(), partId: r.dataIdOfKnownType(0x01000000) });
  r.align();
  return d;
}

export interface TemplateCG {
  name: string;
  iconImage: number;
  title: number;
  strength: number;
  endurance: number;
  coordination: number;
  quickness: number;
  focus: number;
  self: number;
  normalSkills: number[];
  primarySkills: number[];
}
export interface SexCG {
  name: string;
  scale: number;
  setupId: number;
  soundTable: number;
  iconImage: number;
  basePalette: number;
  skinPalSet: number;
  physicsTable: number;
  motionTable: number;
  combatTable: number;
  baseObjDesc: DatObjDesc;
  hairColors: number[];
  hairStyles: { iconImage: number; bald: boolean; alternateSetup: number; objDesc: DatObjDesc }[];
  eyeColors: number[];
  eyeStrips: { iconImage: number; iconImageBald: number; objDesc: DatObjDesc; objDescBald: DatObjDesc }[];
  noseStrips: { iconImage: number; objDesc: DatObjDesc }[];
  mouthStrips: { iconImage: number; objDesc: DatObjDesc }[];
  headgear: { name: string; clothingTable: number; weenieDefault: number }[];
  shirts: { name: string; clothingTable: number; weenieDefault: number }[];
  pants: { name: string; clothingTable: number; weenieDefault: number }[];
  footwear: { name: string; clothingTable: number; weenieDefault: number }[];
  clothingColors: number[];
}
export interface HeritageGroupCG {
  name: string;
  iconImage: number;
  setupId: number;
  environmentSetupId: number;
  attributeCredits: number;
  skillCredits: number;
  primaryStartAreas: number[];
  secondaryStartAreas: number[];
  skills: { skill: number; normalCost: number; primaryCost: number }[];
  templates: TemplateCG[];
  genders: Map<number, SexCG>;
}
export interface CharGen {
  starterAreas: { name: string; locations: { cell: number; frame: Frame }[] }[];
  heritageGroups: Map<number, HeritageGroupCG>;
}

const gear = (r: BinReader) => ({ name: r.csString(), clothingTable: r.u32(), weenieDefault: r.u32() });
const faceStrip = (r: BinReader) => ({ iconImage: r.u32(), objDesc: parseDatObjDesc(r) });
function smartList<T>(r: BinReader, f: (r: BinReader) => T): T[] {
  const n = r.compressedU32();
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(f(r));
  return out;
}

function parseSex(r: BinReader): SexCG {
  return {
    name: r.csString(), scale: r.u32(), setupId: r.u32(), soundTable: r.u32(), iconImage: r.u32(), basePalette: r.u32(),
    skinPalSet: r.u32(), physicsTable: r.u32(), motionTable: r.u32(), combatTable: r.u32(),
    baseObjDesc: parseDatObjDesc(r),
    hairColors: smartList(r, (rr) => rr.u32()),
    hairStyles: smartList(r, (rr) => ({ iconImage: rr.u32(), bald: rr.u8() === 1, alternateSetup: rr.u32(), objDesc: parseDatObjDesc(rr) })),
    eyeColors: smartList(r, (rr) => rr.u32()),
    eyeStrips: smartList(r, (rr) => ({ iconImage: rr.u32(), iconImageBald: rr.u32(), objDesc: parseDatObjDesc(rr), objDescBald: parseDatObjDesc(rr) })),
    noseStrips: smartList(r, faceStrip),
    mouthStrips: smartList(r, faceStrip),
    headgear: smartList(r, gear), shirts: smartList(r, gear), pants: smartList(r, gear), footwear: smartList(r, gear),
    clothingColors: smartList(r, (rr) => rr.u32()),
  };
}

function parseHeritage(r: BinReader): HeritageGroupCG {
  const h: HeritageGroupCG = {
    name: r.csString(), iconImage: r.u32(), setupId: r.u32(), environmentSetupId: r.u32(),
    attributeCredits: r.u32(), skillCredits: r.u32(),
    primaryStartAreas: smartList(r, (rr) => rr.i32()),
    secondaryStartAreas: smartList(r, (rr) => rr.i32()),
    skills: smartList(r, (rr) => ({ skill: rr.u32(), normalCost: rr.i32(), primaryCost: rr.i32() })),
    templates: smartList(r, (rr): TemplateCG => ({
      name: rr.csString(), iconImage: rr.u32(), title: rr.u32(),
      strength: rr.u32(), endurance: rr.u32(), coordination: rr.u32(), quickness: rr.u32(), focus: rr.u32(), self: rr.u32(),
      normalSkills: smartList(rr, (q) => q.u32()), primarySkills: smartList(rr, (q) => q.u32()),
    })),
    genders: new Map(),
  };
  r.u8(); // 0x01
  const n = r.compressedU32();
  for (let i = 0; i < n; i++) {
    const key = r.u32();
    h.genders.set(key, parseSex(r));
  }
  return h;
}

/** 0x0E000002: character generation data (starter areas, heritages, templates, appearance options). */
export function parseCharGen(r: BinReader): CharGen {
  r.u32(); // id
  r.u32();
  const starterAreas = smartList(r, (rr) => ({
    name: rr.csString(),
    locations: smartList(rr, (q) => ({ cell: q.u32(), frame: q.frame() })),
  }));
  r.u8(); // 0x01
  const n = r.compressedU32();
  const heritageGroups = new Map<number, HeritageGroupCG>();
  for (let i = 0; i < n; i++) {
    const key = r.u32();
    heritageGroups.set(key, parseHeritage(r));
  }
  return { starterAreas, heritageGroups };
}

export interface SkillBase {
  description: string;
  name: string;
  iconId: number;
  trainedCost: number;
  specializedCost: number;
  category: number;
  chargenUse: number;
  minLevel: number;
}
/** 0x0E000004: skill table keyed by skill id. */
export function parseSkillTable(r: BinReader): Map<number, SkillBase> {
  r.u32();
  return r.packedHashTable((rr): SkillBase => {
    const description = rr.pstring(); rr.align();
    const name = rr.pstring(); rr.align();
    const s: SkillBase = {
      description, name, iconId: rr.u32(), trainedCost: rr.i32(), specializedCost: rr.i32(), category: rr.u32(), chargenUse: rr.u32(), minLevel: rr.u32(),
    };
    rr.skip(6 * 4); // formula
    rr.skip(3 * 8); // bounds, learn mod
    return s;
  });
}
