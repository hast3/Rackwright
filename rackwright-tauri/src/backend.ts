// Backend abstraction: Tauri commands on the desktop, HTTP on the web (VITE_TARGET=web).
import { Doc, PortPos, RouteResult } from "./types";
import { api } from "./api";

export const IS_WEB = import.meta.env.VITE_TARGET === "web";

export interface Backend {
  routeCables(doc: Doc, face: "front" | "rear"): Promise<RouteResult>;
  portPositions(doc: Doc): Promise<PortPos[]>;
  /** Desktop: native Open dialog. Returns null if cancelled. Not used by the web UI (it uses the shared rack list). */
  openDoc(): Promise<{ path: string; doc: Doc } | null>;
  /** Desktop: save to `path`, or ask with a Save dialog when null. Returns the path used, or null if cancelled. */
  saveDoc(path: string | null, doc: Doc): Promise<string | null>;
}

const filters = [{ name: "Rack", extensions: ["json"] }];

// Tauri modules are only reached through dynamic import() in this function; in the web build it is unreachable and tree-shaken.
function tauriBackend(): Backend {
  const core = () => import("@tauri-apps/api/core");
  const dialog = () => import("@tauri-apps/plugin-dialog");
  return {
    async routeCables(doc, face) { return (await core()).invoke<RouteResult>("route_cables", { doc, face }); },
    async portPositions(doc) { return (await core()).invoke<PortPos[]>("port_positions", { doc }); },
    async openDoc() {
      const p = await (await dialog()).open({ filters });
      if (typeof p !== "string") return null;
      return { path: p, doc: await (await core()).invoke<Doc>("open_doc", { path: p }) };
    },
    async saveDoc(path, doc) {
      const p = path || (await (await dialog()).save({ filters, defaultPath: "rack.rack.json" }));
      if (!p) return null;
      await (await core()).invoke("save_doc", { path: p, doc });
      return p;
    },
  };
}

function webBackend(): Backend {
  return {
    routeCables: (doc, face) => api<RouteResult>("POST", "/api/route_cables", { doc, face }),
    portPositions: (doc) => api<PortPos[]>("POST", "/api/port_positions", { doc }),
    async openDoc() { throw new Error("openDoc is desktop-only"); },
    async saveDoc() { throw new Error("saveDoc is desktop-only"); },
  };
}

export const backend: Backend = IS_WEB ? webBackend() : tauriBackend();
