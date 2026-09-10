import * as THREE from "three";
import { BlobSource, DatDatabase, HttpRangeSource, parseLandblock } from "../src/dat/mod.ts";
import { Assets } from "../src/render/assets.ts";
import { TerrainRenderer } from "../src/render/terrain.ts";
import { ObjectRenderer } from "../src/render/objects.ts";
import { FlyCamera } from "../src/render/camera.ts";
import { BLOCK_LENGTH, landblockId } from "../src/world/terrain.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status");
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
scene.add(sun, new THREE.AmbientLight(0xffffff, 0.9));

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

let assets: Assets | null = null;
let terrain: TerrainRenderer | null = null;
let objects: ObjectRenderer | null = null;
const world = new THREE.Group();
scene.add(world);

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
    }
    world.clear();
    const showScenery = $<HTMLInputElement>("scenery").checked;
    if (showScenery) await objects!.preloadScenes();
    const center = parseInt($<HTMLInputElement>("lb").value.replace(/^0x/i, "").slice(0, 4), 16);
    const radius = Number($<HTMLInputElement>("radius").value) || 0;
    const cx = center >> 8, cy = center & 0xff;
    const showObjects = $<HTMLInputElement>("objects").checked;
    const t0 = performance.now();
    let blocks = 0, objs = 0;
    const jobs: Promise<void>[] = [];
    for (let x = cx - radius; x <= cx + radius; x++) {
      for (let y = cy - radius; y <= cy + radius; y++) {
        if (x < 0 || y < 0 || x > 0xfe || y > 0xfe) continue;
        const id = landblockId(x, y);
        jobs.push((async () => {
          const mesh = await terrain!.landblock(id);
          if (!mesh) return;
          world.add(mesh);
          blocks++;
          if (showObjects) {
            const g = await objects!.landblockObjects(id);
            objs += g.children.length;
            world.add(g);
          }
          if (showScenery) {
            const geo = terrain!.geometries.get(id);
            if (geo) {
              const g = await objects!.scenery(id, geo);
              objs += g.children.reduce((n: number, c: THREE.Object3D) => n + ((c as THREE.InstancedMesh).count ?? 1), 0);
              world.add(g);
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
    camera.position.set(cx * BLOCK_LENGTH + 96, cy * BLOCK_LENGTH - 60, zc + 60);
    fly.lookAt(new THREE.Vector3(cx * BLOCK_LENGTH + 96, cy * BLOCK_LENGTH + 96, zc));
    log(`${blocks} landblocks, ${objs} objects in ${(performance.now() - t0).toFixed(0)} ms`);
  } catch (e) {
    log(`error: ${(e as Error).message}`);
    console.error(e);
  }
}

$("go").addEventListener("click", load);
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
  camera.updateMatrixWorld();
  terrain?.updateLight(camera, sunDir);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// debugging handles
(globalThis as unknown as { acweb: unknown }).acweb = { scene, world, camera, fly, get assets() { return assets; }, get terrain() { return terrain; }, get objects() { return objects; }, load };

if (new URLSearchParams(location.search).get("auto") === "1") load();
