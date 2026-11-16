// Web-only auth gate: setup / sign-in / app.
import { ReactNode, useEffect, useState } from "react";
import App from "./App";
import * as A from "./api";
import { User } from "./api";
import { Field, btn, inp, msgOf } from "./web";

function Screen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#14161a", color: "#e6e8eb", fontFamily: "Segoe UI, sans-serif" }}>
      <div style={{ background: "#1b1d21", padding: 20, borderRadius: 6, width: 320, border: "1px solid #3a3d42" }}>
        <div style={{ fontSize: 18, marginBottom: 14 }}>Rackwright</div>
        <div style={{ fontSize: 13, marginBottom: 10, opacity: 0.8 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

function AuthForm({ setupMode, onDone }: { setupMode: boolean; onDone: (u: User) => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr("");
    try { onDone(setupMode ? await A.setup(email, name, pw) : await A.login(email, pw)); } catch (x) { setErr(msgOf(x)); }
    setBusy(false);
  };
  return (
    <Screen title={setupMode ? "Create admin account" : "Sign in"}>
      <form onSubmit={submit}>
        <Field label="Email"><input style={{ ...inp, width: "100%" }} type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        {setupMode && <Field label="Name"><input style={{ ...inp, width: "100%" }} value={name} onChange={(e) => setName(e.target.value)} /></Field>}
        <Field label={setupMode ? "Password (min 8 characters)" : "Password"}>
          <input style={{ ...inp, width: "100%" }} type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
        {err && <div style={{ color: "#f85149", fontSize: 12, margin: "6px 0" }}>{err}</div>}
        <button style={{ ...btn, marginRight: 0 }} disabled={busy || !email || !pw || (setupMode && !name)}>{setupMode ? "Create admin account" : "Sign in"}</button>
      </form>
    </Screen>
  );
}

export default function WebShell() {
  const [phase, setPhase] = useState<"loading" | "setup" | "login" | "app" | "down">("loading");
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => { A.setUnauthorizedHandler(() => { setUser(null); setPhase((p) => (p === "app" ? "login" : p)); }); }, []);
  useEffect(() => {
    (async () => {
      try {
        if ((await A.getSetup()).needs_setup) { setPhase("setup"); return; }
        try { setUser(await A.getMe()); setPhase("app"); } catch (e) { if (e instanceof A.ApiError && e.status === 401) setPhase("login"); else throw e; }
      } catch { setPhase("down"); }
    })();
  }, []);

  const signedIn = (u: User) => { setUser(u); setPhase("app"); };
  const signOut = async () => { try { await A.logout(); } catch { /* ignore */ } setUser(null); setPhase("login"); };

  if (phase === "loading") return <Screen title="Loading...">{null}</Screen>;
  if (phase === "down") return <Screen title="Cannot reach the server."><button style={btn} onClick={() => location.reload()}>Retry</button></Screen>;
  if (phase === "setup") return <AuthForm setupMode onDone={signedIn} />;
  if (phase === "login" || !user) return <AuthForm setupMode={false} onDone={signedIn} />;
  return <App web={{ user, signOut, setUser }} />;
}
