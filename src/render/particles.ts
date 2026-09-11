/**
 * Particle emitters driven by animation hooks and physics scripts, ported
 * from ACE.Server.Physics ParticleEmitter/Particle. Particles are drawn as
 * camera-facing sprites textured with the emitter's hardware GfxObj.
 */
import * as THREE from "three";
import type { Assets } from "./assets.ts";
import { parseParticleEmitterInfo, parsePhysicsScript, parsePhysicsScriptTable, selectScript, SurfaceFlags } from "../dat/mod.ts";
import type { AnimationHook, Frame, ParticleEmitterInfo } from "../dat/mod.ts";
import { HookType } from "../dat/records/animation.ts";

const rnd = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

interface Particle {
  active: boolean;
  birth: number;
  lifespan: number;
  startFrame: { pos: THREE.Vector3; quat: THREE.Quaternion };
  offset: THREE.Vector3;
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  sprite: THREE.Sprite;
}

interface Emitter {
  id: string;
  info: ParticleEmitterInfo;
  parent: THREE.Object3D; // model root or part
  offset: Frame;
  particles: Particle[];
  dims: THREE.Vector2;
  created: number;
  lastEmit: number;
  emitted: number;
  stopped: boolean;
  group: THREE.Group;
}

export interface ParticleHost {
  /** model root (world placement) */
  root: THREE.Object3D;
  /** part objects by index, if the model has parts */
  parts?: THREE.Object3D[];
}

/** Sprite appearance for an emitter's hardware GfxObj, cached per gfxobj id. */
interface SpriteLook {
  material: THREE.SpriteMaterial;
  dims: THREE.Vector2;
}

export class ParticleSystem {
  readonly group = new THREE.Group();
  private emitters = new Map<string, Emitter>();
  private nextId = 1000000;
  private looks = new Map<number, Promise<SpriteLook | null>>();
  private infos = new Map<number, Promise<ParticleEmitterInfo | null>>();
  private pendingScripts: { due: number; hook: AnimationHook; host: ParticleHost }[] = [];
  private now = 0;

  constructor(private assets: Assets) {
    this.group.name = "particles";
  }

  private look(gfxObjId: number): Promise<SpriteLook | null> {
    let p = this.looks.get(gfxObjId);
    if (!p) {
      p = (async () => {
        const g = await this.assets.gfxObj(gfxObjId);
        if (!g || !g.surfaces.length) return null;
        const s = await this.assets.surface(g.surfaces[0]);
        const mat = new THREE.SpriteMaterial({ depthWrite: false, transparent: true, fog: false });
        if (s && s.type & (SurfaceFlags.Base1Image | SurfaceFlags.Base1ClipMap)) {
          const tex = await this.assets.threeTexture(s.origTextureId, (s.type & SurfaceFlags.Base1ClipMap) !== 0, s.origPaletteId, undefined, true);
          if (tex) mat.map = tex;
          if (s.type & SurfaceFlags.Additive) mat.blending = THREE.AdditiveBlending;
          if (s.type & SurfaceFlags.Base1ClipMap) mat.alphaTest = 0.3;
        } else if (s) {
          mat.color.setRGB(((s.colorValue >>> 16) & 0xff) / 255, ((s.colorValue >>> 8) & 0xff) / 255, (s.colorValue & 0xff) / 255, THREE.SRGBColorSpace);
        }
        // sprite size from the mesh bounds (ACViewer uses 1.8x the X/Z extent)
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const v of g.vertexArray.vertices.values()) {
          minX = Math.min(minX, v.origin.x); maxX = Math.max(maxX, v.origin.x);
          minZ = Math.min(minZ, v.origin.z); maxZ = Math.max(maxZ, v.origin.z);
        }
        const w = Number.isFinite(maxX - minX) ? (maxX - minX) : 0.5, h = Number.isFinite(maxZ - minZ) ? (maxZ - minZ) : 0.5;
        return { material: mat, dims: new THREE.Vector2(Math.max(0.05, w) * 1.8, Math.max(0.05, h) * 1.8) };
      })();
      this.looks.set(gfxObjId, p);
    }
    return p;
  }

  private info(id: number): Promise<ParticleEmitterInfo | null> {
    let p = this.infos.get(id);
    if (!p) { p = this.assets.portal.get(id, parseParticleEmitterInfo); this.infos.set(id, p); }
    return p;
  }

  /** Run an animation/script hook against a host model. */
  async handleHook(host: ParticleHost, hook: AnimationHook) {
    const d = hook.data;
    switch (hook.type) {
      case HookType.CreateParticle:
      case HookType.CreateBlockingParticle: {
        const id = d.emitterId as number;
        if (hook.type === HookType.CreateBlockingParticle && id && this.emitters.has(this.key(host, id))) return;
        await this.create(host, d.emitterInfoId as number, d.partIndex as number, d.offset as Frame, id);
        break;
      }
      case HookType.DestroyParticle: this.destroy(host, d.emitterId as number); break;
      case HookType.StopParticle: { const e = this.emitters.get(this.key(host, d.emitterId as number)); if (e) e.stopped = true; break; }
      default: break;
    }
  }

  private key(host: ParticleHost, emitterId: number): string {
    // emitter ids are per object; fold the host identity in
    return `${host.root.id}:${emitterId >>> 0}`;
  }

  async create(host: ParticleHost, infoId: number, partIndex: number, offset: Frame, emitterId: number): Promise<void> {
    const info = await this.info(infoId);
    if (!info || !info.hwGfxObjId) return;
    const look = await this.look(info.hwGfxObjId);
    if (!look) return;
    const key = emitterId ? this.key(host, emitterId) : `anon:${this.nextId++}`;
    this.destroyKey(key);
    const parent = (partIndex >= 0 && host.parts && host.parts[partIndex]) ? host.parts[partIndex] : host.root;
    const group = new THREE.Group();
    this.group.add(group);
    const particles: Particle[] = [];
    for (let i = 0; i < info.maxParticles; i++) {
      const sprite = new THREE.Sprite(look.material.clone());
      sprite.visible = false;
      group.add(sprite);
      particles.push({
        active: false, birth: 0, lifespan: 1, startFrame: { pos: new THREE.Vector3(), quat: new THREE.Quaternion() },
        offset: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), sprite,
      });
    }
    const e: Emitter = { id: key, info, parent, offset, particles, dims: look.dims, created: this.now, lastEmit: this.now, emitted: 0, stopped: false, group };
    this.emitters.set(key, e);
    const burst = info.initialParticles > 0 ? info.initialParticles : (info.birthrate <= 0 ? info.totalParticles : 0);
    for (let i = 0; i < burst; i++) this.emit(e);
  }

  destroy(host: ParticleHost, emitterId: number) {
    if (emitterId) this.destroyKey(this.key(host, emitterId));
  }
  private destroyKey(key: string) {
    const e = this.emitters.get(key);
    if (!e) return;
    this.group.remove(e.group);
    for (const p of e.particles) (p.sprite.material as THREE.Material).dispose();
    this.emitters.delete(key);
  }

  /** Remove every emitter belonging to a host (object deleted). */
  destroyHost(host: ParticleHost) {
    for (const [k, e] of this.emitters) {
      let o: THREE.Object3D | null = e.parent;
      while (o && o !== host.root) o = o.parent;
      if (o === host.root) this.destroyKey(k);
    }
  }

  /** Play a PlayScript (from a PlayEffect message) using the object's physics script table. */
  async playScript(host: ParticleHost, scriptTableId: number, playScript: number, mod: number) {
    if (!scriptTableId) return;
    const table = await this.assets.portal.get(scriptTableId, parsePhysicsScriptTable);
    if (!table) return;
    const scriptId = selectScript(table, playScript, mod);
    if (scriptId) await this.playScriptId(host, scriptId);
  }

  /** Play a physics script (0x33) directly. */
  async playScriptId(host: ParticleHost, scriptId: number) {
    const script = await this.assets.portal.get(scriptId, parsePhysicsScript);
    if (!script) return;
    for (const d of script.data) this.pendingScripts.push({ due: this.now + d.startTime, hook: d.hook, host });
  }

  private emit(e: Emitter) {
    const slot = e.particles.find((p) => !p.active);
    if (!slot) return;
    const info = e.info;
    // parent frame in world space
    e.parent.getWorldPosition(slot.startFrame.pos);
    e.parent.getWorldQuaternion(slot.startFrame.quat);
    const rot = (v: THREE.Vector3) => v.applyQuaternion(slot.startFrame.quat);
    // random offset perpendicular to OffsetDir
    const rng = new THREE.Vector3(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1));
    const dir = new THREE.Vector3(info.offsetDir.x, info.offsetDir.y, info.offsetDir.z);
    let off = rng.sub(dir.clone().multiplyScalar(dir.dot(rng)));
    if (off.lengthSq() < 1e-8) off = new THREE.Vector3();
    else off.normalize().multiplyScalar(((info.maxOffset - info.minOffset) + info.minOffset) * Math.random());
    const base = new THREE.Vector3(e.offset.origin.x, e.offset.origin.y, e.offset.origin.z).add(off);
    slot.offset.copy(rot(base));
    const mag = (lo: number, hi: number) => (hi - lo) * Math.random() + lo;
    const av = new THREE.Vector3(info.a.x, info.a.y, info.a.z).multiplyScalar(mag(info.minA, info.maxA));
    const bv = new THREE.Vector3(info.b.x, info.b.y, info.b.z).multiplyScalar(mag(info.minB, info.maxB));
    const cv = new THREE.Vector3(info.c.x, info.c.y, info.c.z).multiplyScalar(mag(info.minC, info.maxC));
    slot.a.set(0, 0, 0); slot.b.set(0, 0, 0); slot.c.set(0, 0, 0);
    switch (info.particleType) {
      case 2: slot.a.copy(rot(av)); break; // LocalVelocity
      case 3: slot.b.copy(rot(bv)); break; // ParabolicLVGA
      case 4: slot.c.copy(rot(cv)); break;
      case 5: slot.a.copy(rot(av)); slot.b.copy(bv); slot.c.copy(cv); break; // Swarm
      case 6: { // Explode: random direction scaled by c
        slot.a.copy(av); slot.b.copy(bv);
        const ra = rnd(-Math.PI, Math.PI), po = rnd(-Math.PI, Math.PI), rb = Math.cos(po);
        slot.c.set(Math.cos(ra) * cv.x * rb, Math.sin(ra) * cv.y * rb, Math.sin(po) * cv.z * rb);
        if (slot.c.lengthSq() < 1e-8) slot.c.set(0, 0, 0); else slot.c.normalize();
        break;
      }
      case 7: slot.a.copy(av); slot.b.copy(bv); slot.offset.multiply(cv); slot.c.copy(slot.offset); break; // Implode
      case 8: slot.a.copy(rot(av)); slot.b.copy(rot(bv)); break; // ParabolicLVLA
      case 9: slot.c.copy(rot(cv)); break;
      case 10: slot.b.copy(bv); break; // ParabolicGVGA
      case 11: slot.c.copy(cv); break;
      case 12: slot.a.copy(av); break; // GlobalVelocity
      default: slot.a.copy(av); slot.b.copy(bv); slot.c.copy(cv);
    }
    slot.active = true;
    slot.birth = this.now;
    slot.lifespan = Math.max(0.05, info.lifespan + Math.random() * info.lifespanRand);
    slot.sprite.visible = true;
    e.lastEmit = this.now;
    e.emitted++;
  }

  update(dt: number) {
    this.now += dt;
    // timed script hooks
    if (this.pendingScripts.length) {
      const due = this.pendingScripts.filter((p) => p.due <= this.now);
      if (due.length) {
        this.pendingScripts = this.pendingScripts.filter((p) => p.due > this.now);
        for (const p of due) this.handleHook(p.host, p.hook);
      }
    }
    const parentPos = new THREE.Vector3();
    for (const [key, e] of this.emitters) {
      const info = e.info;
      // emission
      if (!e.stopped) {
        const capped = info.totalParticles > 0 && e.emitted >= info.totalParticles;
        const live = e.particles.filter((p) => p.active).length;
        if (!capped && live < info.maxParticles && info.emitterType === 1 && info.birthrate > 0 && this.now - e.lastEmit > info.birthrate) this.emit(e);
        if ((info.totalSeconds > 0 && e.created + info.totalSeconds < this.now) || capped) e.stopped = true;
      }
      // particles
      let anyAlive = false;
      if (info.isParentLocal) e.parent.getWorldPosition(parentPos);
      for (const p of e.particles) {
        if (!p.active) continue;
        const t = this.now - p.birth;
        if (t >= p.lifespan) { p.active = false; p.sprite.visible = false; continue; }
        anyAlive = true;
        const origin = info.isParentLocal ? parentPos : p.startFrame.pos;
        const pos = p.sprite.position;
        switch (info.particleType) {
          case 1: pos.copy(origin).add(p.offset); break;
          case 2: case 12: pos.copy(p.a).multiplyScalar(t).add(origin).add(p.offset); break;
          case 3: case 8: case 10: case 4: case 9: case 11:
            pos.copy(p.b).multiplyScalar(t * t / 2).addScaledVector(p.a, t).add(origin).add(p.offset); break;
          case 5: {
            // Swarm: orbit of radius C around the (rising) centre. ACE adds C instead of
            // scaling by it, which puts the orbit off-centre; the data (c = 1,1,0) reads as a radius.
            const sw = p.a.clone().multiplyScalar(t).add(origin).add(p.offset);
            pos.set(Math.cos(t * p.b.x) * p.c.x + sw.x, Math.sin(t * p.b.y) * p.c.y + sw.y, Math.cos(t * p.b.z) * p.c.z + sw.z);
            break;
          }
          case 6: pos.copy(p.b).multiplyScalar(t).addScaledVector(p.c, p.a.x).multiplyScalar(t).add(p.offset).add(origin); break;
          case 7: pos.copy(p.c).multiplyScalar(Math.cos(p.a.x * t)).addScaledVector(p.b, t * t).add(origin).add(p.offset); break;
          default: pos.copy(origin).add(p.offset);
        }
        const k = Math.min(1, t / p.lifespan);
        const scale = info.startScale + (info.finalScale - info.startScale) * k;
        const trans = info.startTrans + (info.finalTrans - info.startTrans) * k;
        p.sprite.scale.set(e.dims.x * scale, e.dims.y * scale, 1);
        (p.sprite.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - trans);
      }
      if (e.stopped && !anyAlive) this.destroyKey(key);
    }
  }
}
