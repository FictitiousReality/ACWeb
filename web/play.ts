import * as THREE from "three";
import { DatDatabase, HttpRangeSource } from "../src/dat/mod.ts";
import { Assets, iconDataUrl } from "../src/render/assets.ts";
import { WorldStreamer } from "../src/render/streamer.ts";
import { NetWorld, positionToWorld } from "../src/render/networld.ts";
import { PlayerController } from "../src/render/player.ts";
import { AnimatedModel } from "../src/render/animated.ts";
import { ParticleSystem } from "../src/render/particles.ts";
import { SkyRenderer, timeOfDayFromServerTime } from "../src/render/sky.ts";
import { GameClient } from "../src/net/client.ts";
import type { CharacterList, WorldObject } from "../src/net/client.ts";
import { CHARGEN_ID, SKILLTABLE_ID, parseCharGen, parseSkillTable } from "../src/dat/mod.ts";
import type { CharGen, SkillBase } from "../src/dat/mod.ts";
import { Opcode } from "../src/net/messages.ts";
import { commandFromKey, MotionCommandNames } from "../src/dat/motionenums.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $("status");
const loginStatus = $("loginStatus");

// ---------- chat panel with tabs ----------
type Tab = "all" | "chat" | "general" | "trade" | "lfg" | "system" | "debug";
const TABS: Tab[] = ["all", "chat", "general", "trade", "lfg", "system", "debug"];
const CHANNEL_TABS: Record<number, Tab> = { 2: "general", 3: "trade", 4: "lfg" };
const TAB_CHANNEL: Partial<Record<Tab, number>> = { general: 2, trade: 3, lfg: 4 };
let activeTab: Tab = "all";
let showTimestamps = false;
const unread: Record<Tab, number> = { all: 0, chat: 0, general: 0, trade: 0, lfg: 0, system: 0, debug: 0 };
const CHAT_CLASSES = new Set(["c-speech", "c-tell", "c-outtell", "c-emote", "c-you", "c-broadcast"]);
const MAX_LINES = 400;

function tabsFor(cls: string): Tab[] {
  if (cls === "c-debug") return ["debug"];
  if (cls === "c-general") return ["all", "general"];
  if (cls === "c-trade") return ["all", "trade"];
  if (cls === "c-lfg") return ["all", "lfg"];
  if (cls === "c-allegiance") return ["all", "chat"];
  if (CHAT_CLASSES.has(cls)) return ["all", "chat"];
  return ["all", "system"];
}

/** Append a line. `sender` makes the name clickable to start a tell. */
function log(line: string, cls = "", sender?: string) {
  if (cls !== "c-debug") console.log(line);
  for (const tab of tabsFor(cls)) {
    const box = $(`log-${tab}`);
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 8;
    const div = document.createElement("div");
    if (cls) div.className = cls;
    if (showTimestamps) {
      const ts = document.createElement("span");
      ts.className = "ts";
      ts.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      div.appendChild(ts);
    }
    if (sender && line.startsWith(sender)) {
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = sender;
      name.onclick = () => { const inp = $<HTMLInputElement>("chatin"); inp.value = `/tell ${sender}, `; inp.focus(); };
      div.appendChild(name);
      div.appendChild(document.createTextNode(line.slice(sender.length)));
    } else {
      div.appendChild(document.createTextNode(line));
    }
    box.appendChild(div);
    while (box.children.length > MAX_LINES) box.removeChild(box.firstChild!);
    if (atBottom) box.scrollTop = box.scrollHeight;
    if (tab !== activeTab && tab !== "all" && cls !== "c-debug") {
      unread[tab]++;
      updateBadges();
    }
  }
}
function updateBadges() {
  for (const b of document.querySelectorAll<HTMLButtonElement>("#chattabs button[data-tab]")) {
    const tab = b.dataset.tab as Tab;
    const badge = b.querySelector(".badge")!;
    badge.textContent = unread[tab] > 0 ? String(unread[tab]) : "";
  }
}
function setTab(tab: Tab) {
  activeTab = tab;
  unread[tab] = 0;
  for (const t of TABS) $(`log-${t}`).classList.toggle("active", t === tab);
  for (const b of document.querySelectorAll<HTMLButtonElement>("#chattabs button[data-tab]")) b.classList.toggle("active", b.dataset.tab === tab);
  const box = $(`log-${tab}`);
  box.scrollTop = box.scrollHeight;
  updateBadges();
  const ch = TAB_CHANNEL[tab];
  $<HTMLInputElement>("chatin").placeholder = ch ? `say on ${tab} (Enter) · /s to say locally` : "say something… (Enter · /tell Name, msg · /r reply · /e emote · /g /tr /lfg channels · @cmd)";
}
for (const b of document.querySelectorAll<HTMLButtonElement>("#chattabs button[data-tab]")) b.onclick = () => setTab(b.dataset.tab as Tab);
$("chatClear").onclick = () => { $(`log-${activeTab}`).innerHTML = ""; };
$("chatTs").onclick = () => { showTimestamps = !showTimestamps; };

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
const ambient = new THREE.AmbientLight(0xffffff, 0.9);
scene.add(sun, ambient);
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
let particles: ParticleSystem | null = null;
let sky: SkyRenderer | null = null;
let player: PlayerController | null = null;
let client: GameClient | null = null;
let iterations = { portal: 2072, cell: 982, language: 994 };
let charGen: CharGen | null = null;
let skillTable: Map<number, SkillBase> | null = null;

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
  particles = new ParticleSystem(assets, streamer.objects);
  scene.add(particles.group);
  netWorld = new NetWorld(assets, streamer.objects, particles);
  netWorld.groundAt = (x, y, z) => streamer!.floorAt(x, y, z);
  netWorld.playerHost = () => player?.model ?? null;
  netWorld.playerPos = () => player?.pos ?? null;
  // closed doors, chests, statues... block the player; creatures and ethereal objects don't
  streamer.extraColliders = () => {
    const out: THREE.Object3D[] = [];
    for (const e of netWorld!.entities.values()) {
      const o = e.obj;
      if (o.physicsState & 0x4) continue; // Ethereal
      if (o.objectFlags & 0x18) continue; // Player | Attackable (creatures)
      if (o.mtable && !(o.objectFlags & 0x1000)) continue; // animated things other than doors
      out.push(e.root);
    }
    return out;
  };
  scene.add(netWorld.group);
  sky = new SkyRenderer(assets, region);
  await sky.build();
  scene.background = null;
  renderer.autoClear = false;
  log(`dats ready (portal ${iterations.portal}, cell ${iterations.cell}, language ${iterations.language})`);
  charGen = await portal.get(CHARGEN_ID, parseCharGen);
  skillTable = await portal.get(SKILLTABLE_ID, parseSkillTable);
  setupCreateForm();
}

// ---------- character creation ----------
function setupCreateForm() {
  if (!charGen) return;
  const her = $<HTMLSelectElement>("cHeritage");
  her.innerHTML = "";
  for (const [id, h] of charGen.heritageGroups) {
    if (id >= 12) continue; // olthoi play is normally disabled
    const o = document.createElement("option");
    o.value = String(id);
    o.textContent = h.name;
    her.appendChild(o);
  }
  her.onchange = fillTemplates;
  $<HTMLSelectElement>("cTemplate").onchange = fillTemplateInfo;
  fillTemplates();
}
function fillTemplates() {
  if (!charGen) return;
  const h = charGen.heritageGroups.get(Number($<HTMLSelectElement>("cHeritage").value))!;
  const sel = $<HTMLSelectElement>("cTemplate");
  sel.innerHTML = "";
  h.templates.forEach((t, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = t.name;
    sel.appendChild(o);
  });
  if (h.templates.length > 1) sel.value = "1";
  const start = $<HTMLSelectElement>("cStart");
  start.innerHTML = "";
  for (const i of [...h.primaryStartAreas, ...h.secondaryStartAreas]) {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = charGen.starterAreas[i]?.name ?? String(i);
    start.appendChild(o);
  }
  fillTemplateInfo();
}
function templateCost(heritageId: number, templateIdx: number) {
  const h = charGen!.heritageGroups.get(heritageId)!;
  const t = h.templates[templateIdx];
  const cost = (id: number, primary: boolean) => {
    const cg = h.skills.find((x) => x.skill === id);
    const base = skillTable!.get(id);
    if (primary) return cg ? cg.primaryCost : (base?.specializedCost ?? 0);
    return cg ? cg.normalCost : (base?.trainedCost ?? 0);
  };
  const skillCost = t.normalSkills.reduce((n, id) => n + cost(id, false), 0) + t.primarySkills.reduce((n, id) => n + cost(id, true), 0);
  const attrSum = t.strength + t.endurance + t.coordination + t.quickness + t.focus + t.self;
  return { t, h, skillCost, attrSum };
}
function fillTemplateInfo() {
  if (!charGen || !skillTable) return;
  const { t, h, skillCost, attrSum } = templateCost(Number($<HTMLSelectElement>("cHeritage").value), Number($<HTMLSelectElement>("cTemplate").value));
  const names = (ids: number[]) => ids.map((id) => skillTable!.get(id)?.name ?? `#${id}`).join(", ");
  $("cTemplateInfo").textContent =
    `Str ${t.strength}  End ${t.endurance}  Coord ${t.coordination}  Quick ${t.quickness}  Focus ${t.focus}  Self ${t.self}  (${attrSum}/${h.attributeCredits})\n` +
    `Specialized: ${names(t.primarySkills) || "-"}\nTrained: ${names(t.normalSkills) || "-"}\nSkill credits used ${skillCost}/${h.skillCredits}`;
}
$("cCreate").addEventListener("click", () => {
  if (!client || !charGen || !skillTable) return;
  const heritage = Number($<HTMLSelectElement>("cHeritage").value);
  const templateOption = Number($<HTMLSelectElement>("cTemplate").value);
  const { t, h, skillCost, attrSum } = templateCost(heritage, templateOption);
  const name = $<HTMLInputElement>("cName").value.trim();
  if (!name) { loginStatus.textContent = "enter a character name"; return; }
  if (attrSum > h.attributeCredits || skillCost > h.skillCredits) { loginStatus.textContent = "template exceeds credits"; return; }
  const skills = new Array<number>(55).fill(0);
  for (const id of skillTable.keys()) if (id < 55) skills[id] = 1;
  for (const id of t.normalSkills) skills[id] = 2;
  for (const id of t.primarySkills) skills[id] = 3;
  client.createCharacter({
    heritage, gender: Number($<HTMLSelectElement>("cGender").value), templateOption,
    attributes: { strength: t.strength, endurance: t.endurance, coordination: t.coordination, quickness: t.quickness, focus: t.focus, self: t.self },
    skills, name, startArea: Number($<HTMLSelectElement>("cStart").value),
  });
  loginStatus.textContent = `creating ${name}...`;
});

// load the dats as soon as the page opens; logging in is a separate, explicit step
const datsReady = openDats().catch((e) => { loginStatus.textContent = `dat load failed: ${(e as Error).message}`; console.error(e); });

$("loginForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  try {
    await datsReady;
    if (!assets) throw new Error("dats not loaded");
    const relay = $<HTMLInputElement>("relay").value.trim();
    const host = $<HTMLInputElement>("host").value.trim();
    const port = Number($<HTMLInputElement>("port").value) || 9000;
    const account = $<HTMLInputElement>("account").value.trim();
    const password = $<HTMLInputElement>("password").value;
    if (!account) { loginStatus.textContent = "account required"; return; }
    loginStatus.textContent = "connecting...";
    client?.disconnect();
    client = new GameClient(relay, iterations, {
      onLog: (l) => { log(l, "c-debug"); if (!l.startsWith("<<") && !l.startsWith(">>")) loginStatus.textContent = l; },
      onState: (s, d) => { statusEl.textContent = `${s}${d ? " " + d : ""}`; if (s === "error" || s === "closed") loginStatus.textContent = `${s}: ${d ?? ""}`; },
      onChat: (text, kind, sender) => {
        const [k, sub] = kind.split(":");
        const n = Number(sub);
        // the server echoes our own speech and emotes back; we already printed them when sent
        const me = myName();
        if (me && ((k === "speech" && sender === me) || (k === "emote" && text.startsWith(me + " ")))) return;
        if (k === "speech") log(`${sender} says, "${text}"`, "c-speech", sender);
        else if (k === "tell") { lastTeller = sender ?? lastTeller; log(`${sender} tells you, "${text}"`, "c-tell", sender); }
        else if (k === "emote") log(text, "c-emote");
        else if (k === "channel") {
          const ch = Number(sub);
          const cls = ch === 2 ? "c-general" : ch === 3 ? "c-trade" : ch === 4 ? "c-lfg" : "c-allegiance";
          const name = ch === 2 ? "General" : ch === 3 ? "Trade" : ch === 4 ? "LFG" : ch === client!.allegianceChannel && ch ? "Allegiance" : `Ch${ch}`;
          log(`[${name}] ${sender}: ${text}`, cls, undefined);
        }
        else if (k === "system") log(text, n === 4 ? "c-outtell" : n === 0x14 || n === 0 ? "c-broadcast" : n === 6 || n === 0x15 || n === 0x16 ? "c-combat" : n === 7 || n === 0x11 ? "c-magic" : "c-system");
        else log(text, "c-system");
      },
      onError: (text) => log(text, "c-error"),
      onInventory: () => renderInventory(),
      onObjectPickedUp: (g) => netWorld?.remove(g),
      onObjectParented: (o) => netWorld?.attach(o),
      onCharacterList: showCharacters,
      onCharacterCreated: (result, _guid, name) => { loginStatus.textContent = result === "Ok" ? `created ${name}` : `create failed: ${result}`; },
      onEnterWorld: onEnterWorld,
      onObjectCreate: (o) => onObject(o),
      onObjectUpdate: (o) => { if (client && netWorld && player && o.guid !== client.playerGuid) netWorld.updateObject(o).then((e) => { if (e) e.root.userData.guid = o.guid; }); else onObject(o); },
      onObjectPosition: (o, u) => { if (o.guid === client!.playerGuid) { player?.setFromPosition(u.position); } else netWorld?.onPosition(o, u); },
      onObjectMotion: (o, m) => {
        if (o.guid === client!.playerGuid) return;
        if (client!.session?.debug) {
          const st = m.state;
          log(`motion ${o.name}: type=${m.type} stance=${m.stance.toString(16)}${st ? ` fwd=${MotionCommandNames[commandFromKey(st.forward)] ?? st.forward.toString(16)}x${st.forwardSpeed.toFixed(2)} side=${st.sidestep ? MotionCommandNames[commandFromKey(st.sidestep)] : "-"}x${st.sidestepSpeed.toFixed(2)} turn=${st.turn ? MotionCommandNames[commandFromKey(st.turn)] : "-"}x${st.turnSpeed.toFixed(2)} cmds=[${st.commands.map((c) => MotionCommandNames[commandFromKey(c.command)] ?? c.command.toString(16)).join(",")}]` : ""}${m.moveTo ? ` moveTo run=${m.moveTo.runRate}` : ""} model=${netWorld?.entities.get(o.guid)?.model ? "yes" : "no"}`, "debug");
        }
        netWorld?.onMotion(o, m);
      },
      onPlayerMotion: (m) => {
        if (!player) return;
        if (m.type === 9 && m.moveTo) player.faceHeading(m.moveTo.heading);
        if (m.type === 8 && m.moveTo) {
          const t = m.moveTo.target ? netWorld?.positionOf(m.moveTo.target) : null;
          if (t) player.faceTowards(t.x, t.y, m.moveTo.heading); else player.faceHeading(m.moveTo.heading);
        }
        // the server echoes our movement with RunForward at our run rate: adopt it so we move as fast as it allows
        if (m.state && m.state.forward && commandFromKey(m.state.forward) === 0x44000007 && m.state.forwardSpeed > 0 && m.state.forwardSpeed !== player.runRate) {
          player.runRate = m.state.forwardSpeed;
          log(`run rate ${player.runRate.toFixed(2)}`, "debug");
        }
      },
      onObjectDelete: (g) => netWorld?.remove(g),
      onPlayEffect: (o, sc, mod) => { if (o.guid === client!.playerGuid) player?.model?.playScript(sc, mod); else netWorld?.onPlayEffect(o, sc, mod); },
      onPlayScriptId: (o, id) => { if (o.guid === client!.playerGuid) player?.model?.playScriptId(id); else netWorld?.onPlayScriptId(o, id); },
      onAppearance: (o) => {
        if (o.guid === client!.playerGuid) {
          if (player && assets && streamer) AnimatedModel.create(assets, streamer.objects, o.setup, o.mtable, o.raw.objDesc).then((m) => { if (m && player) { if (player.model) { player.model.dispose(); player.root.remove(player.model.root); } if (particles) m.attachParticles(particles, o.petable); player.setModel(m); netWorld?.reattachChildren(o.guid); } });
        } else netWorld?.create(o).then((e) => { if (e) e.root.userData.guid = o.guid; });
      },
    });
    client.connect(host, port, account, password);
    if (new URLSearchParams(location.search).get("debug") === "1") {
      client.session!.debug = true;
      // post raw movement messages to the dev server (captures.log) so they can be decoded offline
      const queue: string[] = [];
      client.captureOpcodes = new Set([Opcode.Motion, Opcode.UpdatePosition, Opcode.ObjectCreate, Opcode.UpdateObject]);
      client.onCapture = (op, data, err) => {
        const hex = Array.from(data.subarray(0, 600), (b) => b.toString(16).padStart(2, "0")).join("");
        queue.push(`${Date.now()} ${op.toString(16)} ${err ? "ERR:" + err.replace(/\s+/g, "_") : "-"} ${hex}`);
      };
      setInterval(() => { if (queue.length) { const body = queue.splice(0).join("\n"); fetch("/capture", { method: "POST", body }).catch(() => {}); } }, 2000);
    }
    $<HTMLInputElement>("password").value = "";
  } catch (e) {
    loginStatus.textContent = `error: ${(e as Error).message}`;
    console.error(e);
  }
});

function showCharacters(list: CharacterList) {
  const box = $("chars");
  box.innerHTML = "";
  $("create").style.display = "block";
  if (!list.characters.length) {
    box.textContent = "This account has no characters yet — create one below.";
    ($("create") as HTMLDetailsElement).open = true;
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
  if (netWorld) netWorld.playerGuid = guid;
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
    const m = await AnimatedModel.create(assets!, streamer!.objects, me.setup, me.mtable, me.raw.objDesc);
    if (m) { if (particles) m.attachParticles(particles, me.petable); await player.setModel(m); netWorld!.reattachChildren(guid); }
  }
  log(`entered world as ${me?.name ?? guid.toString(16)}`);
  // objects that arrived before the player entry
  for (const o of client!.objects.values()) if (o.guid !== guid) netWorld!.create(o).then((e) => { if (e) e.root.userData.guid = o.guid; });
  renderInventory();
}

function onObject(o: WorldObject) {
  if (!client || !netWorld) return;
  if (o.guid === client.playerGuid) {
    if (player && o.position) player.setFromPosition(o.position);
    return;
  }
  if (player) netWorld.create(o).then((e) => { if (e) e.root.userData.guid = o.guid; });
}

$("chatin").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { (e.target as HTMLInputElement).blur(); return; }
  if (e.key !== "Enter") return;
  const inp = e.target as HTMLInputElement;
  const text = inp.value.trim();
  inp.value = "";
  if (text && client) sendChat(text);
  inp.blur();
});
let lastTeller: string | null = null;
function sendChat(text: string) {
  if (!client) return;
  // reply to the last person who sent us a tell
  if (/^\/r\b/i.test(text)) {
    const msg = text.replace(/^\/r\s*/i, "").trim();
    if (!lastTeller) { log("nobody has sent you a tell yet", "c-error"); return; }
    if (!msg) { log(`usage: /r message  (replies to ${lastTeller})`, "c-error"); return; }
    client.tell(lastTeller, msg);
    return;
  }
  const m = text.match(/^\/(\w+)\s*(.*)$/s);
  if (!m) {
    // plain text goes to the channel of the active tab, otherwise local say
    const ch = TAB_CHANNEL[activeTab];
    if (ch) { channelSay(ch, text); return; }
    client.say(text); log(`You say, "${text}"`, "c-you"); return;
  }
  const cmd = m[1].toLowerCase(), rest = m[2].trim();
  if (cmd === "tell" || cmd === "t") {
    // "/tell Name, message" or "/t Name message"
    let name: string, msg: string;
    if (rest.includes(",")) { name = rest.slice(0, rest.indexOf(",")).trim(); msg = rest.slice(rest.indexOf(",") + 1).trim(); }
    else { const i = rest.indexOf(" "); name = i < 0 ? rest : rest.slice(0, i); msg = i < 0 ? "" : rest.slice(i + 1).trim(); }
    if (!name || !msg) { log("usage: /tell Name, message", "c-error"); return; }
    client.tell(name, msg);
  } else if (cmd === "e" || cmd === "me" || cmd === "emote") { client.emote(rest); log(`${myName()} ${rest}`, "c-emote"); }
  else if (cmd === "s" || cmd === "say") { client.say(rest); log(`You say, "${rest}"`, "c-you"); }
  else if (cmd === "g" || cmd === "general") channelSay(2, rest);
  else if (cmd === "tr" || cmd === "trade") channelSay(3, rest);
  else if (cmd === "lfg") channelSay(4, rest);
  else if (cmd === "a" || cmd === "allegiance") { if (client.allegianceChannel) channelSay(client.allegianceChannel, rest); else log("you are not in an allegiance", "c-error"); }
  else if (cmd === "use") { if (targetGuid) client.use(targetGuid); }
  else if (cmd === "blink") blink();
  else if (cmd === "time") {
    if (sky) {
      const gt = sky.gameTime, tod = sky.timeOfDay;
      const names = gt.timesOfDay;
      let cur = names[0];
      for (const n of names) if (n.start <= tod) cur = n;
      const h = Math.floor(tod * 24), m = Math.floor((tod * 24 - h) * 60);
      log(`Dereth time ${h}:${m.toString().padStart(2, "0")} (${cur?.name ?? "?"}, day fraction ${tod.toFixed(3)}; a day is ${gt.dayLength} s real time)`, "c-system");
    }
  }
  else if (cmd === "fly") {
    if (player) {
      if (player.fly) { player.land(); log("fly off: back on the ground", "c-system"); }
      else { player.fly = true; log("fly on: R rises, F descends, /fly again to land. The server warns above 10 units over ground.", "c-system"); }
    }
  }
  else if (cmd === "fxspeed") { const v = parseFloat(rest); if (particles && v > 0 && v <= 4) { particles.timeScale = v; log(`particle effects run at ${v}x`, "c-system"); } else log(`usage: /fxspeed 0.5   (current ${particles?.timeScale ?? 1}x)`, "c-error"); }
  else if (cmd === "noclip" || cmd === "ghost") { if (player) { player.noclip = !player.noclip; log(`noclip ${player.noclip ? "on: walking through walls" : "off: walls are solid"}`, "c-system"); } }
  else if (cmd === "ls" || cmd === "lifestone") client.recall("lifestone");
  else if (cmd === "mp" || cmd === "marketplace") client.recall("marketplace");
  else if (cmd === "house") client.recall("house");
  else if (cmd === "mansion") client.recall("mansion");
  else if (cmd === "hom" || cmd === "hometown") client.recall("hometown");
  else if (cmd === "pkarena") client.recall("pkarena");
  else if (cmd === "pklarena") client.recall("pklarena");
  else if (cmd === "inv" || cmd === "i") toggleInventory();
  else log(`unknown command /${cmd}`, "c-error");
}
function channelSay(channel: number, text: string) {
  if (!client || !text) return;
  // the server echoes channel messages back to the sender, so no local echo here
  client.channelSay(channel, text);
}
function myName(): string {
  return client?.objects.get(client.playerGuid)?.name ?? "You";
}
addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement)?.tagName === "INPUT") return;
  if (!player) return;
  if (e.key === "Enter") { e.preventDefault(); $("chatin").focus(); }
  else if (e.code === "KeyI") toggleInventory();
  else if (e.code === "KeyU" && targetGuid && client) client.use(targetGuid);
  else if (e.key === "Escape") setTarget(null);
});

// ---------- targeting ----------
let targetGuid: number | null = null;
function setTarget(guid: number | null) {
  targetGuid = guid;
  const o = guid !== null ? client?.objects.get(guid) : null;
  $("target").classList.toggle("show", !!o);
  $("targetName").textContent = o ? `${o.name}` : "";
}
$("btnUse").addEventListener("click", () => { if (targetGuid && client) client.use(targetGuid); });
function blink() {
  if (!player || !streamer) return;
  if (player.blink()) { streamer.update(player.pos.x, player.pos.y); log("blinked one landblock ahead", "c-system"); }
  else log("terrain ahead is not loaded yet; try again in a moment", "c-error");
}
$("btnBlink").addEventListener("click", () => { blink(); (document.activeElement as HTMLElement | null)?.blur(); });
$("btnClear").addEventListener("click", () => setTarget(null));
$("btnGive").addEventListener("click", () => { toggleInventory(true); });
let downX = 0, downY = 0;
renderer.domElement.addEventListener("mousedown", (e: MouseEvent) => { downX = e.clientX; downY = e.clientY; });
renderer.domElement.addEventListener("click", (e: MouseEvent) => {
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4 || !netWorld) return; // a drag, not a click
  const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  const rc = new THREE.Raycaster();
  rc.setFromCamera(ndc, camera);
  const hits = rc.intersectObjects([...netWorld.entities.values()].map((en) => en.root), true);
  for (const h of hits) {
    let o: THREE.Object3D | null = h.object;
    while (o && o.userData.guid === undefined) o = o.parent;
    if (o) { setTarget(o.userData.guid as number); return; }
  }
  setTarget(null);
});

// ---------- inventory ----------
let invSelected: number | null = null;
const iconCache = new Map<number, Promise<string | null>>();
function icon(id: number): Promise<string | null> {
  let p = iconCache.get(id);
  if (!p) { p = assets ? iconDataUrl(assets, id) : Promise.resolve(null); iconCache.set(id, p); }
  return p;
}
function toggleInventory(show?: boolean) {
  const el = $("inv");
  el.classList.toggle("show", show ?? !el.classList.contains("show"));
  if (el.classList.contains("show")) renderInventory();
}
async function renderInventory() {
  if (!client || !$("inv").classList.contains("show")) return;
  const list = $("invList");
  const items = client.inventory().sort((a, b) => (a.wielder ? 0 : 1) - (b.wielder ? 0 : 1) || a.name.localeCompare(b.name));
  list.innerHTML = "";
  for (const o of items) {
    const row = document.createElement("div");
    row.className = "item" + (o.guid === invSelected ? " sel" : "");
    const img = document.createElement("img");
    img.alt = "";
    icon(o.icon).then((u) => { if (u) img.src = u; });
    const name = document.createElement("span");
    name.textContent = o.stackSize > 1 ? `${o.name} ×${o.stackSize}` : o.name;
    row.append(img, name);
    if (o.wielder) { const eq = document.createElement("span"); eq.className = "eq"; eq.textContent = "(worn)"; row.append(eq); }
    row.onclick = () => { invSelected = o.guid; renderInventory(); };
    row.ondblclick = () => client!.use(o.guid);
    list.appendChild(row);
  }
  if (!items.length) list.textContent = "(empty)";
}
$("invUse").addEventListener("click", () => { if (invSelected && client) client.use(invSelected); });
$("invDrop").addEventListener("click", () => { if (invSelected && client) client.drop(invSelected); });
$("invGive").addEventListener("click", () => {
  if (!client || !invSelected) return;
  if (!targetGuid) { log("select a target first (click an NPC)", "c-error"); return; }
  const item = client.objects.get(invSelected);
  client.give(targetGuid, invSelected, item?.stackSize ?? 1);
  log(`giving ${item?.name ?? "item"} to ${client.objects.get(targetGuid)?.name ?? "target"}...`, "c-system");
});

// ---------- frame loop ----------
let last = performance.now();
let fpsAvg = 60;
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
    if (streamer && streamer.envcells.cells.size) streamer.envcells.applyVisibility(camera.position, streamer.outdoor, streamer.playerBlock);
    const p = player.position();
    fpsAvg += (1 / Math.max(1e-3, dt) - fpsAvg) * 0.05;
    statusEl.textContent = `${client?.serverName ?? ""}  cell ${p.cell.toString(16).toUpperCase().padStart(8, "0")}  x ${p.x.toFixed(1)} y ${p.y.toFixed(1)} z ${p.z.toFixed(1)}  objects ${netWorld?.entities.size ?? 0}  ${fpsAvg.toFixed(0)} fps`;
  }
  netWorld?.update(dt);
  particles?.update(dt);
  camera.updateMatrixWorld();
  const s = client?.session;
  if (sky && s && s.serverTimeOffset) sky.timeOfDay = timeOfDayFromServerTime(s.clientTime + s.serverTimeOffset, sky.gameTime.dayLength, sky.gameTime.zeroTimeOfYear);
  if (sky) {
    sky.update(dt, camera);
    const L = sky.lighting;
    sunDir.copy(L.sunDir);
    // model lights: the sky's values suit the terrain shader (which scales them itself); three's
    // physically based lights divide by pi, and these factors keep a lit white texel just under 1
    sun.color.copy(L.sunColor); sun.intensity = L.sunIntensity * 0.75;
    sun.position.copy(L.sunDir).negate().multiplyScalar(100);
    ambient.color.copy(L.ambientColor); ambient.intensity = L.ambientIntensity * 0.5;
    // never let the fog end beyond the loaded terrain, or the void shows through
    const view = streamer ? streamer.viewDistance : 1400;
    const fogFar = Math.min(L.fogFar, view - 60);
    const fogNear = Math.min(L.fogNear, fogFar * 0.55);
    (scene.fog as THREE.Fog).color.copy(L.fogColor); (scene.fog as THREE.Fog).near = fogNear; (scene.fog as THREE.Fog).far = fogFar;
    streamer?.terrain.setLighting({ ...L, fogNear, fogFar });
  }
  streamer?.terrain.updateLight(camera, sunDir);
  renderer.clear();
  const outdoorsVisible = !streamer || streamer.outdoor.visible;
  if (sky && outdoorsVisible) sky.render(renderer);
  else if (!outdoorsVisible) { renderer.setClearColor(0x000000); renderer.clear(); }
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

(globalThis as unknown as { acweb: unknown }).acweb = {
  THREE, scene, camera, get sky() { return sky; }, get client() { return client; }, get player() { return player; }, get streamer() { return streamer; }, get netWorld() { return netWorld; }, get particles() { return particles; }, positionToWorld,
};
