# acweb

A from-scratch browser client for Asheron's Call, written in TypeScript with
Three.js. It reads the original `client_portal.dat` / `client_cell_1.dat`
files (which you must supply yourself) and is intended to eventually connect
to an [ACEmulator](https://github.com/ACEmulator/ACE) server over WebSocket.

File formats and rendering logic are ported from ACE's DatLoader / physics
code and from ACViewer. Educational, non-commercial.

## Status

- DAT container + record parsers, verified byte-exact against the end-of-retail dats (`deno task verify`)
- Outdoor landblocks: terrain with the client's TexMerge texture blending and roads,
  static objects, buildings, procedural scenery
- Not yet: dungeons / building interiors (EnvCells), animation, clothing, water/sky, networking

## Running

Requires [Deno](https://deno.com) 2.x.

```bash
deno task build                    # bundle web/main.ts -> web/dist/main.js
deno task serve ~/path/to/dats     # http://127.0.0.1:8000  (serves /dat/* with Range support)
```

Open http://127.0.0.1:8000/?auto=1, or pick the two dat files with the
"local files" source. Enter a landblock id (e.g. `A9B4` for Holtburn) and a
radius, then click Load. Drag or click the canvas to look, WASD to move.

Other tasks: `deno task verify` (parser check), `deno task scenery A9B4`
(scenery placement stats).

## Layout

- `src/dat/` — dat reader: byte sources, container, record parsers
- `src/world/` — pure data transforms: texture decode, terrain geometry + blending, mesh building, scenery
- `src/render/` — Three.js side: asset cache, terrain shader, object placement, camera
- `src/tools/` — Deno CLI tools and the dev server
- `web/` — the page and bundle output
