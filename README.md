# acweb

A from-scratch browser client for Asheron's Call, written in TypeScript with
Three.js (WebGL 2). It reads the original `client_portal.dat` /
`client_cell_1.dat` files, which you must supply yourself, and plays on
[ACEmulator](https://github.com/ACEmulator/ACE) servers through a tiny
WebSocket-to-UDP relay. No server modifications are required; it has been
tested against Coldeve.

File formats, rendering rules and the network protocol are ported from ACE's
DatLoader / physics / network code and from ACViewer. Educational and
non-commercial. Never redistribute the DAT files. This is an unofficial client:
check the rules of any server before connecting to it.

## What works

- **DAT reader**: container B-tree, chained-sector files, and parsers for
  meshes (GfxObj), multi-part models (Setup), animations, motion tables,
  palettes, textures, surfaces, landblocks, landblock info, indoor cells
  (EnvCell), environments, regions, scenes, character generation and the skill
  table. `deno task verify` parses every record of each type in the retail dats
  and checks that each parser consumed exactly the file's bytes (885k files).
- **Outdoor world**: terrain with the client's TexMerge texture blending and
  roads, static objects, buildings, procedural scenery (trees, rocks, shrubs)
  placed with the client's PRNG rules.
- **Interiors**: building rooms and dungeons with furniture, camera-in-cell
  detection via the cell BSP, portal-style visibility.
- **Animation**: motion-table driven playback (transitions + cycles), run/walk/
  turn/sidestep on the player, server-driven motions on other creatures.
- **Appearance**: clothing, armor, hair, skin and dye colors from each object's
  ObjDesc (part replacements, texture swaps, palette overlays).
- **Networking**: the AC UDP protocol in the browser (checksums, ISAAC-keyed
  encrypted checksums, sequencing, acks, retransmits, fragments), login,
  character list, character creation, enter world, object streaming,
  positions, motions, chat (local, tells, emotes, General/Trade/LFG/Allegiance),
  Use / Give / Drop, inventory, recalls.
- **Client UI**: login and character creation, world streaming around the
  player, third-person camera, click-to-target, inventory with the game's icons,
  tabbed chat with unread badges.

## Not yet

Combat, spellcasting, vendors, allegiance, fellowship, housing, water and sky
rendering, collision against walls (you walk through them; floors and terrain
are followed), particle effects, sound.

## Running

Requires [Deno](https://deno.com) 2.x. Nothing else is installed by this project.

```bash
deno task build                    # bundles web/main.ts and web/play.ts into web/dist/
deno task serve ~/path/to/dats     # http://127.0.0.1:8000 — static files + /dat/* with Range support
deno task proxy                    # ws://127.0.0.1:8001 — WebSocket <-> UDP relay to the game server
```

- **Play**: open http://127.0.0.1:8000/play.html, enter the server host and
  port (Coldeve is `play.coldeve.ac:9000`), your account and password, pick or
  create a character, enter. Add `?debug=1` to log every packet on the Debug tab.
  Your password is written only into the login packet.
- **Explore without a server**: http://127.0.0.1:8000/?auto=1 is a world and
  model viewer. Enter a landblock id (`A9B4` Holtburg, `0002` a dungeon) and a
  radius; the model field loads a Setup and plays its motions.
- Other tasks: `deno task verify` (parser check), `deno task scenery A9B4`
  (scenery placement stats), `deno task probe host port` (send a harmless
  empty-password login and print the server's reply).

Controls in play: W/S move, A/D turn, Q/E sidestep, hold Shift to walk, drag
the mouse to orbit, wheel to zoom, click an object to target it, U to use it,
I for inventory, Enter for chat, Escape to clear the target or leave the chat box.

Chat commands: `/tell Name, message`, `/r reply`, `/e emote`, `/say`, `/g`,
`/tr`, `/lfg`, `/a`, `/ls`, `/mp`, `/house`, `/mansion`, `/hom`, and any `@`
command is passed to the server.

## Layout

- `src/dat/` — dat reader: byte sources (Deno file, browser Blob, HTTP Range), container, record parsers
- `src/world/` — pure data transforms: texture decoding, terrain geometry and blending, mesh building, scenery placement, cell tests, animation sequencing
- `src/net/` — AC network protocol: packet codec, checksum/ISAAC, session, message codecs, game client
- `src/render/` — Three.js side: asset cache, terrain shader, object placement, animated models, world streaming, networked entities, player controller
- `src/tools/` — Deno tools: verify, scenery stats, server probe, dev server, relay
- `web/` — `index.html` (viewer), `play.html` (client), bundles in `dist/`

## Things we learned

Most of this is not written down anywhere else; it came from reading ACE and
ACViewer and from testing against the real files and a real server.

### DAT files

- Every file is a chain of sectors; the first dword of a sector points to the
  next. The directory is a B-tree of nodes with 62 branch pointers and up to 61
  entries. Header at offset 0x140, magic "BT".
- BSP trees use four-byte tags stored reversed on disk. Tags not in the usual
  set (BPOL, BPFL, BpIn) carry no children; treating them that way, as ACE
  does, is what makes every GfxObj and Environment parse byte-exact.
- A SurfaceTexture lists a high-resolution texture first that only exists in
  `client_highres.dat`; take the first texture id that is actually present.
- Polygon vertex order is already counter-clockwise for front faces in a
  right-handed Z-up world; do not flip it.
- Terrain: each landblock is a 9x9 height grid with a height-table lookup; the
  diagonal of each cell is chosen by a hash of the global cell coordinates. The
  blend of up to three overlay textures and two road alphas per cell (TexMerge)
  and the alpha-map PRNG use uint32 wrapping arithmetic; ACE's C# port of the
  PRNG overflows to 64-bit and effectively always picks index 0.
- Scenery is placed per terrain vertex from the region's scene tables with
  uint32 PRNG displacement, scale and rotation, skipping roads and building
  footprints and checking slope.
- Building floors sit exactly on the terrain plane; the terrain needs a depth
  bias (polygon offset) or it draws over interior floors.
- The cell dat contains several identical copies of the training halls in
  adjacent landblocks, and dungeon geometry can extend outside its landblock's
  192x192 box (negative local coordinates). Load only the player's dungeon
  landblock and prefer its cells when testing which cell a point is in.
- Sub-palette ranges in appearance data are in units of 8 colors; palettes
  have 2048 entries. Skin is offset 0 length 24, hair 24/8, eyes 32/8.

### Network protocol

- UDP, port N for client->server and N+1 for the ConnectResponse and
  server->client traffic. Browsers cannot send UDP, hence the relay: each
  WebSocket frame is `[portOffset][datagram]`.
- Packet = 20-byte header + optional fields selected by flags + blob fragments
  (16-byte header + up to 448 bytes). Checksum is a simple dword-sum hash of
  the header (with the checksum field set to 0xBADD70DD) plus the payload;
  encrypted-checksum packets XOR the payload hash with the next value of an
  ISAAC stream seeded by the ConnectRequest (one stream per direction).
- Handshake: LoginRequest (plain, sequence 0, version "1802", account,
  password) -> ConnectRequest (server time, cookie, client id, two seeds) ->
  ConnectResponse (cookie, to port N+1). ACE sends ConnectRequest as sequence
  0 and then restarts at 1 for encrypted packets, so its first real packet is
  sequence 2: set the expected sequence to 1 after connect or you will NAK a
  packet that does not exist.
- Client data packets start at sequence 2, fragment sequences at 1; pure
  ack/NAK packets reuse the current sequence. Send an ack every 2 seconds and
  an echo request every 10 seconds or the session times out at 60.
- After the connect the server sends the character list, then a DDD
  interrogation; answer it with your dat iterations (portal 2072, cell 982,
  language 994 at end of retail) as "mostly consecutive int sets" (`[1, -N]`)
  or you will be told to patch.
- Enter world: CharacterEnterWorldRequest -> ServerReady -> CharacterEnterWorld
  (guid + account) -> PlayerCreate + CreateObject flood. The player stays in the
  arrival "pink bubble" (Hidden, IgnoreCollisions, no position updates
  accepted) until the client sends the LoginComplete game action. Send it
  again after every PlayerTeleport (recalls, portals) for the same reason.
- CreateObject = guid + ObjDesc + PhysicsDesc + WeenieDesc. Two header fields
  bite: PScript and HookType are 16-bit. The motion table for creatures comes
  from PhysicsDesc, not from the Setup's defaults (which are often zero).
- Positions are landblock-local. The server rejects a MoveToState /
  AutonomousPosition whose cell is in a different landblock than it thinks
  you are in when both are indoor cells, so report the cell from the cell BSP,
  compute local coordinates relative to that cell's landblock (they can be
  negative), and never switch landblocks inside a dungeon.
- Using an NPC out of range makes the server send you a MoveToObject motion
  and wait for your position reports to arrive within the use radius; if your
  reports are being rejected, uses silently never complete and gives answer
  "You're too busy".
- Turbine chat (General/Trade/LFG/Allegiance) is a separate blob format inside
  message 0xF7DE with packed-length UTF-16 strings; the server echoes your own
  channel messages back, so don't echo locally.
- A dungeon like the Marketplace (800+ cells) fans out into thousands of small
  Range reads; limit concurrent fetches (six) and retry, or the browser starts
  failing them.

### Rendering

- Custom GLSL3 ShaderMaterials must apply `linearToOutputTexel()` themselves
  or the output is too dark.
- Terrain uses two `DataArrayTexture`s (terrain textures, alpha masks) and a
  single-pass blend shader ported from ACViewer; per-vertex attributes carry
  layer indices and rotated alpha UVs for up to three overlays and two roads.
