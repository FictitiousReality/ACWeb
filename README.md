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
- Networking: the AC UDP protocol in the browser (packet checksums, ISAAC-keyed encrypted
  checksums, sequencing/acks/retransmits, fragments) via a tiny WebSocket-to-UDP relay;
  login handshake, character list, enter world, object create/update/delete, positions,
  motion, chat, and local movement reporting (MoveToState / AutonomousPosition)
- Not yet: clothing/palette swaps on creatures, water/sky, collision, combat/inventory UI

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

## Playing on a server

Browsers cannot send UDP, so a relay forwards WebSocket frames to the game server:

```bash
deno task proxy                    # ws://127.0.0.1:8001  (needs --unstable-net, already in the task)
deno task serve ~/path/to/dats     # http://127.0.0.1:8000
```

Open http://127.0.0.1:8000/play.html, enter the server host/port (defaults to
Coldeve, `play.coldeve.ac:9000`), your account and password, pick a character
and enter. Your password is written only into the login packet sent to the
server. Add `?debug=1` to the URL to log every packet. Check the rules of the
server you connect to; this is an unofficial client.

Other tasks: `deno task verify` (parser check), `deno task scenery A9B4`
(scenery placement stats).

## Layout

- `src/dat/` — dat reader: byte sources, container, record parsers
- `src/world/` — pure data transforms: texture decode, terrain geometry + blending, mesh building, scenery
- `src/net/` — AC network protocol: packet codec, session, message codecs, game client
- `src/render/` — Three.js side: asset cache, terrain shader, object placement, camera, world streaming, networked entities, player controller
- `src/tools/` — Deno CLI tools and the dev server
- `web/` — `index.html` (world/model viewer), `play.html` (server client), bundle output in `dist/`
