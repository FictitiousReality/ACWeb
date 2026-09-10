/**
 * Dev server: static files from web/ plus /dat/<file> served from the dat
 * directory with HTTP Range support so the browser can read the .dat files
 * without copying them.
 *
 *   deno task serve [datDir] [port]
 */
import { serveDir, serveFile } from "@std/http/file-server";
import { fromFileUrl, join } from "@std/path";

const datDir = Deno.args[0] ?? `${Deno.env.get("HOME")}/Downloads/ac-updates`;
const port = Number(Deno.args[1] ?? 8000);
const webRoot = fromFileUrl(new URL("../../web/", import.meta.url));
const allowed = new Set(["client_portal.dat", "client_cell_1.dat", "client_highres.dat", "client_local_English.dat"]);

Deno.serve({ port, hostname: "127.0.0.1" }, (req) => {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/dat/")) {
    const name = url.pathname.slice(5);
    if (!allowed.has(name)) return new Response("not found", { status: 404 });
    return serveFile(req, join(datDir, name));
  }
  return serveDir(req, { fsRoot: webRoot, quiet: true, enableCors: true });
});
