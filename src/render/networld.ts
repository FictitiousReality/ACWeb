/** Renders server world objects (creatures, players, items on the ground, doors...) from GameClient events. */
import * as THREE from "three";
import type { Assets } from "./assets.ts";
import type { ObjectRenderer } from "./objects.ts";
import { AnimatedModel } from "./animated.ts";
import type { MovementData, Position, PositionUpdate } from "../net/messages.ts";
import type { WorldObject } from "../net/client.ts";
import { commandFromKey } from "../dat/motionenums.ts";
import { BLOCK_LENGTH } from "../world/terrain.ts";

export function positionToWorld(p: Position, out = new THREE.Vector3()): THREE.Vector3 {
  const lbx = p.cell >>> 24, lby = (p.cell >>> 16) & 0xff;
  return out.set(lbx * BLOCK_LENGTH + p.x, lby * BLOCK_LENGTH + p.y, p.z);
}

export interface Entity {
  obj: WorldObject;
  root: THREE.Group;
  model: AnimatedModel | null;
  target: THREE.Vector3;
  targetQuat: THREE.Quaternion;
  lerpFrom: THREE.Vector3;
  lerpT: number;
}

export class NetWorld {
  readonly group = new THREE.Group();
  readonly entities = new Map<number, Entity>();
  onLog: ((s: string) => void) | null = null;

  constructor(private assets: Assets, private objects: ObjectRenderer) {}

  async create(obj: WorldObject, isPlayer = false): Promise<Entity | null> {
    this.remove(obj.guid);
    if (!obj.setup || obj.parent || !obj.position) return null; // inventory / wielded / no model
    const root = new THREE.Group();
    root.name = `obj_${obj.guid.toString(16)}_${obj.name}`;
    const e: Entity = { obj, root, model: null, target: new THREE.Vector3(), targetQuat: new THREE.Quaternion(), lerpFrom: new THREE.Vector3(), lerpT: 1 };
    this.entities.set(obj.guid, e);
    this.group.add(root);
    this.applyPosition(e, obj.position, true);
    if (obj.setup >>> 24 === 0x02) {
      const m = await AnimatedModel.create(this.assets, this.objects, obj.setup);
      if (m) {
        e.model = m;
        root.add(m.root);
        if (obj.movement?.state) await this.applyMotion(e, obj.movement);
      }
    } else {
      const tmpl = await this.objects.model(obj.setup);
      if (tmpl) root.add(tmpl.clone());
    }
    if (obj.scale && obj.scale !== 1) root.scale.setScalar(obj.scale);
    if (!this.entities.has(obj.guid)) { this.group.remove(root); return null; } // deleted while loading
    void isPlayer;
    return e;
  }

  remove(guid: number) {
    const e = this.entities.get(guid);
    if (!e) return;
    this.group.remove(e.root);
    this.entities.delete(guid);
  }

  applyPosition(e: Entity, p: Position, snap = false) {
    positionToWorld(p, e.target);
    e.targetQuat.set(p.qx, p.qy, p.qz, p.qw);
    if (snap || e.root.position.distanceTo(e.target) > 30) {
      e.root.position.copy(e.target);
      e.root.quaternion.copy(e.targetQuat);
      e.lerpT = 1;
    } else {
      e.lerpFrom.copy(e.root.position);
      e.lerpT = 0;
    }
  }

  onPosition(obj: WorldObject, u: PositionUpdate) {
    const e = this.entities.get(obj.guid);
    if (e) this.applyPosition(e, u.position);
  }

  async applyMotion(e: Entity, md: MovementData) {
    if (!e.model || !md.state) return;
    const st = md.state;
    const stance = st.stance || md.stance;
    let cmd = st.forward ? commandFromKey(st.forward) : 0x41000003;
    if (st.commands.length) cmd = commandFromKey(st.commands[st.commands.length - 1].command);
    await e.model.playMotion(cmd, stance);
  }

  onMotion(obj: WorldObject, md: MovementData) {
    const e = this.entities.get(obj.guid);
    if (e) this.applyMotion(e, md);
  }

  update(dt: number) {
    for (const e of this.entities.values()) {
      if (e.lerpT < 1) {
        e.lerpT = Math.min(1, e.lerpT + dt / 0.35);
        e.root.position.lerpVectors(e.lerpFrom, e.target, e.lerpT);
        e.root.quaternion.slerp(e.targetQuat, Math.min(1, dt * 8));
      }
      e.model?.update(dt);
    }
  }
}
