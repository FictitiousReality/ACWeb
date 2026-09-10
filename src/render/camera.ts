/** Pointer-lock fly camera for a Z-up world. */
import * as THREE from "three";

export class FlyCamera {
  yaw = 0;
  pitch = -0.2;
  speed = 40;
  private keys = new Set<string>();
  private locked = false;

  constructor(readonly camera: THREE.PerspectiveCamera, private el: HTMLElement) {
    camera.up.set(0, 0, 1);
    el.addEventListener("click", () => el.requestPointerLock());
    document.addEventListener("pointerlockchange", () => (this.locked = document.pointerLockElement === el));
    document.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * 0.0025;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - e.movementY * 0.0025));
    });
    addEventListener("keydown", (e) => this.keys.add(e.code));
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    addEventListener("blur", () => this.keys.clear());
  }

  lookAt(target: THREE.Vector3) {
    const d = target.clone().sub(this.camera.position);
    this.yaw = Math.atan2(d.y, d.x);
    this.pitch = Math.atan2(d.z, Math.hypot(d.x, d.y));
  }

  update(dt: number) {
    const fwd = new THREE.Vector3(Math.cos(this.yaw) * Math.cos(this.pitch), Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch));
    const right = new THREE.Vector3(Math.sin(this.yaw), -Math.cos(this.yaw), 0);
    const up = new THREE.Vector3(0, 0, 1);
    const move = new THREE.Vector3();
    const k = this.keys;
    if (k.has("KeyW") || k.has("ArrowUp")) move.add(fwd);
    if (k.has("KeyS") || k.has("ArrowDown")) move.sub(fwd);
    if (k.has("KeyD") || k.has("ArrowRight")) move.add(right);
    if (k.has("KeyA") || k.has("ArrowLeft")) move.sub(right);
    if (k.has("KeyE") || k.has("Space")) move.add(up);
    if (k.has("KeyQ") || k.has("KeyC")) move.sub(up);
    const fast = k.has("ShiftLeft") || k.has("ShiftRight");
    if (move.lengthSq() > 0) this.camera.position.addScaledVector(move.normalize(), this.speed * (fast ? 5 : 1) * dt);
    this.camera.lookAt(this.camera.position.clone().add(fwd));
  }
}
