/**
 * Active buffs: a button by Blink showing how many beneficial spells are on you, opening a
 * list of them with the time each has left. Within a category only the strongest applies;
 * weaker ones are shown dimmed as surpassed.
 */
import type { GameClient } from "../src/net/client.ts";
import { enchantmentRemaining } from "../src/net/messages.ts";
import type { SpellBase } from "../src/dat/mod.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const BENEFICIAL = 0x4;

export interface BuffDeps {
  client(): GameClient | null;
  spell(id: number): SpellBase | undefined;
  icon(textureId: number): Promise<string | null>;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** "1:02:05", "4:09", or "item" for spells that last until removed */
export function formatRemaining(sec: number): string {
  if (!isFinite(sec)) return "item";
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60;
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

export function createBuffs(deps: BuffDeps) {
  const btn = $("btnBuffs"), list = $("buffList");
  let open = false, acc = 0;

  function rows() {
    const c = deps.client();
    if (!c) return [];
    const now = performance.now() / 1000;
    const all = c.enchantments
      .map((e) => ({ e, s: deps.spell(e.spellId), left: enchantmentRemaining(e, now) }))
      .filter((r) => r.s && (r.s.bitfield & BENEFICIAL) && r.left > 0);
    const best = new Map<number, (typeof all)[number]>();
    for (const r of all) { const b = best.get(r.e.category); if (!b || r.e.power > b.e.power) best.set(r.e.category, r); }
    return all.map((r) => ({ ...r, surpassed: best.get(r.e.category) !== r })).sort((a, b) => a.left - b.left);
  }

  function render() {
    const rs = rows();
    const live = rs.filter((r) => !r.surpassed).length;
    btn.textContent = `✦ ${live}`;
    btn.title = live ? `${live} beneficial spell${live === 1 ? "" : "s"} on you: click for the list` : "no beneficial spells on you";
    btn.classList.toggle("has", live > 0);
    if (!open) return;
    list.innerHTML = "";
    if (!rs.length) { list.textContent = "No beneficial spells on you."; return; }
    for (const r of rs) {
      const row = document.createElement("div");
      row.className = "buff" + (r.surpassed ? " surpassed" : "") + (r.left < 60 ? " low" : "");
      const img = document.createElement("img");
      img.alt = "";
      deps.icon(r.s!.iconId).then((u) => { if (u) img.src = u; });
      const name = document.createElement("span");
      name.textContent = r.s!.name + (r.surpassed ? " (surpassed)" : "");
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = formatRemaining(r.left);
      row.append(img, name, t);
      row.title = r.s!.description;
      list.appendChild(row);
    }
  }

  btn.onclick = () => { open = !open; list.classList.toggle("show", open); render(); btn.blur(); };
  return {
    render,
    /** counts down once a second */
    tick(dt: number) { acc += dt; if (acc >= 1) { acc = 0; render(); } },
  };
}
