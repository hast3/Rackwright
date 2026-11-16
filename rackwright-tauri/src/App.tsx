import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { backend, IS_WEB } from "./backend";
import * as A from "./api";
import { ConflictDialog, NamePrompt, RackList, UserBar, WebProps } from "./web";
import RackView, { Resolver, Sel } from "./RackView";
import { Device, Doc, PortPos, RouteResult } from "./types";
import {
  CATALOG, addRack, buildFromText, checkPlace, clone, deleteDevice, deleteRack, duplicateDevice, fromTpl, newCable,
  placeNew, portOf, protoOf, rackUsage, shapeOf, tplRackStatus,
} from "./edit";

const empty: Doc = { v: 1, nid: 1, racks: [], devices: [], cables: [] };
const none: RouteResult = { routes: [], hints: [] };
const btn = { background: "#2a2d33", color: "#e6e8eb", border: "1px solid #3a3d42", borderRadius: 4, padding: "5px 12px", marginRight: 5, cursor: "pointer" } as const;
const inp = { background: "#14161a", color: "#e6e8eb", border: "1px solid #3a3d42", borderRadius: 4, padding: "4px 6px" } as const;

const PROTOS = CATALOG.map((t) => protoOf(t));
const TYPES = Array.from(new Set(CATALOG.map((t) => t.type))).sort();
const icon = (i: number) => {
  const s = shapeOf({ ...PROTOS[i], rack: null });
  return s === "disc" ? "●" : s === "squircle" ? "▢" : "▬";
};

interface Cur { id: number; name: string; version: number }

export default function App({ web }: { web?: WebProps } = {}) {
  const [doc, setDoc] = useState<Doc>(empty);
  const [undo, setUndo] = useState<Doc[]>([]);
  const [redo, setRedo] = useState<Doc[]>([]);
  const [dirty, setDirty] = useState(false);
  const [path, setPath] = useState<string | null>(null);
  // Web only: the shared rack being edited (null = not saved yet), and the dialogs around it.
  const [cur, setCur] = useState<Cur | null>(null);
  const [showRacks, setShowRacks] = useState(false);
  const [nameAsk, setNameAsk] = useState<{ title: string; initial: string; cb: (n: string) => void } | null>(null);
  const [conflict, setConflict] = useState<{ by: string } | null>(null);
  const [face, setFace] = useState<"front" | "rear">("front");
  const [routes, setRoutes] = useState<RouteResult>(none);
  const [ports, setPorts] = useState<PortPos[]>([]);
  const [sel, setSel] = useState<Sel>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [msg, setMsg] = useState("");
  const [toast, setToast] = useState<{ text: string; bad: boolean } | null>(null);
  const [q, setQ] = useState("");
  const [typeF, setTypeF] = useState("");
  const [fitsOnly, setFitsOnly] = useState(false);
  const [palSel, setPalSel] = useState<number | null>(null);
  const [pdrag, setPdrag] = useState<{ i: number; x: number; y: number; active: boolean } | null>(null);
  const [fitTick, setFitTick] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importH, setImportH] = useState("0");
  const resolveRef = useRef<Resolver>(() => ({ kind: "none" }));
  const lastKey = useRef<{ k: string; t: number }>({ k: "", t: 0 });
  const toastTimer = useRef<number>(0);
  const pdragRef = useRef(pdrag);
  pdragRef.current = pdrag;

  const say = useCallback((text: string, bad = false) => {
    setToast({ text, bad });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  }, []);

  useEffect(() => {
    let stale = false;
    backend.routeCables(doc, face).then((r) => { if (!stale) setRoutes(r); }).catch((e) => setMsg(String(e instanceof Error ? e.message : e)));
    backend.portPositions(doc).then((p) => { if (!stale) setPorts(p); }).catch((e) => setMsg(String(e instanceof Error ? e.message : e)));
    return () => { stale = true; };
  }, [doc, face]);

  /** Apply an edit to a copy of the document, with undo. fn returns a status message, or "!msg" to reject the edit.
   *  Repeated edits with the same `key` within ~1.2s (typing in a field) share one undo step. */
  const edit = useCallback((fn: (d: Doc) => string | void, key?: string): boolean => {
    const next = clone(doc);
    const m = fn(next) || "";
    if (m.startsWith("!")) { say(m.slice(1), true); return false; }
    const now = Date.now();
    const merge = !!key && lastKey.current.k === key && now - lastKey.current.t < 1200;
    lastKey.current = { k: key || "", t: now };
    if (!merge) setUndo((u) => [...u.slice(-99), doc]);
    setRedo([]);
    setDoc(next);
    setDirty(true);
    setMsg(m);
    if (m) say(m);
    return true;
  }, [doc, say]);

  const doUndo = useCallback(() => {
    if (!undo.length) return;
    lastKey.current = { k: "", t: 0 };
    setRedo((r) => [...r, doc]); setDoc(undo[undo.length - 1]); setUndo(undo.slice(0, -1)); setDirty(true); setSel(null);
  }, [undo, doc]);
  const doRedo = useCallback(() => {
    if (!redo.length) return;
    lastKey.current = { k: "", t: 0 };
    setUndo((u) => [...u, doc]); setDoc(redo[redo.length - 1]); setRedo(redo.slice(0, -1)); setDirty(true); setSel(null);
  }, [redo, doc]);

  const del = useCallback(() => {
    if (!sel) return;
    edit((d) => {
      if (sel.kind === "cable") d.cables = d.cables.filter((c) => c.id !== sel.id);
      else if (sel.kind === "dev") deleteDevice(d, sel.id);
      else deleteRack(d, sel.id);
    });
    setSel(null);
  }, [sel, edit]);

  const reset = (d: Doc, p: string | null, c: Cur | null = null) => { setDoc(d); setPath(p); setCur(c); setUndo([]); setRedo([]); setSel(null); setPending(null); setDirty(false); setFitTick((n) => n + 1); };
  const doNew = () => { if (!dirty || confirm("Discard unsaved changes?")) reset(clone(empty), null); };
  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const doOpen = async () => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    if (IS_WEB) { setShowRacks(true); return; }
    try {
      const r = await backend.openDoc();
      if (r) { reset(r.doc, r.path); setMsg(""); }
    } catch (e) { setMsg(String(e)); }
  };

  const loadShared = async (id: number) => {
    try {
      const r = await A.getRack(id);
      reset(r.doc, null, { id: r.id, name: r.name, version: r.version });
      setMsg(""); setShowRacks(false);
    } catch (e) { say(errText(e), true); }
  };

  /** Web: PUT the current rack (or POST when new). Handles the 409 conflict flow. */
  const saveShared = useCallback(async (name: string, c: Cur | null, d: Doc) => {
    try {
      const m = c ? await A.updateRack(c.id, name, d, c.version) : await A.createRack(name, d);
      setCur({ id: m.id, name: m.name, version: m.version }); setDirty(false); say("Saved");
    } catch (e) {
      if (e instanceof A.ApiError && e.status === 409 && c) setConflict({ by: String(e.body?.updated_by ?? "") });
      else say(errText(e), true);
    }
  }, [say]);

  const doSave = useCallback(async (asNew = false) => {
    if (IS_WEB) {
      if (cur && !asNew) { saveShared(cur.name, cur, doc); return; }
      setNameAsk({ title: asNew ? "Save as new shared rack" : "Save rack", initial: cur?.name ?? "", cb: (n) => { setNameAsk(null); saveShared(n, null, doc); } });
      return;
    }
    try {
      const p = await backend.saveDoc(asNew ? null : path, doc);
      if (p) { setPath(p); setDirty(false); say("Saved"); }
    } catch (e) { say(String(e), true); }
  }, [path, cur, doc, say, saveShared]);

  const conflictTheirs = async () => { setConflict(null); if (cur) await loadShared(cur.id); };
  const conflictMine = async () => {
    setConflict(null);
    if (!cur) return;
    try {
      const latest = await A.getRack(cur.id); // pick up the current version, then overwrite it
      await saveShared(cur.name, { ...cur, version: latest.version }, doc);
    } catch (e) { say(errText(e), true); }
  };

  const doImportFile = async () => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    try {
      const r = await A.importFile();
      if (r) { reset(r.doc, null); setMsg("Imported " + r.name); }
    } catch (e) { say(errText(e), true); }
  };
  const doExportFile = () => A.exportFile(cur?.name ?? "rack", doc);

  const onPort = (pid: number) => {
    if (pending == null) { setPending(pid); say("Click a second port to connect"); return; }
    if (pending === pid) { setPending(null); return; }
    let newId = 0;
    const ok = edit((d) => {
      const c = newCable(d, pending, pid);
      if (typeof c === "string") return "!" + c;
      newId = c.id;
    });
    if (ok) setSel({ kind: "cable", id: newId });
    setPending(null);
  };

  const onMoveDevice = (id: number, rack: number | null, u: number, side: number, fx: number, fy: number) =>
    edit((d) => {
      const dev = d.devices.find((x) => x.id === id)!;
      dev.rack = rack; if (rack != null) { dev.u = u; dev.side = side; } else { dev.fx = fx; dev.fy = fy; }
    });

  const targetRack = () => {
    const rid = sel?.kind === "rack" ? sel.id : sel?.kind === "dev" ? doc.devices.find((x) => x.id === sel.id)?.rack : null;
    return doc.racks.find((r) => r.id === rid) ?? (doc.racks.length === 1 ? doc.racks[0] : undefined);
  };

  const addFromCatalog = (i: number) => {
    let id = 0;
    const ok = edit((d) => {
      const dev = fromTpl(d, CATALOG[i]);
      id = dev.id;
      return placeNew(d, dev, face, targetRack()?.id ?? null);
    });
    if (ok) setSel({ kind: "dev", id });
  };

  /** A palette drag was released at client (x, y). */
  const dropPalette = useCallback((i: number, x: number, y: number) => {
    const proto = { ...PROTOS[i], face: CATALOG[i].plate ? "both" : face };
    const t = resolveRef.current(proto, x, y);
    if (t.kind === "none") return;
    if (t.kind === "rack" && !t.p.ok) { say(t.p.why || "Can't place it there", true); return; }
    let id = 0;
    const ok = edit((d) => {
      const dev = fromTpl(d, CATALOG[i]);
      id = dev.id; dev.face = proto.face;
      if (t.kind === "rack") { dev.rack = t.r.id; dev.u = t.u; dev.side = t.side; }
      else { dev.rack = null; dev.fx = t.fx; dev.fy = t.fy; }
      d.devices.push(dev);
      if (t.kind === "rack" && t.p.warn) return t.p.warn;
    });
    if (ok) setSel({ kind: "dev", id });
  }, [edit, face, say]);

  const startPdrag = (e: React.MouseEvent, i: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setPalSel(i);
    setPdrag({ i, x: e.clientX, y: e.clientY, active: false });
  };
  const dragging = pdrag != null;
  useEffect(() => {
    if (!dragging) return;
    const mm = (e: MouseEvent) => setPdrag((p) => p && { ...p, x: e.clientX, y: e.clientY, active: p.active || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 4 });
    const mu = (e: MouseEvent) => {
      const p = pdragRef.current; setPdrag(null);
      if (p && p.active) dropPalette(p.i, e.clientX, e.clientY);
    };
    const kd = (e: KeyboardEvent) => { if (e.key === "Escape") setPdrag(null); };
    window.addEventListener("mousemove", mm); window.addEventListener("mouseup", mu); window.addEventListener("keydown", kd);
    return () => { window.removeEventListener("mousemove", mm); window.removeEventListener("mouseup", mu); window.removeEventListener("keydown", kd); };
  }, [dragging, dropPalette]);

  const doImport = () => {
    let n = 0;
    const ok = edit((d) => {
      n = buildFromText(d, importText, parseInt(importH) || 0);
      return n ? `Imported ${n} rack(s)` : "!No rack lines found. Each line needs a size like (2U).";
    });
    if (ok) { setImportOpen(false); setFitTick((k) => k + 1); }
  };

  const selDev = sel?.kind === "dev" ? doc.devices.find((d) => d.id === sel.id) : undefined;
  const selCable = sel?.kind === "cable" ? doc.cables.find((c) => c.id === sel.id) : undefined;
  const selRack = sel?.kind === "rack" ? doc.racks.find((r) => r.id === sel.id) : undefined;

  /** Move/side/rack changes from the properties panel and the arrow keys, with the full sanity check. */
  const place = useCallback((id: number, rackId: number, u: number, side: number) =>
    edit((d) => {
      const dev = d.devices.find((x) => x.id === id)!;
      const r = d.racks.find((x) => x.id === rackId);
      if (!r) return "!No such rack";
      const p = checkPlace(d, dev, r, u, side);
      if (!p.ok) return "!" + (p.why || "Can't place it there");
      dev.rack = rackId; dev.u = u; dev.side = side;
      return p.warn || "";
    }, `place${id}`), [edit]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = (e.target as HTMLElement).tagName;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && k === "s") { e.preventDefault(); doSave(e.shiftKey); return; }
      if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT") return;
      if (e.ctrlKey && k === "z" && e.shiftKey) { e.preventDefault(); doRedo(); }
      else if (e.ctrlKey && k === "z") { e.preventDefault(); doUndo(); }
      else if (e.ctrlKey && k === "y") { e.preventDefault(); doRedo(); }
      else if (e.ctrlKey && k === "d") {
        e.preventDefault();
        if (selDev) { let id = 0; if (edit((d) => { id = duplicateDevice(d, selDev.id)?.id ?? 0; })) setSel({ kind: "dev", id }); }
      }
      else if (e.key === "Delete") del();
      else if (e.key === "Escape") { setPending(null); setSel(null); }
      else if (k === "home") setFitTick((n) => n + 1);
      else if (selDev && selDev.rack != null && e.key.startsWith("Arrow")) {
        e.preventDefault();
        const du = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
        const ds = e.key === "ArrowLeft" ? 0 : e.key === "ArrowRight" ? 1 : selDev.side;
        place(selDev.id, selDev.rack, selDev.u + du, selDev.half ? ds : 0);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [doUndo, doRedo, del, doSave, edit, selDev, place]);

  const rackForTags = targetRack();
  const list = useMemo(() => {
    const t = q.toLowerCase().split(/\s+/).filter(Boolean);
    return CATALOG.map((c, i) => ({ c, i })).filter(({ c, i }) => {
      if (typeF && c.type !== typeF) return false;
      const hay = `${c.name} ${c.type} ${c.group || ""} ${c.model || ""}`.toLowerCase();
      if (!t.every((w) => hay.includes(w))) return false;
      if (fitsOnly && rackForTags) { const s = tplRackStatus(doc, rackForTags, c); if (s === "full") return false; if (s === "ok" || s === "off") return true; }
      void i; return true;
    }).slice(0, 200);
  }, [q, typeF, fitsOnly, rackForTags, doc]);

  const endp = (pid: number) => { const o = portOf(doc, pid); return o ? `${o.d.name} ${o.p.name}` : "?"; };
  const cab = (c: NonNullable<typeof selCable>, patch: Record<string, unknown>) =>
    edit((d) => { Object.assign(d.cables.find((x) => x.id === c.id)!, patch); }, `cab${c.id}`);
  const field = (label: string, val: string | number, set: (v: string) => void, w = 200) => (
    <label style={{ display: "block", marginBottom: 6, fontSize: 12 }}>{label}<br />
      <input style={{ ...inp, width: w }} value={val} onChange={(e) => set(e.target.value)} /></label>
  );
  const devSet = (dv: Device, k: "name" | "ip" | "model" | "serial" | "notes", v: string) =>
    edit((d) => { (d.devices.find((x) => x.id === dv.id)! as any)[k] = v; }, `dev${dv.id}${k}`);
  const dragDev = pdrag && pdrag.active ? { ...PROTOS[pdrag.i], face: CATALOG[pdrag.i].plate ? "both" : face } : null;
  const portsCabled = (dv: Device) => dv.ports.filter((p) => doc.cables.some((c) => c.a === p.id || c.b === p.id)).length;
  const sum = (() => {
    const total = doc.racks.reduce((s, r) => s + r.u, 0);
    const used = doc.racks.reduce((s, r) => s + rackUsage(doc, r).used, 0);
    return { total, used, off: doc.devices.filter((d) => d.rack == null).length };
  })();

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", color: "#e6e8eb", fontFamily: "Segoe UI, sans-serif", userSelect: pdrag ? "none" : undefined }}>
      <div style={{ height: 42, padding: "6px 10px", background: "#1b1d21", borderBottom: "1px solid #2c2f35", boxSizing: "border-box", whiteSpace: "nowrap", overflow: "hidden" }}>
        {IS_WEB && web && <UserBar web={web} />}
        <button style={btn} onClick={doNew}>New</button>
        <button style={btn} onClick={doOpen}>Open</button>
        <button style={btn} onClick={() => doSave()}>Save{dirty ? " *" : ""}</button>
        <button style={btn} onClick={() => doSave(true)}>Save as</button>
        <button style={btn} onClick={doUndo} disabled={!undo.length}>Undo</button>
        <button style={btn} onClick={doRedo} disabled={!redo.length}>Redo</button>
        <button style={btn} onClick={() => edit((d) => { const r = addRack(d); setSel({ kind: "rack", id: r.id }); })}>+ Rack</button>
        {IS_WEB && <button style={btn} onClick={doImportFile} title="Load a .rack.json file from this computer">Import file</button>}
        {IS_WEB && <button style={btn} onClick={doExportFile} title="Download as .rack.json">Export file</button>}
        <button style={btn} onClick={() => setImportOpen(true)}>Import list</button>
        <button style={btn} onClick={() => setFitTick((n) => n + 1)} title="Home">Fit</button>
        <button style={btn} onClick={() => setFace(face === "front" ? "rear" : "front")}>Showing: {face} (flip)</button>
        <span style={{ opacity: 0.7, fontSize: 12, marginLeft: 8 }}>
          {IS_WEB ? (cur ? `${cur.name} (v${cur.version})` : "unsaved rack") : (path ?? "no file")} | {doc.racks.length}R {doc.devices.length}D {doc.cables.length}C {msg}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div style={{ width: 270, background: "#1b1d21", borderRight: "1px solid #2c2f35", display: "flex", flexDirection: "column", fontSize: 12 }}>
          <input style={{ ...inp, margin: "6px 6px 3px" }} placeholder="Search devices (dell r650, ups, 48...)" value={q} onChange={(e) => setQ(e.target.value)} />
          <div style={{ display: "flex", gap: 6, margin: "0 6px 4px", alignItems: "center" }}>
            <select style={{ ...inp, flex: 1, minWidth: 0 }} value={typeF} onChange={(e) => setTypeF(e.target.value)}>
              <option value="">All types</option>
              {TYPES.map((t) => <option key={t}>{t}</option>)}
            </select>
            <label title="Hide items with no free slot in the selected rack"><input type="checkbox" checked={fitsOnly} onChange={(e) => setFitsOnly(e.target.checked)} /> fits</label>
          </div>
          <div style={{ padding: "0 8px 4px", opacity: 0.55 }}>Drag into a rack, or double-click to add</div>
          <div style={{ flex: 1, overflow: "auto" }}>
            {list.map(({ c, i }) => {
              const st = rackForTags ? tplRackStatus(doc, rackForTags, c) : c.plate?.off ? "off" : "none";
              return (
                <div className="cat" key={i} onMouseDown={(e) => startPdrag(e, i)} onDoubleClick={() => addFromCatalog(i)}
                  title="Drag into the rack, or double-click to add"
                  style={{ padding: "4px 8px", borderBottom: "1px solid #24272c", cursor: "grab", background: palSel === i ? "#2a3a52" : undefined, opacity: st === "full" ? 0.5 : 1 }}>
                  <span style={{ opacity: 0.6, marginRight: 6 }}>{icon(i)}</span>{c.name}{" "}
                  <span style={{ opacity: 0.55 }}>{c.u_size}U {c.type}{c.half ? " half" : ""}</span>
                  {st === "off" && <span style={{ color: "#d29922" }}> off-rack</span>}
                  {st === "full" && <span style={{ color: "#f85149" }}> no room</span>}
                </div>
              );
            })}
            {!list.length && <div style={{ padding: 10, opacity: 0.6 }}>Nothing matches.</div>}
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
          <RackView doc={doc} face={face} routes={routes} ports={ports} selected={sel} onSelect={setSel}
            pendingPort={pending} onPort={onPort} onMoveDevice={onMoveDevice} onReject={(w) => say(w, true)}
            drag={dragDev ? { dev: dragDev as Device, x: pdrag!.x, y: pdrag!.y } : null} resolveRef={resolveRef} fitTick={fitTick} />
          {toast && (
            <div style={{ position: "absolute", left: "50%", bottom: 14, transform: "translateX(-50%)", padding: "6px 14px", borderRadius: 5, fontSize: 13,
              background: toast.bad ? "#5a1d1d" : "#1d3a2a", border: `1px solid ${toast.bad ? "#f85149" : "#2ea043"}`, pointerEvents: "none" }}>{toast.text}</div>
          )}
        </div>
        <div style={{ width: 240, background: "#1b1d21", borderLeft: "1px solid #2c2f35", padding: 8, overflow: "auto" }}>
          {!sel && <>
            <b>Overview</b>
            <div style={{ fontSize: 12, marginTop: 6, lineHeight: 1.7 }}>
              {doc.racks.length} rack(s), {sum.used}/{sum.total}U used<br />
              {doc.devices.length} devices ({sum.off} off-rack)<br />
              {doc.cables.length} cables<br />
              <span style={{ opacity: 0.6 }}>Click a device, rack or cable to edit it. Arrow keys nudge a selected device, Ctrl+D duplicates, Home fits the view.</span>
            </div>
          </>}
          {selRack && <>
            <b>Rack</b>
            {field("Name", selRack.name, (v) => edit((d) => { d.racks.find((r) => r.id === selRack.id)!.name = v; }, `rn${selRack.id}`))}
            {field("Height (U)", selRack.u, (v) => edit((d) => {
              const r = d.racks.find((x) => x.id === selRack.id)!;
              const n = Math.max(1, Math.min(60, parseInt(v) || 1));
              const top = d.devices.filter((x) => x.rack === r.id).reduce((m, x) => Math.max(m, x.u + x.u_size - 1), 0);
              if (n < top) return `!U${top} is occupied: remove or move devices first`;
              r.u = n;
            }, `rh${selRack.id}`), 60)}
            <div style={{ fontSize: 12, opacity: 0.7 }}>{rackUsage(doc, selRack).used}U used, {rackUsage(doc, selRack).free}U free</div>
          </>}
          {selDev && <>
            <b>{selDev.type}</b>
            {field("Name", selDev.name, (v) => devSet(selDev, "name", v))}
            {field("Model", selDev.model ?? "", (v) => devSet(selDev, "model", v))}
            {field("IP", selDev.ip ?? "", (v) => devSet(selDev, "ip", v))}
            {field("Serial", selDev.serial ?? "", (v) => devSet(selDev, "serial", v))}
            <label style={{ display: "block", marginBottom: 6, fontSize: 12 }}>Notes<br />
              <textarea style={{ ...inp, width: 200, height: 46 }} value={selDev.notes ?? ""} onChange={(e) => devSet(selDev, "notes", e.target.value)} /></label>
            <label style={{ fontSize: 12 }}>Rack<br />
              <select style={{ ...inp, width: 208 }} value={selDev.rack ?? ""} onChange={(e) => {
                const v = e.target.value;
                if (v === "") { edit((d) => { const x = d.devices.find((y) => y.id === selDev.id)!; x.fx = x.fx || 40; x.fy = x.fy || 40; x.rack = null; }); return; }
                const r = doc.racks.find((x) => x.id === Number(v))!;
                const probe = { ...selDev, rack: r.id };
                for (let u = r.u - selDev.u_size + 1; u >= 1; u--) for (const s of selDev.half ? [0, 1] : [0])
                  if (checkPlace(doc, probe, r, u, s).ok) { place(selDev.id, r.id, u, s); return; }
                say(`No room in ${r.name} for ${selDev.name}`, true);
              }}>
                <option value="">(off-rack)</option>
                {doc.racks.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select></label>
            {selDev.rack != null && <div style={{ display: "flex", gap: 8, margin: "6px 0", fontSize: 12 }}>
              <label>U<br /><input type="number" style={{ ...inp, width: 56 }} value={selDev.u} min={1}
                onChange={(e) => { const n = parseInt(e.target.value); if (n) place(selDev.id, selDev.rack!, n, selDev.side); }} /></label>
              {selDev.half && <label>Side<br /><select style={inp} value={selDev.side} onChange={(e) => place(selDev.id, selDev.rack!, selDev.u, Number(e.target.value))}>
                <option value={0}>left</option><option value={1}>right</option></select></label>}
              <label>Mounted<br />
                <select style={inp} value={selDev.face} disabled={!!selDev.plate} onChange={(e) => edit((d) => {
                  const x = d.devices.find((y) => y.id === selDev.id)!; x.face = e.target.value;
                  const r = d.racks.find((z) => z.id === x.rack);
                  if (r) { const p = checkPlace(d, x, r, x.u, x.side); if (!p.ok) return "!" + p.why; }
                })}>
                  <option>front</option><option>rear</option><option>both</option>
                </select></label>
            </div>}
            <div style={{ fontSize: 12, margin: "6px 0", opacity: 0.7 }}>
              {selDev.u_size}U, {selDev.ports.length} ports ({portsCabled(selDev)} cabled). Drag to move; click a port, then another, to cable.
            </div>
            <button style={btn} onClick={() => { let id = 0; if (edit((d) => { id = duplicateDevice(d, selDev.id)?.id ?? 0; })) setSel({ kind: "dev", id }); }}>Duplicate</button>
          </>}
          {selCable && <>
            <b>Cable</b>
            <div style={{ fontSize: 12, margin: "6px 0" }}>{endp(selCable.a)}<br />to {endp(selCable.b)}</div>
            {field("Label", selCable.label ?? "", (v) => cab(selCable, { label: v }))}
            <label style={{ fontSize: 12 }}>Colour<br />
              <input type="color" value={selCable.color || "#1f6feb"} onChange={(e) => cab(selCable, { color: e.target.value })} /></label>
            <label style={{ fontSize: 12, display: "block", margin: "6px 0" }}>Style<br />
              <select style={inp} value={selCable.style ?? "solid"} onChange={(e) => cab(selCable, { style: e.target.value })}>
                <option>solid</option><option>dashed</option>
              </select></label>
          </>}
          {sel && <button style={{ ...btn, marginTop: 10, color: "#f85149" }} onClick={del}>Delete</button>}
        </div>
      </div>
      {routes.hints.length > 0 && (
        <div style={{ maxHeight: 70, overflow: "auto", background: "#1b1d21", fontSize: 12, padding: 6, borderTop: "1px solid #2c2f35" }}>
          {routes.hints.map((h, i) => <div key={i}>! {h.msg}</div>)}
        </div>
      )}
      {pdrag && pdrag.active && (
        <div style={{ position: "fixed", left: pdrag.x + 12, top: pdrag.y + 8, pointerEvents: "none", background: "#2a3a52", border: "1px solid #5b8bd0",
          borderRadius: 4, padding: "2px 8px", fontSize: 12, zIndex: 50 }}>{icon(pdrag.i)} {CATALOG[pdrag.i].name}</div>
      )}
      {IS_WEB && showRacks && <RackList currentId={cur?.id ?? null} onClose={() => setShowRacks(false)} onOpen={(m) => loadShared(m.id)} />}
      {IS_WEB && nameAsk && <NamePrompt title={nameAsk.title} initial={nameAsk.initial} onOk={nameAsk.cb} onCancel={() => setNameAsk(null)} />}
      {IS_WEB && conflict && <ConflictDialog by={conflict.by} onTheirs={conflictTheirs} onMine={conflictMine} onCancel={() => setConflict(null)} />}
      {importOpen && (
        <div style={{ position: "fixed", inset: 0, background: "#000a", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#1b1d21", padding: 14, borderRadius: 6, width: 520, border: "1px solid #3a3d42" }}>
            <div style={{ fontSize: 12, marginBottom: 6, opacity: 0.8 }}>Paste a list, top of rack first, e.g. "Rack1", "- Panel A - (2U)", "- Open - (12U)". Open/Empty/Free leave a gap; add "rear" to mount on the back.</div>
            <textarea style={{ ...inp, width: "100%", height: 260, boxSizing: "border-box" }} value={importText} onChange={(e) => setImportText(e.target.value)} />
            <div style={{ marginTop: 8, fontSize: 12 }}>Rack height (0 = size to list): <input style={{ ...inp, width: 50 }} value={importH} onChange={(e) => setImportH(e.target.value)} />
              <span style={{ float: "right" }}>
                <button style={btn} onClick={() => setImportOpen(false)}>Cancel</button>
                <button style={{ ...btn, marginRight: 0 }} onClick={doImport}>Build racks</button>
              </span></div>
          </div>
        </div>
      )}
    </div>
  );
}
