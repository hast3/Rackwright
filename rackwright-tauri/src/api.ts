// HTTP client for the web build (see web/API.md). Only used when VITE_TARGET === "web".
import { Doc } from "./types";

export interface User { id: number; email: string; name: string; is_admin: boolean }
export interface RackMeta { id: number; name: string; version: number; updated_at: string; updated_by: string }

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: any = {}) { super(message); }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (f: () => void) => { onUnauthorized = f; };

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, {
      method, credentials: "same-origin",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) { throw new ApiError(0, "Cannot reach the server"); }
  let j: any = {};
  try { j = await r.json(); } catch { /* empty or non-JSON body */ }
  if (!r.ok) {
    if (r.status === 401) onUnauthorized();
    throw new ApiError(r.status, j?.error || `Request failed (${r.status})`, j);
  }
  return j as T;
}

export const getSetup = () => api<{ needs_setup: boolean }>("GET", "/api/setup");
export const getMe = () => api<User>("GET", "/api/me");
export const setup = (email: string, name: string, password: string) => api<User>("POST", "/api/setup", { email, name, password });
export const login = (email: string, password: string) => api<User>("POST", "/api/login", { email, password });
export const logout = () => api("POST", "/api/logout");
export const changePassword = (current: string, next: string) => api("POST", "/api/me/password", { current, new: next });

export const listUsers = () => api<User[]>("GET", "/api/users");
export const addUser = (u: { email: string; name: string; password: string; is_admin: boolean }) => api<User>("POST", "/api/users", u);
export const patchUser = (id: number, p: { name?: string; is_admin?: boolean; password?: string }) => api<User>("PATCH", `/api/users/${id}`, p);
export const deleteUser = (id: number) => api("DELETE", `/api/users/${id}`);

export const listRacks = () => api<RackMeta[]>("GET", "/api/racks");
export const getRack = (id: number) => api<RackMeta & { doc: Doc }>("GET", `/api/racks/${id}`);
export const createRack = (name: string, doc: Doc) => api<RackMeta>("POST", "/api/racks", { name, doc });
export const updateRack = (id: number, name: string, doc: Doc, version: number) => api<RackMeta>("PUT", `/api/racks/${id}`, { name, doc, version });
export const deleteRack = (id: number) => api("DELETE", `/api/racks/${id}`);

/** Browser file input -> parsed .rack.json. Resolves null when cancelled. */
export function importFile(): Promise<{ name: string; doc: Doc } | null> {
  return new Promise((resolve, reject) => {
    const i = document.createElement("input");
    i.type = "file"; i.accept = ".json,application/json";
    i.onchange = async () => {
      const f = i.files?.[0];
      if (!f) { resolve(null); return; }
      try {
        const doc = JSON.parse(await f.text());
        if (!doc || !Array.isArray(doc.racks) || !Array.isArray(doc.devices) || !Array.isArray(doc.cables)) throw new Error("Not a Rackwright file");
        resolve({ name: f.name.replace(/\.rack\.json$|\.json$/i, ""), doc });
      } catch (e) { reject(new Error("Could not read that file: " + (e instanceof Error ? e.message : String(e)))); }
    };
    i.oncancel = () => resolve(null);
    i.click();
  });
}

/** Download the document as <name>.rack.json. */
export function exportFile(name: string, doc: Doc) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 1)], { type: "application/json" }));
  a.download = `${name.replace(/[\/:*?"<>|]+/g, "_") || "rack"}.rack.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
