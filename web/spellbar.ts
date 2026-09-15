/**
 * Spell bar: the eight spell bars the server keeps for you, click (or 1-0) to cast, and a
 * cast queue that fires spells one after another, for buffing yourself or a target.
 *
 * Casting needs magic mode, and magic mode needs a wand, orb or staff wielded. The server
 * answers every cast with a UseDone event (0 = success) once the recoil is over, which is
 * what moves the queue on.
 */
import type { GameClient } from "../src/net/client.ts";
import type { SpellBase } from "../src/dat/mod.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** SpellFlags in the spell table's bitfield */
const BENEFICIAL = 0x4, SELF_TARGETED = 0x8, FELLOWSHIP = 0x2000;
const MAGIC_MODE = 8, NONCOMBAT_MODE = 1;
/** ItemType.Caster */
const CASTER_ITEM = 0x8000;
const NAMES_KEY = "acweb.spellbars.names";

export interface SpellBarDeps {
  client(): GameClient | null;
  /** a spell from the dat spell table */
  spell(id: number): SpellBase | undefined;
  icon(textureId: number): Promise<string | null>;
  targetGuid(): number | null;
  log(line: string, cls?: string): void;
  /** a cast was just sent: animate it on our character */
  onCastStart?(spellId: number): void;
}

interface QueuedCast { spellId: number; target?: number; label: string; retries?: number }
type Plan = { target?: number } | { skip: string };

export function createSpellBar(deps: SpellBarDeps) {
  const root = $("spellbar");
  let bar = 0;
  let names: string[] = [];
  try { names = JSON.parse(localStorage.getItem(NAMES_KEY) ?? "[]"); } catch { /* storage unavailable */ }
  let inMagic = false;
  const queue: QueuedCast[] = [];
  let state: "idle" | "entering" | "casting" | "cooldown" = "idle";
  let timer = 0;
  let current: QueuedCast | null = null;
  let batchTotal = 0, batchDone = 0;

  const barName = (i = bar) => names[i] || `Spell bar ${i + 1}`;
  const status = (text: string) => { $("sbStatus").textContent = text; };

  function hasCaster(c: GameClient): boolean {
    return [...c.objects.values()].some((o) => o.wielder === c.playerGuid && (o.itemType & CASTER_ITEM) !== 0);
  }

  /**
   * Who a spell goes to. Self-targeted and fellowship spells take no target. Anything else goes
   * to the selected target, and a beneficial "other" spell with nothing selected lands on you.
   */
  function plan(s: SpellBase, mode: "single" | "self" | "target"): Plan {
    const c = deps.client()!;
    const untargeted = (s.bitfield & (SELF_TARGETED | FELLOWSHIP)) !== 0;
    if (mode === "self") {
      if (untargeted) return {};
      if (s.bitfield & BENEFICIAL) return { target: c.playerGuid };
      return { skip: `${s.name} is not a buff` };
    }
    if (mode === "target") {
      const t = deps.targetGuid();
      if (!t) return { skip: "no target selected" };
      if (untargeted) return { skip: `${s.name} only works on yourself` };
      // a buff run never fires attacks or debuffs at the person being buffed
      if (!(s.bitfield & BENEFICIAL)) return { skip: `${s.name} is not a buff` };
      return { target: t };
    }
    if (untargeted) return {};
    const t = deps.targetGuid();
    if (t) return { target: t };
    if (s.bitfield & BENEFICIAL) return { target: c.playerGuid };
    return { skip: `${s.name} needs a target: click one first` };
  }

  function pump() {
    const c = deps.client();
    if (!c || state !== "idle") return;
    const next = queue[0];
    if (!next) {
      // render first: it resets the status line, and the summary should stay visible
      const summary = batchTotal ? `done: ${batchDone} of ${batchTotal} cast` : "";
      batchTotal = 0;
      render();
      if (summary) status(summary);
      return;
    }
    if (!inMagic) {
      if (!hasCaster(c)) {
        deps.log("wield a wand, orb or staff to cast spells", "c-error");
        queue.length = 0; batchTotal = 0;
        status("no caster wielded");
        render();
        return;
      }
      c.setCombatMode(MAGIC_MODE);
      state = "entering"; timer = 5;
      status("readying magic...");
      return;
    }
    queue.shift();
    current = next;
    c.castSpell(next.spellId, next.target);
    deps.onCastStart?.(next.spellId);
    state = "casting"; timer = 15; // safety net if the server never answers
    status(batchTotal ? `casting ${batchDone + 1} of ${batchTotal}: ${next.label}` : `casting ${next.label}`);
    render();
  }

  /** Casting starts by entering magic mode, which needs a caster: say so before anything else. */
  function readyToCast(c: GameClient): boolean {
    if (inMagic || hasCaster(c)) return true;
    deps.log("wield a wand, orb or staff to cast spells", "c-error");
    status("no caster wielded");
    return false;
  }

  function castSpell(spellId: number) {
    const s = deps.spell(spellId);
    const c = deps.client();
    if (!s || !c || !readyToCast(c)) return;
    const p = plan(s, "single");
    if ("skip" in p) { deps.log(p.skip, "c-error"); return; }
    queue.push({ spellId, target: p.target, label: s.name });
    pump();
    render();
  }

  /** Cast every spell on the current bar, in order, on yourself or on the selected target. */
  function buff(mode: "self" | "target") {
    const c = deps.client();
    if (!c) return;
    if (mode === "target" && !deps.targetGuid()) { deps.log("select a target first", "c-error"); return; }
    if (!readyToCast(c)) return;
    const items: QueuedCast[] = [], skipped: string[] = [];
    for (const id of c.spellBars[bar] ?? []) {
      const s = deps.spell(id);
      if (!s) continue;
      const p = plan(s, mode);
      if ("skip" in p) skipped.push(s.name); else items.push({ spellId: id, target: p.target, label: s.name });
    }
    if (!items.length) { deps.log(skipped.length ? "nothing on this bar can be cast that way" : "this bar is empty", "c-error"); return; }
    if (skipped.length) deps.log(`skipping ${skipped.length}: ${skipped.slice(0, 4).join(", ")}${skipped.length > 4 ? "..." : ""}`, "c-system");
    queue.push(...items);
    batchTotal = items.length; batchDone = 0;
    pump();
    render();
  }

  function stop() {
    queue.length = 0;
    batchTotal = 0;
    if (state === "entering") state = "idle";
    status("stopped");
    render();
  }

  function addToBar(spellId: number) {
    const c = deps.client();
    if (!c) return;
    if ((c.spellBars[bar] ?? []).includes(spellId)) { deps.log(`already on ${barName()}`, "c-system"); return; }
    c.addSpellToBar(spellId, c.spellBars[bar].length, bar);
    deps.log(`added ${deps.spell(spellId)?.name ?? "spell"} to ${barName()}`, "c-system");
    render();
  }

  function removeFromBar(spellId: number) {
    const c = deps.client();
    if (!c) return;
    c.removeSpellFromBar(spellId, bar);
    render();
  }

  function render() {
    const c = deps.client();
    const tabs = $("sbTabs");
    tabs.innerHTML = "";
    tabs.appendChild(Object.assign(document.createElement("span"), { className: "grip", textContent: "⋮⋮", title: "drag" }));
    for (let i = 0; i < 8; i++) {
      const b = document.createElement("button");
      b.textContent = String(i + 1);
      b.title = `${barName(i)} (double-click to rename)`;
      b.className = i === bar ? "active" : "";
      b.onclick = () => { bar = i; render(); };
      b.ondblclick = () => {
        const name = prompt("Name this spell bar", names[i] ?? "");
        if (name === null) return;
        names[i] = name.trim();
        try { localStorage.setItem(NAMES_KEY, JSON.stringify(names)); } catch { /* ignore */ }
        render();
      };
      tabs.appendChild(b);
    }
    tabs.appendChild(Object.assign(document.createElement("span"), { className: "spacer" }));
    const mode = document.createElement("button");
    mode.textContent = "Magic";
    mode.className = "mode" + (inMagic ? " on" : "");
    mode.title = inMagic ? "leave magic mode" : "enter magic mode (needs a wand, orb or staff)";
    mode.onclick = () => c?.setCombatMode(inMagic ? NONCOMBAT_MODE : MAGIC_MODE);
    const me = Object.assign(document.createElement("button"), { textContent: "Buff me", title: "cast every spell on this bar on yourself" });
    me.onclick = () => buff("self");
    const them = Object.assign(document.createElement("button"), { textContent: "Buff target", title: "cast every spell on this bar on your selected target" });
    them.onclick = () => buff("target");
    tabs.append(mode, me, them);
    if (queue.length || state !== "idle") {
      const s = Object.assign(document.createElement("button"), { textContent: "Stop", title: "clear the cast queue" });
      s.onclick = stop;
      tabs.appendChild(s);
    }

    const slots = $("sbSlots");
    slots.innerHTML = "";
    const ids = c?.spellBars[bar] ?? [];
    if (!ids.length) {
      slots.appendChild(Object.assign(document.createElement("div"), { className: "empty", textContent: "Empty. Add spells from the Spells panel with +." }));
    }
    ids.forEach((id, i) => {
      const s = deps.spell(id);
      const b = document.createElement("button");
      b.className = "sb" + (current?.spellId === id ? " casting" : queue.some((q) => q.spellId === id) ? " queued" : "");
      const img = document.createElement("img");
      img.alt = "";
      if (s) deps.icon(s.iconId).then((u) => { if (u) img.src = u; });
      b.appendChild(img);
      if (i < 10) b.appendChild(Object.assign(document.createElement("span"), { className: "n", textContent: String((i + 1) % 10) }));
      b.title = `${s?.name ?? `spell ${id}`}${s ? ` — ${s.baseMana} mana` : ""}\nclick or press ${i < 10 ? (i + 1) % 10 : "-"} to cast; right-click to remove`;
      b.onclick = () => castSpell(id);
      b.oncontextmenu = (e) => { e.preventDefault(); removeFromBar(id); };
      slots.appendChild(b);
    });
    if (state === "idle" && !queue.length && !batchTotal) status(`${barName()}${inMagic ? "" : " — not in magic mode"}`);
  }

  return {
    show() { root.classList.add("show"); render(); },
    render,
    castSlot(i: number) { const id = deps.client()?.spellBars[bar]?.[i]; if (id !== undefined) castSpell(id); },
    addToBar,
    get barName() { return barName(); },
    /** our own stance changed (from the server's motion messages) */
    onStance(stance: number) {
      const was = inMagic;
      inMagic = (stance & 0xffff) === 0x49;
      if (inMagic && state === "entering") { state = "cooldown"; timer = 0.8; } // let the wand come out
      if (inMagic !== was) render();
    },
    /** the server finished an action; only matters while we are waiting on a cast */
    onUseDone(code: number, text: string) {
      if (state !== "casting" || !current) return;
      const done = current;
      current = null;
      if (code && /too busy/i.test(text) && (done.retries ?? 0) < 2) {
        queue.unshift({ ...done, retries: (done.retries ?? 0) + 1 });
      } else {
        if (code) deps.log(`${done.label}: ${text}`, "c-magic");
        if (batchTotal) batchDone++;
      }
      state = "cooldown"; timer = 0.25;
    },
    tick(dt: number) {
      if (state === "idle") return;
      timer -= dt;
      if (timer > 0) return;
      if (state === "entering") {
        deps.log("could not enter magic mode", "c-error");
        queue.length = 0; batchTotal = 0;
        state = "idle"; status("");
        render();
        return;
      }
      if (state === "casting") { deps.log(`${current?.label ?? "cast"}: no answer from the server`, "c-error"); current = null; }
      state = "idle";
      pump();
    },
  };
}
