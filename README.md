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
  (EnvCell), environments, regions, scenes, character generation, the skill
  table, particle emitters, physics scripts and script tables. `deno task verify` parses every record of each type in the retail dats
  and checks that each parser consumed exactly the file's bytes (885k files).
- **Outdoor world**: terrain with the client's TexMerge texture blending and
  roads, static objects, buildings, procedural scenery (trees, rocks, shrubs)
  placed with the client's PRNG rules.
- **Interiors**: building rooms and dungeons with furniture, camera-in-cell
  detection via the cell BSP, portal-style visibility.
- **Animation**: motion-table driven playback (transitions + cycles, action
  commands that play once and return to the cycle, server speed scaling), run/
  walk/turn/sidestep on the player, server-driven motions on other creatures.
- **Other players and NPCs**: dead-reckoned from their interpreted motion
  state (forward/sidestep velocity from the cycle animations, yaw rate from the
  turn cycle, MoveTo targets for NPCs); the server's position updates only
  correct the estimate, and corrections decay smoothly instead of teleporting.
- **Appearance**: clothing, armor, hair, skin and dye colors from each object's
  ObjDesc (part replacements, texture swaps, palette overlays); wielded and held
  items (weapons, shields, wands, torches) ride on the parent model's holding
  locations and follow its animation.
- **Networking**: the AC UDP protocol in the browser (checksums, ISAAC-keyed
  encrypted checksums, sequencing, acks, retransmits, fragments), login,
  character list, character creation, enter world, object streaming,
  positions, motions, chat (local, tells, emotes, General/Trade/LFG/Allegiance),
  Use / Give / Drop, inventory, recalls.
- **Sky and lighting**: the region's sky objects (dome, horizon, sun, moon,
  scrolling clouds) drawn around the camera, with time-of-day keyframed sun,
  ambient and fog driving the lights and terrain shader; Dereth time follows
  the server clock.
- **Particles**: emitters ported from the client's physics (still, velocity,
  parabolic, swarm, explode, implode types) drawn as billboards textured from
  the emitter's hardware GfxObj, or as clones of a real GfxObj mesh; created by
  animation hooks (spell wind-up orbs while casting), by the server's
  PlayEffect messages through each object's physics script table (buff and
  spell effects), and by each Setup's default script (portal vortices, which
  loop by calling themselves).
- **Collision**: walls, building interiors, scenery, closed doors and static
  server objects block the player (horizontal rays at knee and chest height,
  sliding along the wall); `/noclip` toggles walking through walls.
- **Client UI**: login and character creation, two-ring world streaming
  (full detail near the player, terrain-only to the horizon), third-person
  camera, click-to-target, inventory with the game's icons, tabbed chat with
  unread badges and Turbine channels, recall commands.

## Not yet

Combat, spellcasting, vendors, allegiance, fellowship, housing, water
surfaces, creature-to-creature collision, rain particles in the Rainy day
groups, sound.

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
- `src/render/` — Three.js side: asset cache, terrain shader, object placement, animated models, particles, world streaming, networked entities, player controller
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
- Other players' positions arrive about once a second (ACE throttles
  MoveToState position broadcasts to 1 s; AutonomousPosition always
  broadcasts). The retail client simulates nearby players from their motion
  state between updates; do the same or they teleport. The broadcast state is
  already interpreted: run is RunForward with ForwardSpeed = run rate, walking
  backwards is WalkForward with speed -0.65, sidestep is SideStepRight with
  speed = rate * 3.12 / 1.25 * 0.5 (sign for left, clamped to 3), turn is
  TurnRight with speed 1 (1.5 running, sign for left). Displacement per second
  comes from summing the cycle animation's position frames (a reversed cycle
  moves the other way); turn rate comes from the cycle's Omega field (-1.5
  rad/s for TurnRight); server speeds multiply both the velocity and the
  animation framerate.
- A creature usually comes into view already moving, so its CreateObject and
  its first motion message arrive together. Rebuilding the animation sequence
  across awaits let the two interleave: the sequence ended up holding the idle
  cycle while the model believed it was running, every later run message was a
  no-op, and the velocity was added twice. Load every animation first and then
  rebuild the sequence synchronously; compute velocities into locals and assign
  after the newest-request check. Symptom: players slide with no run animation.
- Dev loop for movement bugs: play.html?debug=1 posts raw movement messages to
  the dev server (captures.log); `deno run --allow-read src/tools/decodecap.ts`
  decodes them and `acweb.replay("<name>")` in the viewer replays one object
  through the real NetWorld. UpdateObject (0xF745) arrives often for items;
  refresh entities in place instead of rebuilding their models.
- A reversed animation segment (negative framerate, used by the spell
  power-up "bounce") still hands over to the *next* node when it reaches its
  low frame; the direction of wall-clock time picks the next node, not the
  segment's direction. Getting this wrong ping-pongs between the two segments
  forever.
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
- Appearance (ObjDesc) on creatures: replace Setup parts by index with the
  listed GfxObjs (clothing, hair), swap textures per part by original
  SurfaceTexture id, and build one palette per object (base palette with the
  sub-palette ranges copied in) for its indexed textures. Cache per distinct
  outfit; crowds share materials.
- Sky: the region's SkyDesc lists day groups (Sunny/Clear/Cloudy/Rainy), each
  with sky GfxObjs (dome, horizon band, sun, moon, clouds) and keyframes by
  time of day giving sun heading/pitch/color, ambient, fog and per-object
  luminosity/transparency (percent, 100 = invisible) and rotation. Draw the
  sky in its own scene at the camera origin with depth testing off, sweep sun
  and moon about the north axis by their angle windows, scroll cloud UVs by
  texture velocity. Static sky textures must clamp to edge (their polygons end
  exactly at texture edges, repeat wrapping draws seams); scrolling layers must
  keep repeat wrapping or they smear into streaks.
- Dereth time: a day is 7620 ticks with the epoch at tick 3600 of the day, so
  timeOfDay = ((ticks + 3600) mod 7620) / 7620; the server's TimeSync packets
  carry the ticks.
- Particles: an emitter (0x32) says how to spawn sprites (birthrate, lifespan,
  offset, A/B/C motion vectors with min/max magnitudes, scale and translucency
  ramps, parent-local or world-fixed). Emitters are started by CreateParticle
  hooks in animation frames (a hook runs when the sequence passes its frame,
  forward-only hooks on forward segments, backward-only on reversed ones) and
  by physics scripts (0x33: hooks at start times), which a script table (0x34)
  maps from a PlayScript id; the server's PlayEffect message carries the object,
  PlayScript and an intensity mod, and the table entry with the largest mod not
  above the requested one wins. The sprite texture is the first surface of the
  emitter's hardware GfxObj, sized 1.8x the mesh extents, additive when the
  surface says so. Spell wind-ups are MagicPowerUp motions whose animation
  frames carry the hooks; the cast gestures themselves hold a pose (framerate 0
  cycles). When a motion table has no transition from the current motion,
  link through the stance's default motion (ACE's do_link).
- Portals are a single clip-mapped quad; the swirl is the Setup's default
  physics script (2161 of the 5935 Setups have one: torches, fountains,
  portals...). The script creates two emitters, one with sprite particles
  (hardware GfxObj) and one with mesh particles (a GfxObj and no hardware
  GfxObj), and ends with a CallPES hook that starts the same script again 2.7
  s later, which is how it loops. The server only sends a PhysicsDesc
  DefaultScript (a PlayScript through the script table) when the weenie has
  one; the Setup script runs regardless. Sprite size is the hardware GfxObj
  quad's own extents times the particle scale (ACViewer's extra 1.8 factor is
  a guess in its source).
- Wall collision does not need the client's physics BSP: two horizontal rays
  (0.7 and 1.4 above the feet, so steps and ramps pass underneath) against the
  rendered meshes of nearby buildings, interior cells, scenery instances and
  door/static entities, clipped to the player radius, with the remaining
  motion projected onto the wall plane for sliding. About 0.2 ms per query.
  Doors need no special casing: the door entity plays its On/Off motion, so
  the rendered mesh swings out of the way.
- Held items: a wielded object's PhysicsDesc carries a parent guid and a
  ParentLocation (RightHand 1, LeftHand 2, Shield 3, Belt 4, Quiver 5...);
  later wields arrive as ParentEvent (creature, item, location, placement).
  The parent Setup's holdingLocations map that location to a part index and a
  frame; parent the child under that part with the frame as its local
  transform (ACE UpdateChild = part frame combined with the holding frame) and
  the child's own placement frame (Placement id from the message) poses its
  parts. The child often arrives before its parent, so keep it pending.
- Region fog runs to 2400 units by day; cap it inside the loaded terrain
  distance or the edge of the world shows as a void. Two streaming rings
  (detail near, terrain-only far) give a kilometre of horizon cheaply.
