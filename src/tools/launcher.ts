/// <reference lib="deno.unstable" />
/**
 * One-file launcher: serves the client pages and the dat files, runs the UDP relay, and
 * opens the browser. This is what `deno task compile` turns into a standalone executable.
 *
 *   acweb [path/to/dat/folder] [--port 8000] [--relay 8001] [--no-open]
 *
 * The dat folder must hold client_portal.dat and client_cell_1.dat (client_local_English.dat
 * is optional). It is looked for, in order: the argument, $ACWEB_DATS, a `dats` folder next to
 * the executable, the current folder, and ~/Downloads/ac-updates.
 */
import { dirname, fromFileUrl, join } from "@std/path";
import { startWebServer } from "./serve.ts";
import { startRelay } from "./proxy.ts";

const args = [...Deno.args];
const flag = (name: string, def: string) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1] ?? def; args.splice(i, 2); return v; };
const noOpen = args.includes("--no-open"); if (noOpen) args.splice(args.indexOf("--no-open"), 1);
const port = Number(flag("--port", "8000"));
const relayPort = Number(flag("--relay", "8001"));

async function hasDats(dir: string | undefined): Promise<boolean> {
  if (!dir) return false;
  try {
    await Deno.stat(join(dir, "client_portal.dat"));
    await Deno.stat(join(dir, "client_cell_1.dat"));
    return true;
  } catch { return false; }
}

const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
const candidates = [args[0], Deno.env.get("ACWEB_DATS"), join(dirname(Deno.execPath()), "dats"), Deno.cwd(), join(home, "Downloads", "ac-updates")];
let datDir: string | undefined;
for (const c of candidates) if (await hasDats(c)) { datDir = c; break; }
if (!datDir) {
  console.error(`acweb: could not find the Asheron's Call dat files (client_portal.dat and client_cell_1.dat).
Put them in a folder and start with:  acweb /path/to/that/folder
or set ACWEB_DATS, or place a "dats" folder next to this program.
Looked in: ${candidates.filter(Boolean).join(", ")}`);
  Deno.exit(1);
}

const webRoot = fromFileUrl(new URL("../../web/", import.meta.url));
startWebServer({ datDir, port, webRoot, quiet: true });
startRelay(relayPort, true);
const url = `http://127.0.0.1:${port}/play.html`;
console.log(`acweb: dats from ${datDir}`);
console.log(`acweb: client at ${url}  (relay on port ${relayPort}). Keep this window open while you play; Ctrl+C quits.`);

if (!noOpen) {
  const cmd = Deno.build.os === "windows" ? ["cmd", "/c", "start", "", url] : Deno.build.os === "darwin" ? ["open", url] : ["xdg-open", url];
  try { await new Deno.Command(cmd[0], { args: cmd.slice(1), stdout: "null", stderr: "null" }).output(); }
  catch { console.log("acweb: open that address in your browser."); }
}
