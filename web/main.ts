import * as THREE from "three";
import { BlobSource, DatDatabase, HttpRangeSource, parseLandblock } from "../src/dat/mod.ts";
import { Assets } from "../src/render/assets.ts";
import { TerrainRenderer } from "../src/render/terrain.ts";
import { EnvCellRenderer, ObjectRenderer } from "../src/render/objects.ts";
import { FlyCamera } from "../src/render/camera.ts";
import { SkyRenderer } from "../src/render/sky.ts";
import { AnimatedModel } from "../src/render/animated.ts";
import { ParticleSystem } from "../src/render/particles.ts";
import { MotionCommandNames, MotionStanceNames } from "../src/dat/motionenums.ts";
import { BLOCK_LENGTH, landblockId } from "../src/world/terrain.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status");
const cellLabel = $("cell");
const log = (s: string) => { status.textContent = s; console.log(s); };

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb4c8);
scene.fog = new THREE.Fog(0x9fb4c8, 600, 1400);
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.5, 4000);
const fly = new FlyCamera(camera, renderer.domElement);
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

let assets: Assets | null = null;
let terrain: TerrainRenderer | null = null;
let objects: ObjectRenderer | null = null;
let envcells: EnvCellRenderer | null = null;
let sky: SkyRenderer | null = null;
const world = new THREE.Group();
scene.add(world);
const outdoor = new THREE.Group();
const indoor = new THREE.Group();
world.add(outdoor, indoor);
let insideCell: number | null = null;
const animated: AnimatedModel[] = [];
let particles: ParticleSystem | null = null;
let viewed: AnimatedModel | null = null;

async function openDats(): Promise<Assets> {
  const mode = $<HTMLSelectElement>("source").value;
  let portal: DatDatabase, cell: DatDatabase;
  if (mode === "http") {
    log("opening dats over HTTP...");
    [portal, cell] = await Promise.all([
      DatDatabase.open(await HttpRangeSource.open("/dat/client_portal.dat")),
      DatDatabase.open(await HttpRangeSource.open("/dat/client_cell_1.dat")),
    ]);
  } else {
    const pf = $<HTMLInputElement>("portalFile").files?.[0];
    const cf = $<HTMLInputElement>("cellFile").files?.[0];
    if (!pf || !cf) throw new Error("pick both client_portal.dat and client_cell_1.dat");
    log("reading dats from files...");
    [portal, cell] = await Promise.all([DatDatabase.open(new BlobSource(pf)), DatDatabase.open(new BlobSource(cf))]);
  }
  log(`portal ${portal.files.size} files, cell ${cell.files.size} files`);
  return new Assets(portal, cell);
}

async function load() {
  try {
    if (!assets) {
      assets = await openDats();
      terrain = new TerrainRenderer(assets, await assets.region());
      objects = new ObjectRenderer(assets);
      envcells = new EnvCellRenderer(assets, objects);
      sky = new SkyRenderer(assets, await assets.region());
      await sky.build();
      scene.background = null;
      renderer.autoClear = false;
    }
    world.clear();
    outdoor.clear();
    indoor.clear();
    world.add(outdoor, indoor);
    envcells!.cells.clear();
    const showScenery = $<HTMLInputElement>("scenery").checked;
    if (showScenery) await objects!.preloadScenes();
    const center = parseInt($<HTMLInputElement>("lb").value.replace(/^0x/i, "").slice(0, 4), 16);
    const radius = Number($<HTMLInputElement>("radius").value) || 0;
    const cx = center >> 8, cy = center & 0xff;
    const showObjects = $<HTMLInputElement>("objects").checked;
    const showInteriors = $<HTMLInputElement>("interiors").checked;
    let firstCell: THREE.Group | null = null;
    let cellCount = 0;
    const t0 = performance.now();
    let blocks = 0, objs = 0;
    const jobs: Promise<void>[] = [];
    for (let x = cx - radius; x <= cx + radius; x++) {
      for (let y = cy - radius; y <= cy + radius; y++) {
        if (x < 0 || y < 0 || x > 0xfe || y > 0xfe) continue;
        const id = landblockId(x, y);
        jobs.push((async () => {
          // Dungeon landblocks carry a dummy terrain block; the client never draws it.
          const dungeon = await objects!.isDungeon(id);
          const mesh = dungeon ? null : await terrain!.landblock(id);
          if (!mesh && !dungeon) return;
          if (mesh) outdoor.add(mesh);
          blocks++;
          if (showObjects) {
            const g = await objects!.landblockObjects(id);
            objs += g.children.length;
            outdoor.add(g);
          }
          if (showInteriors) {
            const r = await envcells!.landblockCells(id);
            cellCount += r.count;
            if (id === landblockId(cx, cy) && r.first) firstCell = r.first;
            indoor.add(r.group);
          }
          if (showScenery && !dungeon) {
            const geo = terrain!.geometries.get(id);
            if (geo) {
              const g = await objects!.scenery(id, geo);
              objs += g.children.reduce((n: number, c: THREE.Object3D) => n + ((c as THREE.InstancedMesh).count ?? 1), 0);
              outdoor.add(g);
            }
          }
          log(`loaded ${blocks} landblocks, ${objs} objects... ${(performance.now() - t0).toFixed(0)} ms`);
        })());
      }
    }
    await Promise.all(jobs);
    // place camera above the center block
    const lb = await assets.cell.get(landblockId(cx, cy), parseLandblock);
    const region = await assets.region();
    const zc = lb ? region.landDefs.landHeightTable[lb.height[4 * 9 + 4]] : 0;
    const isDungeon = (await objects!.isDungeon(landblockId(cx, cy))) && firstCell;
    if (isDungeon && firstCell) {
      // dungeon: start inside the first cell
      firstCell.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(firstCell);
      const center = box.getCenter(new THREE.Vector3());
      camera.position.set(center.x, center.y, box.min.z + 1.8);
      fly.yaw = 0; fly.pitch = 0;
    } else {
      camera.position.set(cx * BLOCK_LENGTH + 96, cy * BLOCK_LENGTH - 60, zc + 60);
      fly.lookAt(new THREE.Vector3(cx * BLOCK_LENGTH + 96, cy * BLOCK_LENGTH + 96, zc));
    }
    log(`${blocks} landblocks, ${objs} objects, ${cellCount} cells in ${(performance.now() - t0).toFixed(0)} ms`);
  } catch (e) {
    log(`error: ${(e as Error).message}`);
    console.error(e);
  }
}

$("go").addEventListener("click", load);
$<HTMLSelectElement>("weather").addEventListener("change", async (e: Event) => { const sk = sky as SkyRenderer | null; if (sk) await sk.setWeather((e.target as HTMLSelectElement).value); });

/** Model viewer: show one animated Setup at the origin and list its motions. */
async function viewModel() {
  try {
    if (!assets) {
      assets = await openDats();
      terrain = new TerrainRenderer(assets, await assets.region());
      objects = new ObjectRenderer(assets);
      envcells = new EnvCellRenderer(assets, objects);
    }
    world.clear();
    for (const old of animated) old.dispose(); // stop their particle emitters and scripts
    animated.length = 0;
    envcells!.cells.clear();
    // "setup" or "setup:motiontable" (creatures whose motion table comes from the server, e.g. 02000001:09000001)
    const [idText, mtText] = $<HTMLInputElement>("model").value.split(":");
    const id = parseInt(idText.replace(/^0x/i, ""), 16);
    const m = await AnimatedModel.create(assets, objects!, id, mtText ? parseInt(mtText.replace(/^0x/i, ""), 16) : 0);
    if (m) { if (!particles) { particles = new ParticleSystem(assets, objects!); scene.add(particles.group); } m.attachParticles(particles); }
    if (!m) { log(`no setup ${id.toString(16)}`); return; }
    viewed = m;
    animated.push(m);
    world.add(m.root);
    const grid = new THREE.GridHelper(20, 20, 0x666666, 0x333333);
    grid.rotation.x = Math.PI / 2;
    world.add(grid);
    const sel = $<HTMLSelectElement>("motion");
    sel.innerHTML = "";
    for (const mo of m.motions()) {
      const opt = document.createElement("option");
      opt.value = `${mo.stance}:${mo.command}`;
      opt.textContent = `${MotionStanceNames[mo.stance] ?? mo.stance.toString(16)} / ${MotionCommandNames[mo.command] ?? mo.command.toString(16)}`;
      sel.appendChild(opt);
    }
    const r = Math.max(2, m.setup.radius * 2.5, m.setup.height * 1.5);
    camera.position.set(r, -r, m.setup.height * 0.6 + r * 0.4);
    fly.lookAt(new THREE.Vector3(0, 0, m.setup.height * 0.5));
    log(`setup ${id.toString(16)}: ${m.parts.length} parts, ${m.motions().length} motions, motion table ${m.motionTable ? m.motionTable.id.toString(16) : "none"}`);
  } catch (e) {
    log(`error: ${(e as Error).message}`);
    console.error(e);
  }
}
$("viewModel").addEventListener("click", viewModel);
$("play").addEventListener("click", async () => {
  if (!viewed) return;
  const [stance, command] = $<HTMLSelectElement>("motion").value.split(":").map(Number);
  const ok = await viewed.playMotion(command, stance);
  log(`play ${MotionCommandNames[command]}: ${ok ? "ok" : "no animation"}; ${viewed.sequence.nodes.length} segments`);
});
$<HTMLSelectElement>("source").addEventListener("change", (e) => {
  $("files").classList.toggle("show", (e.target as HTMLSelectElement).value === "files");
  assets = null;
});
$<HTMLInputElement>("wire").addEventListener("change", (e) => {
  const on = (e.target as HTMLInputElement).checked;
  world.traverse((o: THREE.Object3D) => {
    const m = (o as THREE.Mesh).material as THREE.Material | undefined;
    if (m && "wireframe" in m) (m as THREE.MeshLambertMaterial).wireframe = on;
  });
});

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fly.update(dt);
  for (const m of animated) m.update(dt);
  particles?.update(dt);
  if (envcells && envcells.cells.size > 0) {
    const cur = envcells.applyVisibility(camera.position, outdoor);
    const id = cur ? cur.id : null;
    if (id !== insideCell) {
      insideCell = id;
      const dark = cur !== null && !outdoor.visible;
      scene.background = dark ? new THREE.Color(0x000000) : new THREE.Color(0x9fb4c8);
      scene.fog = dark ? null : new THREE.Fog(0x9fb4c8, 600, 1400);
      cellLabel.textContent = cur ? `cell ${cur.id.toString(16).toUpperCase().padStart(8, "0")}` : "";
    }
  }
  camera.updateMatrixWorld();
  if (sky) {
    sky.timeOfDay = Number($<HTMLInputElement>("tod").value) / 1000;
    sky.update(dt, camera);
    const L = sky.lighting;
    sunDir.copy(L.sunDir);
    sun.color.copy(L.sunColor); sun.intensity = L.sunIntensity;
    sun.position.copy(L.sunDir).negate().multiplyScalar(100);
    ambient.color.copy(L.ambientColor); ambient.intensity = L.ambientIntensity;
    if (scene.fog) { (scene.fog as THREE.Fog).color.copy(L.fogColor); (scene.fog as THREE.Fog).near = L.fogNear; (scene.fog as THREE.Fog).far = L.fogFar; }
    terrain?.setLighting(L);
  }
  terrain?.updateLight(camera, sunDir);
  renderer.clear();
  if (sky && world.children.length && (insideCell === null || (scene.fog !== null))) sky.render(renderer);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// debugging handles
(globalThis as unknown as { acweb: unknown }).acweb = { THREE, scene, world, camera, fly, get assets() { return assets; }, get terrain() { return terrain; }, get objects() { return objects; }, load, viewModel, animated, get particles() { return particles; } };

if (new URLSearchParams(location.search).get("auto") === "1") load();
