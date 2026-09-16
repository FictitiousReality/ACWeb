/**
 * Radar: everything nearby as a blip, in the game's own colours. AC ships a radar blip colour
 * and a radar behaviour with every object, so the radar shows what the server says to show
 * rather than a classification of our own. Resizable, zoomable out to the distance the server
 * tracks objects for us, and a blip can be clicked to target it.
 */
import type { WorldObject } from "../src/net/client.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** ACE Landblock.MaxObjectRange: past this the server stops telling us about things */
export const MAX_RANGE = 192;
const MIN_RANGE = 15;
const ZOOM_KEY = "acweb.radar.zoom", NORTH_KEY = "acweb.radar.northup", SIZE_KEY = "acweb.radar.size";

/** ACE RadarColor */
const COLORS: Record<number, string> = {
  1: "#4aa3ff", // blue: lifestones and bindstones
  2: "#d8a53a", // gold: creatures
  3: "#ffffff", // white
  4: "#b06ce0", // purple: portals
  5: "#e0483c", // red: player killers
  6: "#ff8fd0", // pink: advocates
  7: "#48c04a", // green
  8: "#e8d65a", // yellow: NPCs and vendors
  9: "#49d7d7", // cyan: admins and sentinels
  0x10: "#7dff7d", // bright green
};
const SHOW_NEVER = 1; // RadarBehavior.ShowNever
const PLAYER = 0x8; // ObjectDescriptionFlag.Player
const CREATURE = 0x10; // ItemType.Creature

/** The colour this object's blip should be, or null when it does not belong on the radar. */
export function blipColor(o: WorldObject): string | null {
  if (o.radarBehavior === SHOW_NEVER) return null;
  if (o.radarColor && COLORS[o.radarColor]) return COLORS[o.radarColor];
  if (o.objectFlags & PLAYER) return "#ffffff"; // another player with no colour of their own
  if (o.itemType & CREATURE) return COLORS[2]; // a creature with no colour of its own
  return null; // loose items, furniture and scenery stay off the radar
}

/**
 * Where a world point lands on the radar face, in pixels from the centre (canvas y grows down).
 * Heading-up turns the world so the way we face is up; north-up leaves it aligned to the world.
 */
export function project(
  self: { x: number; y: number; yaw: number },
  x: number,
  y: number,
  pxPerMetre: number,
  northUp: boolean,
): { x: number; y: number } {
  const dx = x - self.x, dy = y - self.y;
  if (northUp) return { x: dx * pxPerMetre, y: -dy * pxPerMetre };
  // forward is (-sin yaw, cos yaw) and right is (cos yaw, sin yaw); project onto those
  const c = Math.cos(self.yaw), s = Math.sin(self.yaw);
  return { x: (dx * c + dy * s) * pxPerMetre, y: -(-dx * s + dy * c) * pxPerMetre };
}

export interface RadarDeps {
  /** the player's world position and facing, or null before we are in the world */
  self(): { x: number; y: number; yaw: number } | null;
  /** everything we know about nearby, in world coordinates (excluding ourselves) */
  objects(): { guid: number; obj: WorldObject; x: number; y: number }[];
  targetGuid(): number | null;
  onPick(guid: number): void;
}

export function createRadar(deps: RadarDeps) {
  const root = $("radar");
  const canvas = $<HTMLCanvasElement>("radarCanvas");
  const ctx = canvas.getContext("2d")!;
  let zoom = 60, northUp = false, since = 0;
  let blips: { guid: number; sx: number; sy: number; name: string }[] = [];

  const num = (key: string, dflt: number) => {
    try { const v = Number(localStorage.getItem(key)); return Number.isFinite(v) && v > 0 ? v : dflt; } catch { return dflt; }
  };
  const save = (key: string, v: string) => { try { localStorage.setItem(key, v); } catch { /* ignore */ } };

  zoom = Math.min(MAX_RANGE, Math.max(MIN_RANGE, num(ZOOM_KEY, 60)));
  try { northUp = localStorage.getItem(NORTH_KEY) === "1"; } catch { /* ignore */ }
  try {
    const [w, h] = (localStorage.getItem(SIZE_KEY) ?? "").split(",").map(Number);
    if (w > 0 && h > 0) { root.style.width = `${w}px`; root.style.height = `${h}px`; }
  } catch { /* ignore */ }

  function setZoom(v: number) {
    zoom = Math.min(MAX_RANGE, Math.max(MIN_RANGE, Math.round(v)));
    save(ZOOM_KEY, String(zoom));
    $("radarRange").textContent = `${zoom} m`;
  }

  /** match the backing store to the element's size so the drawing stays sharp */
  function resize() {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw() {
    resize();
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const cx = w / 2, cy = h / 2, radius = Math.min(w, h) / 2 - 4;
    ctx.clearRect(0, 0, w, h);

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(10,14,18,.75)";
    ctx.fill();
    ctx.clip(); // nothing outside the dial, so blips never spill over the edge

    ctx.strokeStyle = "rgba(255,255,255,.12)";
    ctx.lineWidth = 1;
    for (const f of [1 / 3, 2 / 3, 1]) {
      ctx.beginPath();
      ctx.arc(cx, cy, radius * f, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius);
    ctx.stroke();

    const self = deps.self();
    blips = [];
    if (self) {
      const pxPerMetre = radius / zoom;
      const target = deps.targetGuid();
      for (const o of deps.objects()) {
        const color = blipColor(o.obj);
        if (!color) continue;
        const p = project(self, o.x, o.y, pxPerMetre, northUp);
        if (Math.hypot(p.x, p.y) > radius) continue; // out of range at this zoom
        const sx = cx + p.x, sy = cy + p.y;
        blips.push({ guid: o.guid, sx, sy, name: o.obj.name });
        if (o.guid === target) {
          ctx.beginPath();
          ctx.arc(sx, sy, 6, 0, Math.PI * 2);
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(sx, sy, 3, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
      // us: a triangle pointing the way we face (always up unless the dial is north-up)
      const facing = northUp ? -self.yaw : 0;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(facing);
      ctx.beginPath();
      ctx.moveTo(0, -6); ctx.lineTo(4, 4); ctx.lineTo(0, 2); ctx.lineTo(-4, 4);
      ctx.closePath();
      ctx.fillStyle = "#7fe3ff";
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();

    // north marker on the rim: fixed at the top when north-up, otherwise it swings with us
    if (self) {
      const northAngle = northUp ? 0 : self.yaw;
      const nx = cx + Math.sin(northAngle) * (radius - 7), ny = cy - Math.cos(northAngle) * (radius - 7);
      ctx.fillStyle = "rgba(255,255,255,.55)";
      ctx.font = "9px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("N", nx, ny);
    }
    ctx.strokeStyle = "rgba(255,255,255,.25)";
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  canvas.addEventListener("wheel", (e: WheelEvent) => {
    e.preventDefault();
    setZoom(zoom * (e.deltaY > 0 ? 1.15 : 1 / 1.15));
    draw();
  }, { passive: false });

  /** the blip nearest a point on the dial, if the click was close enough to mean it */
  function blipAt(e: MouseEvent): { guid: number; name: string } | null {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best: { guid: number; name: string } | null = null, bestD = 9;
    for (const b of blips) {
      const d = Math.hypot(b.sx - x, b.sy - y);
      if (d < bestD) { bestD = d; best = { guid: b.guid, name: b.name }; }
    }
    return best;
  }
  canvas.addEventListener("click", (e: MouseEvent) => {
    const b = blipAt(e);
    if (b) deps.onPick(b.guid);
  });
  canvas.addEventListener("mousemove", (e: MouseEvent) => {
    const b = blipAt(e);
    canvas.title = b ? b.name : "";
  });

  $("radarIn").onclick = () => { setZoom(zoom / 1.3); draw(); };
  $("radarOut").onclick = () => { setZoom(zoom * 1.3); draw(); };
  $("radarNorth").onclick = () => {
    northUp = !northUp;
    save(NORTH_KEY, northUp ? "1" : "0");
    $("radarNorth").textContent = northUp ? "N" : "▲";
    $("radarNorth").title = northUp ? "north up (click for heading up)" : "heading up (click for north up)";
    draw();
  };
  $("radarClose").onclick = () => close();

  // remember the size the player drags the panel to
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => {
      if (root.classList.contains("show")) save(SIZE_KEY, `${root.clientWidth},${root.clientHeight}`);
      draw();
    }).observe(root);
  }

  function open() { root.classList.add("show"); setZoom(zoom); draw(); }
  function close() { root.classList.remove("show"); }

  $("radarNorth").textContent = northUp ? "N" : "▲";
  setZoom(zoom);

  return {
    open,
    close,
    toggle() { if (root.classList.contains("show")) close(); else open(); },
    isOpen: () => root.classList.contains("show"),
    /** redraw a few times a second; the world moves under us every frame */
    tick(dt: number) {
      if (!root.classList.contains("show")) return;
      since += dt;
      if (since < 0.05) return;
      since = 0;
      draw();
    },
  };
}
