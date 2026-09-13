/**
 * Dev server: static files from web/ plus /dat/<file> served from the dat
 * directory with HTTP Range support so the browser can read the .dat files
 * without copying them. Dat files are opened once and ranges are read from
 * the shared handle, so thousands of small requests don't exhaust file
 * descriptors.
 *
 *   deno task serve [datDir] [port]
 */
import { serveDir } from "@std/http/file-server";
import { fromFileUrl, join } from "@std/path";

let datDir = Deno.args[0] ?? `${Deno.env.get("HOME")}/Downloads/ac-updates`;
let webRoot = fromFileUrl(new URL("../../web/", import.meta.url));
const allowed = new Set(["client_portal.dat", "client_cell_1.dat", "client_highres.dat", "client_local_English.dat"]);

const handles = new Map<string, { file: Deno.FsFile; size: number }>();
async function datHandle(name: string) {
  let h = handles.get(name);
  if (!h) {
    const file = await Deno.open(join(datDir, name), { read: true });
    const size = (await file.stat()).size;
    h = { file, size };
    handles.set(name, h);
  }
  return h;
}

// Serialize reads on a shared handle (seek+read is not atomic).
let readChain: Promise<unknown> = Promise.resolve();
function readRange(h: { file: Deno.FsFile; size: number }, start: number, end: number): Promise<Uint8Array> {
  const p = readChain.then(async () => {
    const out = new Uint8Array(end - start + 1);
    await h.file.seek(start, Deno.SeekMode.Start);
    let done = 0;
    while (done < out.length) {
      const n = await h.file.read(out.subarray(done));
      if (n === null) break;
      done += n;
    }
    return out.subarray(0, done);
  });
  readChain = p.catch(() => {});
  return p;
}

async function serveDat(req: Request, name: string): Promise<Response> {
  if (!allowed.has(name)) return new Response("not found", { status: 404 });
  let h;
  try {
    h = await datHandle(name);
  } catch {
    return new Response("not found", { status: 404 });
  }
  const headers = new Headers({ "accept-ranges": "bytes", "content-type": "application/octet-stream", "cache-control": "no-store" });
  if (req.method === "HEAD") {
    headers.set("content-length", String(h.size));
    return new Response(null, { status: 200, headers });
  }
  const range = req.headers.get("range");
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m) return new Response("range required", { status: 416, headers });
  let start = m[1] ? Number(m[1]) : 0;
  let end = m[2] ? Number(m[2]) : h.size - 1;
  if (!m[1] && m[2]) { start = Math.max(0, h.size - Number(m[2])); end = h.size - 1; }
  if (start > end || start >= h.size) return new Response("bad range", { status: 416, headers });
  end = Math.min(end, h.size - 1);
  const body = await readRange(h, start, end);
  headers.set("content-length", String(body.length));
  headers.set("content-range", `bytes ${start}-${end}/${h.size}`);
  return new Response(new Uint8Array(body).buffer as ArrayBuffer, { status: 206, headers });
}

/** Start the web + dat server. Returns the server so a launcher can wait on it. */
export function startWebServer(opts: { datDir: string; port: number; webRoot?: string; quiet?: boolean }) {
  datDir = opts.datDir;
  if (opts.webRoot) webRoot = opts.webRoot;
  return Deno.serve({ port: opts.port, hostname: "127.0.0.1", onListen: opts.quiet ? () => {} : undefined }, handler);
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/dat/")) return serveDat(req, url.pathname.slice(5));
  if (url.pathname === "/captures.log") {
    try { return new Response(await Deno.readTextFile("captures.log"), { headers: { "content-type": "text/plain", "access-control-allow-origin": "*" } }); }
    catch { return new Response("", { status: 404 }); }
  }
  if (url.pathname === "/capture" && req.method === "POST") {
    // debug aid: the client posts raw game messages (hex) here; decode with src/tools/decodecap.ts
    const text = await req.text();
    await Deno.writeTextFile("captures.log", text.endsWith("\n") ? text : text + "\n", { append: true });
    return new Response("ok", { headers: { "access-control-allow-origin": "*" } });
  }
  return serveDir(req, { fsRoot: webRoot, quiet: true, enableCors: true });
}

if (import.meta.main) startWebServer({ datDir, port: Number(Deno.args[1] ?? 8000) });
