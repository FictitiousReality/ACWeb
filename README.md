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
- Interiors: building rooms and dungeons (EnvCells) with furniture; camera-in-cell
  detection via the cell BSP and portal-style visibility (current cell + visible cells,
  outdoors only through cells flagged as seen-from-outside)
- Animation: motion tables + animation sequencing; model viewer plays any motion of a Setup
- Not yet: server-spawned objects (doors, NPCs, chests, lifestones come from the server),
  clothing/palette swaps, water/sky, collision, networking

## Running

Requires [Deno](https://deno.com) 2.x.

```bash
deno task build                    # bundle web/main.ts -> web/dist/main.js
deno task serve ~/path/to/dats     # http://127.0.0.1:8000  (serves /dat/* with Range support)
```

Open http://127.0.0.1:8000/?auto=1, or pick the two dat files with the
"local files" source. Enter a landblock id (e.g. `A9B4` for Holtburn) and a
radius, then click Load. Drag or click the canvas to look, WASD to move.
Dungeon landblocks (e.g. `0002`) start the camera inside the first cell.
The model viewer loads a Setup id (e.g. `020000CE`) and plays its motions.

Other tasks: `deno task verify` (parser check), `deno task scenery A9B4`
(scenery placement stats).

## Layout

- `src/dat/` — dat reader: byte sources, container, record parsers
- `src/world/` — pure data transforms: texture decode, terrain geometry + blending, mesh building, scenery
- `src/render/` — Three.js side: asset cache, terrain shader, object placement, camera
- `src/tools/` — Deno CLI tools and the dev server
- `web/` — the page and bundle output
