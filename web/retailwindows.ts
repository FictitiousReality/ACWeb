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

export interface OpenWindow {
  layout: string;
  did: number;
  /** the element that is the window itself, rather than a prototype in the same layout */
  rootElementId: number;
  trace: DrawRecord[];
}

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
  let dirty = true;

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

  async function show(name: string): Promise<boolean> {
    if (!ui) { deps.log("retail layouts need the language dat", "c-error"); return false; }
    const did = ui.layouts.get(name);
    if (!did) { deps.log(`no retail layout called ${name}`, "c-error"); return false; }
    const rootElementId = await rootOf(did);
    if (rootElementId === null) { deps.log(`${name} has no window root`, "c-error"); return false; }
    open.set(name, { layout: name, did, rootElementId, trace: [] });
    dirty = true;
    return true;
  }
  function hide(name: string) {
    if (open.delete(name)) dirty = true;
  }

  async function render() {
    if (!ui) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    if (canvas.width !== SCREEN_W * dpr || canvas.height !== SCREEN_H * dpr) {
      canvas.width = SCREEN_W * dpr;
      canvas.height = SCREEN_H * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SCREEN_W, SCREEN_H);
    for (const w of open.values()) {
      const layout = await ui.load(w.did);
      w.trace = [];
      await ui.draw(ctx, layout, w.did, w.rootElementId, w.trace);
    }
    canvas.style.pointerEvents = open.size ? "auto" : "none";
  }

  /** the smallest drawn element covering a point, so a button wins over the panel behind it */
  function hit(x: number, y: number): { window: OpenWindow; elementId: number } | null {
    let found: { window: OpenWindow; elementId: number; area: number } | null = null;
    for (const w of open.values()) {
      for (const r of w.trace) {
        const m = /^(-?\d+),(-?\d+) (\d+)x(\d+)$/.exec(r.rect);
        if (!m) continue;
        const [rx, ry, rw, rh] = [+m[1], +m[2], +m[3], +m[4]];
        if (!rw || !rh || x < rx || y < ry || x >= rx + rw || y >= ry + rh) continue;
        const area = rw * rh;
        if (!found || area < found.area) found = { window: w, elementId: parseInt(r.id, 16), area };
      }
    }
    return found ? { window: found.window, elementId: found.elementId } : null;
  }

  canvas.addEventListener("click", (e: MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    const h = hit(e.clientX - r.left, e.clientY - r.top);
    if (!h) return;
    e.stopPropagation();
    deps.onClick?.(h.window.layout, h.elementId);
  });

  return {
    available: () => ui !== null,
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
