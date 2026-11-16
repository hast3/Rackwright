// Web-only UI pieces: users panel, shared rack list, dialogs. Only rendered when VITE_TARGET === "web".
import { ReactNode, useCallback, useEffect, useState } from "react";
import * as A from "./api";
import { RackMeta, User } from "./api";

export const btn = { background: "#2a2d33", color: "#e6e8eb", border: "1px solid #3a3d42", borderRadius: 4, padding: "5px 12px", marginRight: 5, cursor: "pointer" } as const;
export const inp = { background: "#14161a", color: "#e6e8eb", border: "1px solid #3a3d42", borderRadius: 4, padding: "4px 6px" } as const;
const errStyle = { color: "#f85149", fontSize: 12, margin: "6px 0" } as const;
export const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Modal({ title, onClose, children, width = 520 }: { title: string; onClose?: () => void; children: ReactNode; width?: number }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "#000a", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
      <div style={{ background: "#1b1d21", padding: 14, borderRadius: 6, width, maxWidth: "94vw", maxHeight: "88vh", overflow: "auto", border: "1px solid #3a3d42", color: "#e6e8eb", fontSize: 13 }}>
        <div style={{ display: "flex", marginBottom: 10 }}>
          <b style={{ flex: 1, fontSize: 14 }}>{title}</b>
          {onClose && <button style={{ ...btn, marginRight: 0, padding: "1px 8px" }} onClick={onClose}>x</button>}
        </div>
        {children}
      </div>
    </div>
  );
}

export const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label style={{ display: "block", marginBottom: 8, fontSize: 12 }}>{label}<br />{children}</label>
);

export interface WebProps { user: User; signOut: () => void; setUser: (u: User) => void }

/** Header controls: user name, Change password, Users (admin), Sign out. */
export function UserBar({ web }: { web: WebProps }) {
  const [pw, setPw] = useState(false);
  const [users, setUsers] = useState(false);
  return (
    <span style={{ float: "right", fontSize: 12 }}>
      <span style={{ opacity: 0.8, marginRight: 8 }}>{web.user.name}{web.user.is_admin ? " (admin)" : ""}</span>
      <button style={btn} onClick={() => setPw(true)}>Change password</button>
      {web.user.is_admin && <button style={btn} onClick={() => setUsers(true)}>Users</button>}
      <button style={{ ...btn, marginRight: 0 }} onClick={web.signOut}>Sign out</button>
      {pw && <ChangePassword onClose={() => setPw(false)} />}
      {users && <UsersPanel me={web.user} onMe={web.setUser} onClose={() => setUsers(false)} />}
    </span>
  );
}

function ChangePassword({ onClose }: { onClose: () => void }) {
  const [cur, setCur] = useState("");
  const [nw, setNw] = useState("");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState(false);
  const go = async () => { setErr(""); try { await A.changePassword(cur, nw); setOk(true); } catch (e) { setErr(msgOf(e)); } };
  return (
    <Modal title="Change password" onClose={onClose} width={320}>
      <Field label="Current password"><input style={{ ...inp, width: "100%" }} type="password" value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
      <Field label="New password (min 8 characters)"><input style={{ ...inp, width: "100%" }} type="password" value={nw} onChange={(e) => setNw(e.target.value)} /></Field>
      {err && <div style={errStyle}>{err}</div>}
      {ok && <div style={{ color: "#2ea043", fontSize: 12, margin: "6px 0" }}>Password changed.</div>}
      <button style={btn} onClick={go} disabled={!cur || !nw || ok}>Change</button>
      <button style={btn} onClick={onClose}>{ok ? "Close" : "Cancel"}</button>
    </Modal>
  );
}

function UsersPanel({ me, onMe, onClose }: { me: User; onMe: (u: User) => void; onClose: () => void }) {
  const [list, setList] = useState<User[]>([]);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [nu, setNu] = useState({ email: "", name: "", password: "", is_admin: false });
  const reload = useCallback(async () => { try { setList(await A.listUsers()); } catch (e) { setErr(msgOf(e)); } }, []);
  useEffect(() => { reload(); }, [reload]);
  const run = async (f: () => Promise<unknown>, okMsg = "") => {
    setErr(""); setNote("");
    try { await f(); setNote(okMsg); await reload(); return true; } catch (e) { setErr(msgOf(e)); return false; }
  };
  const patch = (u: User, p: { name?: string; is_admin?: boolean; password?: string }, okMsg = "") =>
    run(async () => { const r = await A.patchUser(u.id, p); if (r.id === me.id) onMe(r); }, okMsg);
  const rename = (u: User) => { const n = prompt("New name", u.name); if (n && n.trim() && n !== u.name) patch(u, { name: n.trim() }); };
  const reset = (u: User) => { const p = prompt(`New password for ${u.name} (min 8 characters)`); if (p) patch(u, { password: p }, `Password reset for ${u.name}.`); };
  const remove = (u: User) => { if (confirm(`Delete ${u.name} (${u.email})?`)) run(() => A.deleteUser(u.id)); };
  const add = async () => { if (await run(() => A.addUser(nu), `Added ${nu.name}.`)) setNu({ email: "", name: "", password: "", is_admin: false }); };
  const th = { textAlign: "left", fontWeight: 600, padding: "3px 6px", opacity: 0.7 } as const;
  const td = { padding: "3px 6px", borderTop: "1px solid #24272c" } as const;
  const sm = { ...btn, padding: "2px 8px", marginRight: 3, fontSize: 11 } as const;
  return (
    <Modal title="Users" onClose={onClose} width={720}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead><tr><th style={th}>Name</th><th style={th}>Email</th><th style={th}>Admin</th><th style={th}></th></tr></thead>
        <tbody>
          {list.map((u) => (
            <tr key={u.id}>
              <td style={td}>{u.name}{u.id === me.id ? " (you)" : ""}</td>
              <td style={td}>{u.email}</td>
              <td style={td}><input type="checkbox" checked={u.is_admin} onChange={(e) => patch(u, { is_admin: e.target.checked })} /></td>
              <td style={{ ...td, whiteSpace: "nowrap" }}>
                <button style={sm} onClick={() => rename(u)}>Rename</button>
                <button style={sm} onClick={() => reset(u)}>Reset password</button>
                <button style={{ ...sm, color: "#f85149" }} onClick={() => remove(u)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 14, fontSize: 12, opacity: 0.8 }}>Add a user. There is no email: tell them their starting password.</div>
      <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap", alignItems: "center" }}>
        <input style={{ ...inp, width: 170 }} placeholder="Email" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} />
        <input style={{ ...inp, width: 120 }} placeholder="Name" value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} />
        <input style={{ ...inp, width: 140 }} type="password" placeholder="Starting password" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} />
        <label style={{ fontSize: 12 }}><input type="checkbox" checked={nu.is_admin} onChange={(e) => setNu({ ...nu, is_admin: e.target.checked })} /> admin</label>
        <button style={{ ...btn, marginRight: 0 }} onClick={add} disabled={!nu.email || !nu.name || !nu.password}>Add</button>
      </div>
      {err && <div style={errStyle}>{err}</div>}
      {note && <div style={{ color: "#2ea043", fontSize: 12, margin: "6px 0" }}>{note}</div>}
    </Modal>
  );
}

/** Shared rack list with open and delete. */
export function RackList({ currentId, onOpen, onClose }: { currentId: number | null; onOpen: (m: RackMeta) => void; onClose: () => void }) {
  const [list, setList] = useState<RackMeta[] | null>(null);
  const [err, setErr] = useState("");
  const reload = useCallback(async () => { try { setList(await A.listRacks()); } catch (e) { setErr(msgOf(e)); } }, []);
  useEffect(() => { reload(); }, [reload]);
  const remove = async (m: RackMeta) => {
    if (!confirm(`Delete "${m.name}" for everyone? This cannot be undone.`)) return;
    setErr(""); try { await A.deleteRack(m.id); await reload(); } catch (e) { setErr(msgOf(e)); }
  };
  const td = { padding: "4px 6px", borderTop: "1px solid #24272c" } as const;
  return (
    <Modal title="Shared racks" onClose={onClose} width={640}>
      {err && <div style={errStyle}>{err}</div>}
      {list && !list.length && <div style={{ opacity: 0.7 }}>No racks saved yet. Use Save to add the current one.</div>}
      {!list && !err && <div style={{ opacity: 0.7 }}>Loading...</div>}
      {list && list.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead><tr>{["Name", "Updated by", "When", ""].map((h) => <th key={h} style={{ textAlign: "left", padding: "3px 6px", opacity: 0.7 }}>{h}</th>)}</tr></thead>
          <tbody>
            {list.map((m) => (
              <tr key={m.id} style={{ background: m.id === currentId ? "#2a3a52" : undefined }}>
                <td style={td}>{m.name}</td><td style={td}>{m.updated_by}</td>
                <td style={td}>{new Date(m.updated_at).toLocaleString()}</td>
                <td style={{ ...td, whiteSpace: "nowrap" }}>
                  <button style={{ ...btn, padding: "2px 8px", marginRight: 3 }} onClick={() => onOpen(m)}>Open</button>
                  <button style={{ ...btn, padding: "2px 8px", marginRight: 0, color: "#f85149" }} onClick={() => remove(m)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

export function NamePrompt({ title, initial, onOk, onCancel }: { title: string; initial: string; onOk: (n: string) => void; onCancel: () => void }) {
  const [n, setN] = useState(initial);
  return (
    <Modal title={title} onClose={onCancel} width={340}>
      <form onSubmit={(e) => { e.preventDefault(); if (n.trim()) onOk(n.trim()); }}>
        <Field label="Rack name"><input style={{ ...inp, width: "100%" }} autoFocus value={n} onChange={(e) => setN(e.target.value)} /></Field>
        <button style={btn} disabled={!n.trim()}>Save</button>
        <button type="button" style={btn} onClick={onCancel}>Cancel</button>
      </form>
    </Modal>
  );
}

export function ConflictDialog({ by, onTheirs, onMine, onCancel }: { by: string; onTheirs: () => void; onMine: () => void; onCancel: () => void }) {
  return (
    <Modal title="Someone else changed this rack" onClose={onCancel} width={460}>
      <div style={{ marginBottom: 12 }}>{by ? <b>{by}</b> : "Another user"} saved a newer version since you opened it.</div>
      <button style={btn} onClick={onTheirs}>Reload theirs (discard mine)</button>
      <button style={{ ...btn, color: "#f85149" }} onClick={onMine}>Overwrite with mine</button>
      <button style={{ ...btn, marginRight: 0 }} onClick={onCancel}>Cancel</button>
    </Modal>
  );
}
