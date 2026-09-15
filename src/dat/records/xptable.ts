/**
 * 0x0E000018: the experience tables — cumulative experience needed for each rank of an
 * attribute, vital, trained skill and specialized skill, plus the experience and skill
 * credits for each character level.
 */
import type { BinReader } from "../reader.ts";

export const XPTABLE_ID = 0x0e000018;

export interface XpTable {
  /** cumulative xp to reach each rank, indexed by rank */
  attribute: number[];
  vital: number[];
  trainedSkill: number[];
  specializedSkill: number[];
  /** total xp needed for each character level */
  level: number[];
  /** skill credits granted at each level */
  levelCredits: number[];
}

export function parseXpTable(r: BinReader): XpTable {
  r.u32(); // id
  const counts = [r.i32(), r.i32(), r.i32(), r.i32()];
  const levelCount = r.u32();
  const list = (n: number) => { const out: number[] = []; for (let i = 0; i <= n; i++) out.push(r.u32()); return out; };
  const attribute = list(counts[0]);
  const vital = list(counts[1]);
  const trainedSkill = list(counts[2]);
  const specializedSkill = list(counts[3]);
  const level: number[] = [];
  for (let i = 0; i <= levelCount; i++) { const lo = r.u32(), hi = r.u32(); level.push(hi * 2 ** 32 + lo); }
  const levelCredits = list(levelCount);
  return { attribute, vital, trainedSkill, specializedSkill, level, levelCredits };
}

/**
 * The rank reached for a total amount of experience put into a trait: the highest entry
 * whose cumulative cost has been paid. This is what the server does (CalcAttributeRank and
 * friends), so costs stay right even if the reported rank and experience disagree.
 */
export function rankForXp(table: number[], xpSpent: number): number {
  let lo = 0, hi = table.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (table[mid] <= xpSpent) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Experience needed to add one more rank, or null once the trait is at the top of its table. */
export function costOfNextRank(table: number[], xpSpent: number): number | null {
  const rank = rankForXp(table, xpSpent);
  if (rank + 1 >= table.length) return null;
  return table[rank + 1] - xpSpent;
}
