/** Print scenery placement stats for a landblock: deno task scenery A9B4 */
import { DatDatabase, DenoFileSource, hex, parseLandblock, parseRegion, parseScene, parseSetup, parseGfxObj, REGION_ID } from "../dat/mod.ts";
import { buildLandblockGeometry, TexMergeTable, landblockId } from "../world/terrain.ts";
import { buildScenery } from "../world/scenery.ts";

const dir = `${Deno.env.get("HOME")}/Downloads/ac-updates`;
const lbHex = Deno.args[0] ?? "A9B4";
const portal = await DatDatabase.open(await DenoFileSource.open(`${dir}/client_portal.dat`));
const cell = await DatDatabase.open(await DenoFileSource.open(`${dir}/client_cell_1.dat`));
const region = (await portal.get(REGION_ID, parseRegion))!;
const id = landblockId(parseInt(lbHex, 16) >> 8, parseInt(lbHex, 16) & 0xff);
const lb = (await cell.get(id, parseLandblock))!;
const geo = buildLandblockGeometry(lb, region, new TexMergeTable(region));
const scenes = new Map<number, Awaited<ReturnType<typeof parseScene>> | null>();
for (const st of region.scene ?? []) for (const sid of st.scenes) scenes.set(sid, await portal.get(sid, parseScene));
const types = new Map<string, number>();
for (const t of lb.terrain) {
  const k = `${region.terrainTypes[(t >> 2) & 0x1f]?.name}/scene${t >> 11}`;
  types.set(k, (types.get(k) ?? 0) + 1);
}
console.log("terrain vertices by type/sceneType:", [...types.entries()]);
const placements = buildScenery(lb, geo, region, { scene: (sid) => scenes.get(sid) ?? null }, new Set());
console.log("placements:", placements.length);
const byModel = new Map<number, number>();
for (const p of placements) byModel.set(p.objId, (byModel.get(p.objId) ?? 0) + 1);
for (const [m, n] of [...byModel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  let desc = "";
  if (m >>> 24 === 2) { const s = await portal.get(m, parseSetup); desc = `setup parts=${s?.parts.length} h=${s?.height.toFixed(1)} r=${s?.radius.toFixed(1)}`; }
  else { const g = await portal.get(m, parseGfxObj); desc = `gfxobj polys=${g?.polygons.size} verts=${g?.vertexArray.vertices.size}`; }
  console.log(`  ${hex(m)} x${n}  ${desc}`);
}
const zs = placements.map((p) => p.z);
console.log("z range", Math.min(...zs).toFixed(1), Math.max(...zs).toFixed(1), "terrain z range",
  Math.min(...geo.positions.filter((_, i) => i % 3 === 2)).toFixed(1), Math.max(...geo.positions.filter((_, i) => i % 3 === 2)).toFixed(1));
console.log("scale range", Math.min(...placements.map((p) => p.scale)).toFixed(2), Math.max(...placements.map((p) => p.scale)).toFixed(2));
console.log("sample", placements.slice(0, 5).map((p) => `${hex(p.objId)} (${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}) s=${p.scale.toFixed(2)}`));
portal.close(); cell.close();
