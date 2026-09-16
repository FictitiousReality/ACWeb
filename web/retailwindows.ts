/**
 * Retail windows in the client: an overlay canvas that draws the game's own windows from the
 * layouts in the dats, and routes clicks back to the element that was hit.
 *
 * Retail authored every layout against an 800x600 screen and positioned windows absolutely
 * inside it, so the overlay is that virtual screen, anchored in the viewport. Elements carry
 * edge anchors (LeftEdge/TopEdge/RightEdge/BottomEdge) for resizing to other resolutions; those
 * are parsed but not applied yet, so windows sit where retail put them at 800x600.
 */
import type { Assets } from "../src/render/assets.ts";
import { createRetailUi, type DrawRecord, type RetailUi } from "./retailui.ts";

/** the virtual screen every retail layout is authored against */
export const SCREEN_W = 800, SCREEN_H = 600;

/** where the retail screen mounts a window: the field's rect and its edge anchors */
export interface Mount {
  x: number; y: number; w: number; h: number;
  /** left/top/right/bottom modes: 1 keeps the distance from the left/top edge, 2 from the right/bottom */
  edges: [number, number, number, number];
  hidden: boolean;
}

export interface OpenWindow {
  layout: string;
  did: number;
  mount?: Mount;
  /** where the window was drawn in viewport pixels, for hit-testing and dragging */
  dx: number;
  dy: number;
  /** the player's own drag offset, on top of the anchored position */
  offX: number;
  offY: number;
  rect: { x: number; y: number; w: number; h: number };
  /** the element that is the window itself, rather than a prototype in the same layout */
  rootElementId: number;
  trace: DrawRecord[];
}

/** where a window sits by default: which corner it hugs and how far in from it */
export type Anchor = "tl" | "tr" | "bl" | "br" | "tc" | "bc" | "cc";
export interface Placement { anchor: Anchor; x: number; y: number }

const POS_KEY = "acweb.retail.pos";

export interface RetailWindowDeps {
  assets(): Assets | null;
  log(line: string, cls?: string): void;
  /** a click landed on an element of an open window */
  onClick?(layout: string, elementId: number): void;
}

export async function createRetailWindows(deps: RetailWindowDeps) {
  const canvas = document.getElementById("retailui") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;
  const assets = deps.assets();
  const ui: RetailUi | null = assets ? await createRetailUi(assets) : null;
  const open = new Map<string, OpenWindow>();
  const placements = new Map<string, Placement>();
  /** layout name -> where classic_gameplay mounts it */
  const mounts = new Map<string, Mount>();
  let dirty = true;

  /** positions the player has dragged windows to, kept between sessions */
  let saved: Record<string, { x: number; y: number }> = {};
  try { saved = JSON.parse(localStorage.getItem(POS_KEY) ?? "{}"); } catch { /* ignore */ }
  const savePositions = () => {
    try {
      const out: Record<string, { x: number; y: number }> = { ...saved };
      for (const w of open.values()) if (w.offX || w.offY) out[w.layout] = { x: w.offX, y: w.offY };
      saved = out;
      localStorage.setItem(POS_KEY, JSON.stringify(out));
    } catch { /* ignore */ }
  };

  /** the window root of a layout: the top-level element that has children, not the prototypes */
  async function rootOf(did: number): Promise<number | null> {
    if (!ui) return null;
    const layout = await ui.load(did);
    let best: { id: number; kids: number } | null = null;
    for (const e of layout.elements.values()) {
      if (e.children.size && (!best || e.children.size > best.kids)) best = { id: e.elementId, kids: e.children.size };
    }
    return best?.id ?? null;
  }

  async function show(name: string, place?: Placement): Promise<boolean> {
    if (place) placements.set(name, place);
    if (!ui) { deps.log("retail layouts need the language dat", "c-error"); return false; }
    const did = ui.layouts.get(name);
    if (!did) { deps.log(`no retail layout called ${name}`, "c-error"); return false; }
    const rootElementId = await rootOf(did);
    if (rootElementId === null) { deps.log(`${name} has no window root`, "c-error"); return false; }
    const layout = await ui.load(did);
    const root = [...layout.elements.values()].find((e) => e.elementId === rootElementId)!;
    open.set(name, {
      layout: name, did, rootElementId, trace: [], dx: 0, dy: 0, mount: mounts.get(name),
      offX: saved[name]?.x ?? 0, offY: saved[name]?.y ?? 0,
      rect: { x: root.x, y: root.y, w: root.width, h: root.height },
    });
    dirty = true;
    return true;
  }
  function hide(name: string) {
    if (open.delete(name)) dirty = true;
  }

  /**
   * Retail placed windows absolutely in an 800x600 screen. Rather than shrink the game into a
   * box, each window keeps its distance from whichever edges it hugs: a window in the bottom
   * third of the authored screen stays at the bottom of the viewport, and so on.
   */
  function anchor(w: OpenWindow, vw: number, vh: number) {
    const { x, y, w: rw, h: rh } = w.rect;
    const m = w.mount;
    if (m) {
      // the screen was authored at 800x600; each side keeps its distance from the edge it anchors to
      const left = m.edges[0] === 2 ? vw - (SCREEN_W - m.x - m.w) - m.w : m.x;
      const top = m.edges[1] === 2 ? vh - (SCREEN_H - m.y - m.h) - m.h : m.y;
      return { dx: left - x + w.offX, dy: top - y + w.offY };
    }
    const p = placements.get(w.layout);
    if (p) {
      const left = p.anchor === "tr" || p.anchor === "br" ? vw - rw - p.x
        : p.anchor === "tc" || p.anchor === "bc" ? (vw - rw) / 2 + p.x
        : p.anchor === "cc" ? (vw - rw) / 2 + p.x
        : p.x;
      const top = p.anchor === "bl" || p.anchor === "br" || p.anchor === "bc" ? vh - rh - p.y
        : p.anchor === "cc" ? (vh - rh) / 2 + p.y
        : p.y;
      return { dx: left - x + w.offX, dy: top - y + w.offY };
    }
    const cx = x + rw / 2, cy = y + rh / 2;
    const ax = cx < SCREEN_W / 3 ? x
      : cx > (SCREEN_W * 2) / 3 ? vw - (SCREEN_W - x - rw) - rw
      : (vw - rw) / 2;
    const ay = cy < SCREEN_H / 3 ? y
      : cy > (SCREEN_H * 2) / 3 ? vh - (SCREEN_H - y - rh) - rh
      : (vh - rh) / 2;
    return { dx: ax - x + w.offX, dy: ay - y + w.offY };
  }

  async function render() {
    if (!ui) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const vw = canvas.clientWidth || SCREEN_W, vh = canvas.clientHeight || SCREEN_H;
    if (canvas.width !== Math.round(vw * dpr) || canvas.height !== Math.round(vh * dpr)) {
      canvas.width = Math.round(vw * dpr);
      canvas.height = Math.round(vh * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    for (const w of open.values()) {
      const layout = await ui.load(w.did);
      const { dx, dy } = anchor(w, vw, vh);
      w.dx = dx;
      w.dy = dy;
      w.trace = [];
      ctx.save();
      ctx.translate(dx, dy);
      try {
        await ui.draw(ctx, layout, w.did, w.rootElementId, w.trace);
      } catch (err) {
        // one window failing must not blank the others
        deps.log(`${w.layout}: ${(err as Error).message}`, "c-error");
      }
      ctx.restore();
    }
    // the canvas never takes pointer events: clicks are hit-tested in the capture phase below so
    // that a miss falls through to the world underneath (targeting and camera drag keep working)
  }

  /** the smallest drawn element covering a point, so a button wins over the panel behind it */
  function hit(x: number, y: number): { window: OpenWindow; elementId: number } | null {
    let found: { window: OpenWindow; elementId: number; area: number } | null = null;
    for (const w of open.values()) {
      for (const r of w.trace) {
        const m = /^(-?\d+),(-?\d+) (\d+)x(\d+)$/.exec(r.rect);
        if (!m) continue;
        const [rx, ry, rw, rh] = [+m[1] + w.dx, +m[2] + w.dy, +m[3], +m[4]];
        if (!rw || !rh || x < rx || y < ry || x >= rx + rw || y >= ry + rh) continue;
        const area = rw * rh;
        if (!found || area < found.area) found = { window: w, elementId: parseInt(r.id, 16), area };
      }
    }
    return found ? { window: found.window, elementId: found.elementId } : null;
  }

  addEventListener("click", (e: MouseEvent) => {
    if (!open.size) return;
    const r = canvas.getBoundingClientRect();
    const scale = r.width / SCREEN_W;
    const h = hit((e.clientX - r.left) / scale, (e.clientY - r.top) / scale);
    if (!h) return; // not on a window: let the world have it
    e.stopPropagation();
    e.preventDefault();
    if (ui?.clickTab(h.elementId)) { dirty = true; return; }
    deps.onClick?.(h.window.layout, h.elementId);
  }, true);

  /** the meter elements of an open window, top to bottom - health, stamina, mana in the vitals */
  async function meters(name: string): Promise<number[]> {
    const w = open.get(name);
    if (!ui || !w) return [];
    const layout = await ui.load(w.did);
    const found: { id: number; y: number }[] = [];
    (function walk(m: Map<number, { type: number; elementId: number; y: number; children: Map<number, unknown> }>) {
      for (const e of m.values()) {
        if (e.type === 7) found.push({ id: e.elementId, y: e.y });
        walk(e.children as never);
      }
      // deno-lint-ignore no-explicit-any
    })((layout as any).elements);
    return found.sort((a, b) => a.y - b.y).map((f) => f.id);
  }

  // drag a window by any part of it that is not a button
  let drag: { w: OpenWindow; startX: number; startY: number; offX: number; offY: number } | null = null;
  addEventListener("mousedown", (e: MouseEvent) => {
    if (!open.size) return;
    const r = canvas.getBoundingClientRect();
    const h = hit(e.clientX - r.left, e.clientY - r.top);
    if (!h) return;
    drag = { w: h.window, startX: e.clientX, startY: e.clientY, offX: h.window.offX, offY: h.window.offY };
  }, true);
  addEventListener("mousemove", (e: MouseEvent) => {
    if (!drag) return;
    drag.w.offX = drag.offX + (e.clientX - drag.startX);
    drag.w.offY = drag.offY + (e.clientY - drag.startY);
    dirty = true;
  });
  addEventListener("mouseup", () => { if (drag) { drag = null; savePositions(); } });
  addEventListener("resize", () => { dirty = true; });

  /**
   * The retail screen: classic_gameplay is an 800x600 layout whose children are the fields each
   * floaty window mounts into, with the position, edge anchors and default visibility retail gave
   * them. Fields that are the whole screen (the 3-D view, the keyboard map, admin) are not windows.
   */
  async function mountScreen(): Promise<string[]> {
    if (!ui) return [];
    const gpDid = ui.layouts.get("classic_gameplay");
    if (!gpDid) return [];
    const gp = await ui.load(gpDid);
    const screenRoot = [...gp.elements.values()].sort((a, b) => b.children.size - a.children.size)[0];
    const shown: string[] = [];
    for (const f of screenRoot.children.values()) {
      if (f.width >= SCREEN_W && f.height >= SCREEN_H) continue; // the view itself, not a window
      const base = (ui.elementName?.(f.elementId) ?? "").replace(/^RootGameplay_/, "").replace(/_Field$/, "").toLowerCase();
      if (!base || base === "admin") continue;
      // the field's own layout: the floaty one first, then the plain one, preferring an exact size match
      const candidates = [`classic_${base}`, `classic_floaty${base.replace(/^floaty/, "")}`];
      let chosen: string | null = null;
      for (const c of candidates) {
        const d = ui.layouts.get(c);
        if (!d) continue;
        const l = await ui.load(d);
        const r = [...l.elements.values()].sort((a, b) => b.children.size - a.children.size)[0];
        if (r && r.width === f.width && r.height === f.height) { chosen = c; break; }
        chosen ??= c;
      }
      if (!chosen) continue;
      // three fields are alternates retail showed one at a time: the side-vitals style instead of
      // the floaty vitals, and the environment/combat panels only in those modes. All three share
      // a rect with something else, so they start hidden and /retail <name> brings them up.
      const CONTEXTUAL = new Set(["classic_floatysidevitals", "classic_floatyenvpanel", "classic_floatycombatpanel"]);
      const hidden = ui.isHidden(f) || CONTEXTUAL.has(chosen);
      mounts.set(chosen, { x: f.x, y: f.y, w: f.width, h: f.height, edges: f.edges, hidden });
      if (!hidden) { await show(chosen); shown.push(chosen); }
    }
    for (const w of open.values()) await hostFields(w.did);
    // everything the screen needs, fetched together instead of one sprite per await while drawing
    await Promise.all([...open.values()].map((w) => ui!.preload(w.did)));
    dirty = true;
    return shown;
  }

  /** every layout drawn anywhere on screen, mounted or hosted, so live data can reach all of them */
  const hostedLayouts = new Set<number>();

  /**
   * Fields host other layouts: a *_Field element whose name (minus the suffix) names a layout draws
   * that layout inside itself. classic_floatypanel's PanelPages hosts one page per panel and shows
   * the inventory by default; classic_inventory hosts the paperdoll, backpack and 3-D items views.
   * Recurses so that the paperdoll inside the inventory inside the panel all resolve.
   */
  async function hostFields(did: number, depth = 0): Promise<void> {
    if (!ui || depth > 4) return;
    const layout = await ui.load(did);
    const stack = [...layout.elements.values()];
    while (stack.length) {
      const e = stack.pop()!;
      const name = ui.elementName(e.elementId) ?? "";
      const m = /^(?:Root\w+_)?(\w+?)(?:Panel)?_?Field$/.exec(name);
      if (m && e.width && e.height && !/^Root/.test(name)) {
        const base = m[1].toLowerCase();
        const target = [`classic_${base}`, `classic_${base}panel`, `classic_${base}management`]
          .map((n) => ui!.layouts.get(n)).find((d) => d !== undefined);
        if (target && target !== did) {
          ui.host(e.elementId, target);
          hostedLayouts.add(target);
          await hostFields(target, depth + 1);
        }
      }
      // a page group: the fields under PanelPages share one rect; open the inventory page
      if (name === "PanelPages") {
        const inventory = [...e.children.values()].find((c) => ui!.elementName(c.elementId) === "InventoryPanel_Field");
        if (inventory) ui.showPage(e.elementId, inventory.elementId);
      }
      stack.push(...e.children.values());
    }
  }

  return {
    available: () => ui !== null,
    mountScreen,
    /** every item container on screen, in windows and in the layouts hosted inside them */
    async allItemContainers() {
      if (!ui) return [] as { layout: string; elementId: number; slots: number }[];
      const out: { layout: string; elementId: number; slots: number }[] = [];
      const seen = new Set<number>();
      const dids: [string, number][] = [...open.values()].map((w) => [w.layout, w.did] as [string, number]);
      for (const d of hostedLayouts) dids.push([[...ui.layouts].find(([, v]) => v === d)?.[0] ?? d.toString(16), d]);
      for (const [layout, d] of dids) {
        if (seen.has(d)) continue;
        seen.add(d);
        for (const c of await ui.itemContainers(d)) out.push({ layout, ...c });
      }
      return out;
    },
    /** put every window back where it started */
    resetPositions() {
      for (const w of open.values()) { w.offX = 0; w.offY = 0; }
      saved = {};
      try { localStorage.removeItem(POS_KEY); } catch { /* ignore */ }
      dirty = true;
    },
    /** fill an item list with icons */
    setItems(elementId: number, items: { icon: number }[]) {
      ui?.setItems(elementId, items);
      dirty = true;
    },
    /** every element of an open window that holds items, with how many slots it has room for */
    async itemLists(name: string) {
      const w = open.get(name);
      if (!ui || !w) return [];
      return await ui.itemContainers(w.did);
    },
    meters,
    /** drive a meter from live game state: 0..1 */
    setFill(elementId: number, fraction: number) {
      ui?.setFill(elementId, fraction);
      dirty = true;
    },
    names: () => (ui ? [...ui.layouts.keys()].sort() : []),
    show,
    hide,
    isOpen: (name: string) => open.has(name),
    toggle: async (name: string) => (open.has(name) ? (hide(name), false) : await show(name)),
    /** redraw when something changed; the layouts are static so this is cheap and rare */
    async tick() {
      if (!dirty) return;
      dirty = false;
      await render();
    },
    invalidate() { dirty = true; },
  };
}
