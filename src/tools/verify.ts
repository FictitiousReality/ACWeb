/**
 * Parse every record of the supported types in the real dat files and check
 * that each parser consumes exactly the file's bytes. Any mismatch means the
 * port of that format is wrong.
 *
 *   deno task verify [datDir]
 */
import {
  BinReader, DatDatabase, DenoFileSource, hex, parseAnimation, parseEnvCell, parseEnvironment, parseGfxObj,
  parseLandblock, parseLandblockInfo, parsePalette, parseRegion, parseSetup, parseSurface, parseSurfaceTexture,
  parseTexture, parseScene, PortalKind, REGION_ID,
} from "../dat/mod.ts";

const dir = Deno.args[0] ?? `${Deno.env.get("HOME")}/Downloads/ac-updates`;

async function check(
  db: DatDatabase, label: string, ids: number[], parse: (r: BinReader, id: number) => unknown, limit = Infinity,
) {
  let ok = 0, bad = 0, err = 0, short = 0;
  const firstBad: string[] = [];
  const t0 = performance.now();
  for (const id of ids.slice(0, limit)) {
    const buf = (await db.readFile(id))!;
    const r = new BinReader(buf);
    try {
      parse(r, id);
      if (r.pos === buf.length) ok++;
      else {
        // Files are stored padded to dword; allow up to 3 trailing bytes.
        if (r.pos < buf.length && buf.length - r.pos < 4) short++;
        else {
          bad++;
          if (firstBad.length < 3) firstBad.push(`${hex(id)} consumed ${r.pos}/${buf.length}`);
        }
      }
    } catch (e) {
      err++;
      if (firstBad.length < 3) firstBad.push(`${hex(id)} threw at ${r.pos}/${buf.length}: ${(e as Error).message}`);
    }
  }
  const ms = (performance.now() - t0).toFixed(0);
  const status = bad + err === 0 ? "OK " : "BAD";
  console.log(`${status} ${label.padEnd(16)} exact=${ok} trailing<4=${short} mismatch=${bad} error=${err}  (${ms} ms)`);
  for (const s of firstBad) console.log(`      ${s}`);
}

const portal = await DatDatabase.open(await DenoFileSource.open(`${dir}/client_portal.dat`));
console.log(`portal: ${portal.files.size} files, iteration ${await portal.iteration()}`);
const cell = await DatDatabase.open(await DenoFileSource.open(`${dir}/client_cell_1.dat`));
console.log(`cell:   ${cell.files.size} files, iteration ${await cell.iteration()}`);

const byKind = (k: PortalKind) => [...portal.files.keys()].filter((id) => id >>> 24 === k);

await check(portal, "Region", [REGION_ID], parseRegion);
await check(portal, "Palette", byKind(PortalKind.Palette), parsePalette);
await check(portal, "Surface", byKind(PortalKind.Surface), parseSurface);
await check(portal, "SurfaceTexture", byKind(PortalKind.SurfaceTexture), parseSurfaceTexture);
await check(portal, "Texture", byKind(PortalKind.Texture), parseTexture);
await check(portal, "GfxObj", byKind(PortalKind.GfxObj), parseGfxObj);
await check(portal, "Setup", byKind(PortalKind.Setup), parseSetup);
await check(portal, "Animation", byKind(PortalKind.Animation), parseAnimation);
await check(portal, "Environment", byKind(PortalKind.Environment), parseEnvironment);
await check(portal, "Scene", byKind(PortalKind.Scene), parseScene);

const cellIds = [...cell.files.keys()];
await check(cell, "Landblock", cellIds.filter((id) => (id & 0xffff) === 0xffff), parseLandblock);
await check(cell, "LandblockInfo", cellIds.filter((id) => (id & 0xffff) === 0xfffe), parseLandblockInfo);
await check(cell, "EnvCell", cellIds.filter((id) => (id & 0xffff) < 0xfffe && (id & 0xffff) >= 0x100), parseEnvCell);

portal.close();
cell.close();
