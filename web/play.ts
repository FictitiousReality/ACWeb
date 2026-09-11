import * as THREE from "three";
import { DatDatabase, HttpRangeSource } from "../src/dat/mod.ts";
import { Assets } from "../src/render/assets.ts";
import { WorldStreamer } from "../src/render/streamer.ts";
import { NetWorld, positionToWorld } from "../src/render/networld.ts";
import { PlayerController } from "../src/render/player.ts";
import { AnimatedModel } from "../src/render/animated.ts";
import { GameClient } from "../src/net/client.ts";
import type { CharacterList, WorldObject } from "../src/net/client.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $("status");
const chatlog = $("chatlog");
const loginStatus = $("loginStatus");
function log(line: string, cls = "") {
  console.log(line);
  const div = document.createElement("div");
  div.textContent = line;
  if (cls) div.className = cls;
  chatlog.appendChild(div);
  chatlog.scrollTop = chatlog.scrollHeight;
  while (chatlog.children.length > 300) chatlog.removeChild(chatlog.firstChild!);
}

// ---------- renderer ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb4c8);
scene.fog = new THREE.Fog(0x9fb4c8, 500, 1300);
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.3, 4000);
camera.up.set(0, 0, 1);
const sunDir = new THREE.Vector3(0.4, 0.3, -0.85).normalize();
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.copy(sunDir.clone().negate().multiplyScalar(100));
scene.add(sun, new THREE.AmbientLight(0xffffff, 0.9));
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// orbit camera around the player
let camYaw = 0, camPitch = 0.25, camDist = 6;
let dragging = false;
renderer.domElement.addEventListener("mousedown", () => (dragging = true));
addEventListener("mouseup", () => (dragging = false));
addEventListener("mousemove", (e) => {
  if (!dragging) return;
  camYaw -= e.movementX * 0.005;
  camPitch = Math.max(-0.3, Math.min(1.3, camPitch + e.movementY * 0.005));
});
addEventListener("wheel", (e) => (camDist = Math.max(1.5, Math.min(40, camDist + e.deltaY * 0.01))));

// ---------- world ----------
let assets: Assets | null = null;
let streamer: WorldStreamer | null = null;
let netWorld: NetWorld | null = null;
let player: PlayerController | null = null;
let client: GameClient | null = null;
let iterations = { portal: 2072, cell: 982, language: 994 };

async function openDats() {
  log("opening dats over HTTP...");
  const [portal, cell, lang] = await Promise.all([
    DatDatabase.open(await HttpRangeSource.open("/dat/client_portal.dat")),
    DatDatabase.open(await HttpRangeSource.open("/dat/client_cell_1.dat")),
    DatDatabase.open(await HttpRangeSource.open("/dat/client_local_English.dat")).catch(() => null),
  ]);
  iterations = { portal: await portal.iteration(), cell: await cell.iteration(), language: lang ? await lang.iteration() : 994 };
  assets = new Assets(portal, cell);
  const region = await assets.region();
  streamer = new WorldStreamer(assets, region);
  streamer.onLog = (s) => log(s, "err");
  await streamer.init();
  scene.add(streamer.outdoor, streamer.indoor);
  netWorld = new NetWorld(assets, streamer.objects);
  scene.add(netWorld.group);
  log(`dats ready (portal ${iterations.portal}, cell ${iterations.cell}, language ${iterations.language})`);
}

$("loginForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  try {
    if (!assets) await openDats();
    const relay = $<HTMLInputElement>("relay").value.trim();
    const host = $<HTMLInputElement>("host").value.trim();
    const port = Number($<HTMLInputElement>("port").value) || 9000;
    const account = $<HTMLInputElement>("account").value.trim();
    const password = $<HTMLInputElement>("password").value;
    if (!account) { loginStatus.textContent = "account required"; return; }
    loginStatus.textContent = "connecting...";
    client?.disconnect();
    client = new GameClient(relay, iterations, {
      onLog: (l) => { log(l); loginStatus.textContent = l; },
      onState: (s, d) => { statusEl.textContent = `${s}${d ? " " + d : ""}`; if (s === "error" || s === "closed") loginStatus.textContent = `${s}: ${d ?? ""}`; },
      onChat: (text, kind, sender) => log(sender ? `${sender}: ${text}` : text, kind.startsWith("system") ? "" : ""),
      onCharacterList: showCharacters,
      onEnterWorld: onEnterWorld,
      onObjectCreate: (o) => onObject(o),
      onObjectUpdate: (o) => onObject(o),
      onObjectPosition: (o, u) => { if (o.guid === client!.playerGuid) { player?.setFromPosition(u.position); } else netWorld?.onPosition(o, u); },
      onObjectMotion: (o, m) => { if (o.guid !== client!.playerGuid) netWorld?.onMotion(o, m); },
      onObjectDelete: (g) => netWorld?.remove(g),
    });
    client.connect(host, port, account, password);
    if (new URLSearchParams(location.search).get("debug") === "1") client.session!.debug = true;
    $<HTMLInputElement>("password").value = "";
  } catch (e) {
    loginStatus.textContent = `error: ${(e as Error).message}`;
    console.error(e);
  }
});

function showCharacters(list: CharacterList) {
  const box = $("chars");
  box.innerHTML = "";
  if (!list.characters.length) {
    box.textContent = "This account has no characters. Create one with the official client first.";
    return;
  }
  for (const c of list.characters) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `${c.name}${c.deleteTime ? " (pending delete)" : ""}`;
    b.onclick = () => { loginStatus.textContent = `entering as ${c.name}...`; client!.enterWorld(c.id); };
    box.appendChild(b);
  }
}

async function onEnterWorld(guid: number) {
  $("login").style.display = "none";
  $("hud").classList.add("show");
  player = new PlayerController(client!, streamer!);
  scene.add(player.root);
  const me = client!.objects.get(guid);
  if (me?.position) {
    player.setFromPosition(me.position);
    streamer!.update(player.pos.x, player.pos.y);
  }
  if (me?.setup) {
    const m = await AnimatedModel.create(assets!, streamer!.objects, me.setup);
    if (m) await player.setModel(m);
  }
  log(`entered world as ${me?.name ?? guid.toString(16)}`);
  // objects that arrived before the player entry
  for (const o of client!.objects.values()) if (o.guid !== guid) netWorld!.create(o);
}

function onObject(o: WorldObject) {
  if (!client || !netWorld) return;
  if (o.guid === client.playerGuid) {
    if (player && o.position) player.setFromPosition(o.position);
    return;
  }
  if (player) netWorld.create(o);
}

$("chatin").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const inp = e.target as HTMLInputElement;
  const text = inp.value.trim();
  inp.value = "";
  if (text && client) { client.say(text); log(`You say, "${text}"`); }
  inp.blur();
});

// ---------- frame loop ----------
let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (player) {
    player.update(dt);
    streamer?.update(player.pos.x, player.pos.y);
    const yaw = player.yaw + camYaw;
    const back = new THREE.Vector3(Math.sin(yaw), -Math.cos(yaw), 0).multiplyScalar(camDist * Math.cos(camPitch));
    const eye = player.pos.clone().add(back).add(new THREE.Vector3(0, 0, 1.6 + camDist * Math.sin(camPitch)));
    const ground = streamer?.heightAt(eye.x, eye.y);
    if (ground !== null && ground !== undefined && eye.z < ground + 0.5) eye.z = ground + 0.5;
    camera.position.copy(eye);
    camera.lookAt(player.pos.clone().add(new THREE.Vector3(0, 0, 1.4)));
    if (streamer && streamer.envcells.cells.size) streamer.envcells.applyVisibility(camera.position, streamer.outdoor);
    const p = player.position();
    statusEl.textContent = `${client?.serverName ?? ""}  cell ${p.cell.toString(16).toUpperCase().padStart(8, "0")}  x ${p.x.toFixed(1)} y ${p.y.toFixed(1)} z ${p.z.toFixed(1)}  objects ${netWorld?.entities.size ?? 0}`;
  }
  netWorld?.update(dt);
  camera.updateMatrixWorld();
  streamer?.terrain.updateLight(camera, sunDir);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

(globalThis as unknown as { acweb: unknown }).acweb = {
  THREE, scene, camera, get client() { return client; }, get player() { return player; }, get streamer() { return streamer; }, get netWorld() { return netWorld; }, positionToWorld,
};
