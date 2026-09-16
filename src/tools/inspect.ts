/**
 * What is inside the dat files: how many records of each kind there are, how much space
 * each kind takes, and the header of any single file by id.
 *
 *   deno task inspect [datDir]
 *   deno task inspect 0x06004CC2        one file: which dat holds it, its kind, and its first bytes
 */
import { DatDatabase, DenoFileSource, hex, PortalKind } from "../dat/mod.ts";

const args = [...Deno.args];
// an argument that looks like a file id rather than a directory
const idArg = args.find((a) => !a.includes("/") && /^(0x)?[0-9a-fA-F]{2,8}$/.test(a));
const dir = args.find((a) => a !== idArg) ?? `${Deno.env.get("HOME")}/Downloads/ac-updates`;
const fileId = idArg ? Number(idArg.startsWith("0x") ? idArg : `0x${idArg}`) : null;

const kindNames = new Map<number, string>(
  Object.entries(PortalKind).filter(([, v]) => typeof v === "number").map(([k, v]) => [v as number, k]),
);
/** ranges the PortalKind enum does not name: 0x0E holds the game's singleton tables
 *  (SpellTable, SpellComponents, XpTable, CharGen, SkillTable) */
const extraKinds = new Map<number, string>([[0x0e, "Tables (0x0E)"]]);
/** portal and language files are typed by the top byte of the id */
const byTopByte = (id: number) =>
  kindNames.get(id >>> 24) ?? extraKinds.get(id >>> 24) ?? `unknown ${hex(id >>> 24, 2)}......`;
/** cell files have no type byte: the low 16 bits say what they are */
function cellKind(id: number): string {
  const low = id & 0xffff;
  if (low === 0xffff) return "Landblock";
  if (low === 0xfffe) return "LandblockInfo";
  if (low >= 0x100) return "EnvCell";
  return `other (${hex(low, 4)})`;
}

const size = (b: number) => (b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`);

async function open(name: string): Promise<DatDatabase | null> {
  try {
    return await DatDatabase.open(await DenoFileSource.open(`${dir}/${name}`));
  } catch {
    return null; // not every install has every dat (highres and language are optional)
  }
}

async function summarize(label: string, db: DatDatabase, kindOf: (id: number) => string) {
  const kinds = new Map<string, { n: number; bytes: number }>();
  let total = 0;
  for (const e of db.files.values()) {
    const k = kindOf(e.id);
    const acc = kinds.get(k) ?? { n: 0, bytes: 0 };
    acc.n++;
    acc.bytes += e.size;
    total += e.size;
    kinds.set(k, acc);
  }
  console.log(`\n${label}: ${db.files.size.toLocaleString()} files, ${size(total)}, iteration ${await db.iteration()}`);
  for (const [k, v] of [...kinds].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${k.padEnd(20)} ${v.n.toLocaleString().padStart(8)}  ${size(v.bytes).padStart(9)}`);
  }
}

/** The first bytes of a record, as hex and printable characters. */
function dump(b: Uint8Array): string {
  const rows: string[] = [];
  for (let i = 0; i < b.length; i += 16) {
    const chunk = b.subarray(i, i + 16);
    const h = [...chunk].map((v) => v.toString(16).padStart(2, "0")).join(" ");
    const a = [...chunk].map((v) => (v >= 32 && v < 127 ? String.fromCharCode(v) : ".")).join("");
    rows.push(`  ${i.toString(16).padStart(4, "0")}  ${h.padEnd(47)}  ${a}`);
  }
  return rows.join("\n");
}

const dats: [string, DatDatabase, (id: number) => string][] = [];
for (const [name, file, kindOf] of [
  ["portal", "client_portal.dat", byTopByte],
  ["cell", "client_cell_1.dat", cellKind],
  ["language", "client_local_English.dat", byTopByte],
  ["highres", "client_highres.dat", byTopByte],
] as [string, string, (id: number) => string][]) {
  const db = await open(file);
  if (db) dats.push([name, db, kindOf]);
}
if (!dats.length) {
  console.error(`no dat files found in ${dir} (pass the folder as an argument)`);
  Deno.exit(1);
}

if (fileId !== null) {
  let found = false;
  for (const [label, db, kindOf] of dats) {
    const e = db.files.get(fileId);
    if (!e) continue;
    found = true;
    const buf = await db.readFile(fileId);
    console.log(
      `${hex(fileId)} in the ${label} dat: ${kindOf(fileId)}, ${e.size} bytes, ` +
        `iteration ${e.iteration}, at offset ${hex(e.offset)}`,
    );
    if (buf) console.log(dump(buf.subarray(0, 64)));
  }
  if (!found) console.log(`${hex(fileId)} is not in any of the dats in ${dir}`);
} else {
  for (const [label, db, kindOf] of dats) await summarize(label, db, kindOf);
  console.log(`\nfrom ${dir}; pass a file id (e.g. 0x06004CC2) to look at one record`);
}

for (const [, db] of dats) db.close();
