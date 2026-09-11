import type { ParticleSystem } from "./particles.ts";
import { motionKey } from "../dat/motionenums.ts";
/**
 * An animated Setup instance: one Object3D per part, driven by an AnimSequence
 * and a MotionTable. Part transforms are object-space (AC PartArray semantics).
 */
import * as THREE from "three";
import type { AppearanceChanges, Assets } from "./assets.ts";
import type { ObjDesc } from "../net/messages.ts";
import type { ObjectRenderer } from "./objects.ts";
import { parseAnimation, parseMotionTable, Placement, hex } from "../dat/mod.ts";
import type { Animation, MotionTable, Setup } from "../dat/mod.ts";
import { AnimSequence, defaultMotion, motionSegments } from "../world/animation.ts";
import { commandFromKey, MotionStance, stanceFromKey } from "../dat/motionenums.ts";

export class AnimatedModel {
  readonly root = new THREE.Group();
  readonly parts: THREE.Object3D[] = [];
  readonly sequence = new AnimSequence();
  motionTable: MotionTable | null = null;
  stance: number = MotionStance.NonCombat;
  currentMotion = 0;
  /** physics script table override from the server's PhysicsDesc (petable) */
  scriptTable = 0;
  private particleSystem: ParticleSystem | null = null;
  private animCache = new Map<number, Animation | null>();

  private constructor(private assets: Assets, readonly setup: Setup) {}

  static async create(assets: Assets, objects: ObjectRenderer, setupId: number, motionTableId = 0, objDesc?: ObjDesc): Promise<AnimatedModel | null> {
    const setup = await assets.setup(setupId);
    if (!setup) return null;
    const m = new AnimatedModel(assets, setup);
    m.root.name = `anim_${hex(setupId)}`;
    // appearance: palette (skin/dye), per-part texture swaps, per-part mesh replacements (clothing, hair)
    const palette = objDesc ? await assets.objectPalette(objDesc.paletteId, objDesc.subPalettes) : null;
    const partMesh = new Map<number, number>();
    const partTex = new Map<number, Map<number, number>>();
    if (objDesc) {
      for (const c of objDesc.animPartChanges) partMesh.set(c.index, c.animId);
      for (const t of objDesc.textureChanges) {
        let m2 = partTex.get(t.part);
        if (!m2) partTex.set(t.part, m2 = new Map());
        m2.set(t.oldTex, t.newTex);
      }
    }
    for (let i = 0; i < setup.parts.length; i++) {
      const gfxId = partMesh.get(i) ?? setup.parts[i];
      const tex = partTex.get(i);
      let changes: AppearanceChanges | null = null;
      if (palette || tex) {
        const texKey = tex ? [...tex.entries()].map(([a, b]) => `${a}>${b}`).join(",") : "";
        changes = { key: `${palette?.key ?? ""}|${texKey}`, textureChanges: tex ?? new Map(), palette };
      }
      const tmpl = await objects.gfxObjVariant(gfxId, changes);
      const part = tmpl ? tmpl.clone() : new THREE.Group();
      const s = setup.defaultScale[i];
      if (s) part.scale.set(s.x, s.y, s.z);
      m.parts.push(part);
      m.root.add(part);
    }
    const placement = setup.placementFrames.get(Placement.Resting) ?? setup.placementFrames.get(Placement.Default) ??
      setup.placementFrames.values().next().value ?? null;
    m.sequence.placement = placement;
    m.scriptTable = setup.defaultScriptTable;
    const mtableId = motionTableId || setup.defaultMotionTable;
    if (mtableId) {
      m.motionTable = await assets.portal.get(mtableId, parseMotionTable);
      if (m.motionTable) {
        m.stance = m.motionTable.defaultStyle;
        const idle = defaultMotion(m.motionTable, m.stance);
        if (idle !== null) await m.playMotion(idle);
      }
    } else if (setup.defaultAnimation) {
      const anim = await m.animation(setup.defaultAnimation);
      if (anim) m.sequence.append(anim, { animId: anim.id, lowFrame: 0, highFrame: -1, framerate: 30 });
    }
    m.apply();
    return m;
  }

  private async animation(id: number): Promise<Animation | null> {
    if (!this.animCache.has(id)) this.animCache.set(id, await this.assets.portal.get(id, parseAnimation));
    return this.animCache.get(id)!;
  }

  /** Available (stance, command) pairs from the motion table's cycles and links. */
  motions(): { stance: number; command: number }[] {
    const out = new Map<string, { stance: number; command: number }>();
    if (!this.motionTable) return [];
    for (const key of this.motionTable.cycles.keys()) {
      const stance = stanceFromKey(key), command = commandFromKey(key);
      out.set(`${stance}:${command}`, { stance, command });
    }
    for (const [from, link] of this.motionTable.links) {
      const stance = stanceFromKey(from);
      for (const command of link.keys()) out.set(`${stance}:${command}`, { stance, command });
    }
    return [...out.values()];
  }

  private velocityCache = new Map<number, Promise<[number, number, number]>>();

  /** Displacement per second (object space, +Y forward) produced by a motion's cycle at speed 1. */
  cycleVelocity(command: number, stance = this.stance): Promise<[number, number, number]> {
    const key = ((stance & 0xffff) << 16 | (command & 0xffff)) >>> 0;
    let p = this.velocityCache.get(key);
    if (!p) { p = this.computeCycleVelocity(command, stance); this.velocityCache.set(key, p); }
    return p;
  }

  private async computeCycleVelocity(command: number, stance: number): Promise<[number, number, number]> {
    if (!this.motionTable) return [0, 0, 0];
    const md = this.motionTable.cycles.get(motionKey(stance, command));
    if (!md) return [0, 0, 0];
    if (md.velocity) return [md.velocity.x, md.velocity.y, md.velocity.z];
    let x = 0, y = 0, z = 0, seconds = 0;
    for (const d of md.anims) {
      const anim = await this.animation(d.animId);
      if (!anim || anim.posFrames.length === 0) continue;
      const lo = d.lowFrame, hi = d.highFrame === -1 ? anim.numFrames - 1 : d.highFrame;
      const sign = d.framerate < 0 ? -1 : 1; // a reversed cycle moves the other way
      for (let i = lo; i <= hi && i < anim.posFrames.length; i++) {
        x += sign * anim.posFrames[i].origin.x; y += sign * anim.posFrames[i].origin.y; z += sign * anim.posFrames[i].origin.z;
      }
      seconds += (hi - lo + 1) / Math.abs(d.framerate || 30);
    }
    if (seconds === 0) return [0, 0, 0];
    return [x / seconds, y / seconds, z / seconds];
  }

  /** Rotation rate about +Z (radians per second) of a motion's cycle at speed 1 (e.g. TurnRight). */
  cycleOmega(command: number, stance = this.stance): number {
    const md = this.motionTable?.cycles.get(motionKey(stance, command));
    return md?.omega ? md.omega.z : 0;
  }

  /** Base framerates multiplied by this factor (server ForwardSpeed etc.) */
  motionSpeed = 1;

  /**
   * Play a motion: transition animations from the current motion, then loop its cycle.
   * `speed` scales playback (server ForwardSpeed; negative plays the cycle backwards).
   * Action commands (spell power-ups, emotes) play their transition once and return to the
   * current cycle, as in ACE MotionTable.GetObjectSequence.
   */
  async playMotion(command: number, stance = this.stance, speed = 1): Promise<boolean> {
    if (!this.motionTable) return false;
    const isAction = (command & 0x10000000) !== 0 && (command & 0x40000000) === 0;
    if (!isAction && command === this.currentMotion && stance === this.stance && this.sequence.nodes.length > 0) {
      if (speed !== this.motionSpeed) { this.motionSpeed = speed; this.sequence.setCycleSpeed(speed); }
      return true;
    }
    const base = isAction ? this.currentMotion : command;
    const { link, cycle } = motionSegments(this.motionTable, stance, isAction ? command : command, this.currentMotion);
    const cyc = isAction ? (this.motionTable.cycles.get(motionKey(stance, base))?.anims ?? []) : cycle;
    if (link.length === 0 && cyc.length === 0) return false;
    this.sequence.clear();
    for (const d of link) {
      const anim = await this.animation(d.animId);
      if (anim) this.sequence.append(anim, d, speed);
    }
    this.sequence.markCyclicStart();
    const cycleSpeed = isAction ? this.motionSpeed : speed;
    for (const d of cyc) {
      const anim = await this.animation(d.animId);
      if (anim) this.sequence.append(anim, d, cycleSpeed);
    }
    if (cyc.length === 0) this.sequence.firstCyclic = this.sequence.nodes.length - 1; // hold last transition frame
    this.stance = stance;
    this.currentMotion = base;
    if (!isAction) this.motionSpeed = speed;
    return true;
  }

  /** Route animation hooks (CreateParticle etc.) to a particle system. */
  attachParticles(ps: ParticleSystem, scriptTable = 0) {
    this.particleSystem = ps;
    if (scriptTable) this.scriptTable = scriptTable;
    this.sequence.onHooks = (hooks) => { for (const h of hooks) ps.handleHook(this, h); };
    // the Setup's own default script (portal swirls, torch flames, fountains) starts with the object
    if (this.setup.defaultScript) ps.playScriptId(this, this.setup.defaultScript);
  }

  /** Play a PlayScript (server PlayEffect) or, when the table lacks it, the setup's default script. */
  playScript(playScript: number, mod = 1): void {
    if (!this.particleSystem) return;
    if (this.scriptTable) this.particleSystem.playScript(this, this.scriptTable, playScript, mod);
  }

  /** Play a physics script id (0x33) directly. */
  playScriptId(scriptId: number): void {
    this.particleSystem?.playScriptId(this, scriptId);
  }

  dispose(): void {
    this.particleSystem?.destroyHost(this);
  }

  update(dt: number): void {
    this.sequence.update(dt);
    this.apply();
  }

  private apply(): void {
    const frame = this.sequence.currentFrame;
    if (!frame) return;
    const n = Math.min(this.parts.length, frame.frames.length);
    for (let i = 0; i < n; i++) {
      const f = frame.frames[i];
      this.parts[i].position.set(f.origin.x, f.origin.y, f.origin.z);
      this.parts[i].quaternion.set(f.rotation.x, f.rotation.y, f.rotation.z, f.rotation.w);
    }
  }
}
