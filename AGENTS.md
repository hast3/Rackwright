# AGENTS.md

Rackwright designs network racks: rack and logical views, real equipment faceplates (front and rear), cables routed through ducts and trays, power chains, rack-list import. One React front end ships two ways:

- **Desktop**: the Tauri 2.0 app (`rackwright-tauri/`, Rust + React). The original Python/tkinter app (`rackwright.py`) is still here.
- **Web**: the same React screens served by a Rust server (`web/server`), with sign-in and shared racks, installed in a Proxmox LXC.

## Layout

- `rackwright-tauri/src/` — React front end for both. `backend.ts` picks Tauri or HTTP by `import.meta.env.VITE_TARGET` (`IS_WEB`). `api.ts` is the HTTP client. `web.tsx` and `WebShell.tsx` are the web-only screens (sign-in, Users, rack list, save conflict).
- `rackwright-tauri/src-tauri/` — desktop Rust: Tauri commands (`lib.rs`), document model (`model.rs`), geometry (`geom.rs`), cable router (`router.rs`).
- `web/API.md` — the HTTP contract. Change it first when changing an endpoint.
- `web/server/` — Rust axum server, SQLite (`rusqlite` bundled), argon2 passwords, cookie sessions. Tests in `web/server/tests/api.rs`.
- `Homelab.rack.json` — synthetic example rack. The router's unit tests read it. Keep it realistic and free of real names, addresses and serials.
- `proxmox/ct/rackwright.sh` (Proxmox host; also the `update` command inside the LXC) and `proxmox/install/rackwright-install.sh` (inside the LXC).
- `.github/workflows/web.yml` (CI), `.github/workflows/sync-upstream.yml` (forks only, see below).
- `docs/adr/` — decisions. Read them; flag a conflict instead of silently overriding.

## Run and test

Needs Node 22+ and Rust stable. CI always builds and tests both, so a PC without Rust can still work on the front end.

```bash
cd rackwright-tauri && npm ci
npm run build          # desktop type-check + build (must keep passing)
npm run build:web      # web build -> ../web/dist
npx tsx scripts/edit.test.ts
npm run tauri dev      # desktop app (needs the Tauri prerequisites)
cd ../web/server && cargo test   # API tests + the desktop router tests (shared code)
cargo run              # http://127.0.0.1:8080, data in ./data
npm run dev:web        # (in rackwright-tauri) Vite dev server, proxies /api to :8080
```

Server environment: `RW_DATA`, `RW_HOST`, `RW_PORT`, `RW_STATIC` (see `web/API.md`). On the LXC: app in `/opt/rackwright`, data in `/var/lib/rackwright`, service `rackwright.service`. `update` pulls the repository and branch the container was installed from and rebuilds.

## Keeping desktop and web together

- The desktop build must keep working. Web-only code lives in its own files; edits to shared files (`App.tsx`, `main.tsx`, `vite.config.ts`, `package.json`) stay small and behind `IS_WEB`.
- The server reuses `model.rs`, `geom.rs` and `router.rs` through `#[path]` modules. Never copy them. A change to their signatures needs a matching change in `web/server/src/lib.rs`.
- `.rack.json` is one format for the Python app, the desktop app and the web app. Unknown fields must survive a load and save.

## Changelog and versions — every push

1. Every push or pull request adds an entry to `CHANGELOG.md`. CI fails without one.
2. The web version lives in `web/server/Cargo.toml` (`version = "x.y.z"`). The top changelog heading is `## x.y.z — YYYY-MM-DD` and must match it, or be `## Unreleased` while a pull request is open. The desktop version lives in `rackwright-tauri/package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`; bump all three together when the desktop app changes.
3. Bump: patch for fixes, minor for new features, major for breaking data or deployment changes.
4. Write entries for the people who use it: plain sentences that say what changed and what to do. Mention commits by short sha when they come from somewhere else.

## Forks and upstream

hast3/Rackwright is the upstream repository. A fork that deploys its own LXC keeps upstream's work separate from its own:

- Mirror branches (`master`, and optionally `desktop`) only ever fast-forward to upstream `master`. Never commit to them.
- Fork work goes on its own branch (for example `web`), made the fork's default branch so scheduled workflows run.
- **Sync upstream** (`.github/workflows/sync-upstream.yml`, skipped in hast3/Rackwright itself) runs daily or from Actions → Sync upstream → Run workflow. It fast-forwards the mirrors and opens a pull request that merges new upstream commits into the fork branch, with an `## Unreleased` changelog entry and CI started. Before merging, set the version and rename `## Unreleased`. If the merge conflicts, it opens an issue "Upstream merge needs a hand"; merge by hand:

```bash
git remote add upstream https://github.com/hast3/Rackwright.git   # once
git fetch upstream
git switch -c sync/upstream-manual origin/web
git merge --no-ff upstream/master
cd rackwright-tauri && npm ci && npm run build && npm run build:web
# add the changelog entry and version bump, push, open a PR to the fork branch
```

Sending work upstream: open a pull request from a fork branch to `hast3:master`. Keep it to one topic. Merge it with a merge commit or rebase, not squash, so the fork's next sync sees the same commits and does not conflict. Ask the user before opening one; it is public and goes to someone else's repository.

## Conventions

- UI copy is plain language: short sentences, say what the person should do.
- Never commit secrets, the `data/` folder, `web/dist`, `target/` or real customer rack files.
- Keep each branch / pull request to one feature.

## Workflow for agents

1. Ask all clarifying questions up front in ONE numbered list, then work.
2. Branch from the default branch; never push to mirror branches.
3. Before pushing: both front-end builds, `edit.test.ts`, and (where Rust is available) `cargo test`. Add the changelog entry and version bump. Do not push failing code.
4. When done, report what was pushed: branch, commits, PR URL, files changed, and test results.
