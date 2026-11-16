# Rackwright Web — API contract

The web version is the Tauri 2.0 React front end (`rackwright-tauri/src`) served by a Rust (axum) server
(`web/server`). The server reuses the desktop app's `model.rs`, `geom.rs` and `router.rs` unchanged via
`#[path]` modules, so cable routing is identical to the desktop app.

## Layout

```
rackwright-tauri/        desktop app (unchanged behaviour) + shared React front end
  src/backend.ts         picks Tauri or HTTP backend at build time (VITE_TARGET=web)
web/
  API.md                 this file
  server/                Rust crate `rackwright-server` (binary `rackwright-server`)
  dist/                  web build of the front end (git-ignored, built by `npm run build:web`)
proxmox/ct/rackwright.sh                 host script: create LXC / `update` inside the LXC
proxmox/install/rackwright-install.sh    runs inside the LXC
.github/workflows/web.yml                CI: cargo build+test, npm build:web, shellcheck
```

## Runtime configuration (environment)

| Var         | Default        | Meaning                                  |
|-------------|----------------|------------------------------------------|
| `RW_DATA`   | `./data`       | data dir; SQLite file `rackwright.db`    |
| `RW_HOST`   | `127.0.0.1`    | bind address (LXC uses `0.0.0.0`)        |
| `RW_PORT`   | `8080`         | port                                     |
| `RW_STATIC` | `./web/dist`   | front-end files; SPA fallback to index   |

`GET /healthz` → `200 ok` (no auth).

## Conventions

- JSON in and out. Every error is `{"error": "human readable message"}` with a fitting status
  (400 bad input, 401 not signed in, 403 not admin, 404 missing, 409 conflict).
- Session cookie `rw_session`: random 32-byte token (hex), `HttpOnly; SameSite=Lax; Path=/`, 30 days.
  Stored hashed (SHA-256) in the DB.
- Passwords: argon2id. Minimum length 8.
- Everything under `/api` except `setup`, `login`, `GET /api/setup` needs a session.
- `User` = `{"id": int, "email": str, "name": str, "is_admin": bool}`.
- Timestamps are RFC 3339 UTC strings.

## Setup and sign-in

| Method & path            | Body                              | Result |
|--------------------------|-----------------------------------|--------|
| `GET /api/setup`         | —                                 | `{"needs_setup": bool}` (true when there are no users) |
| `POST /api/setup`        | `{email, name, password}`         | creates the first user as admin, signs in, returns `User`. 409 if users exist |
| `POST /api/login`        | `{email, password}`               | sets cookie, returns `User`. 401 `"Wrong email or password"` |
| `POST /api/logout`       | —                                 | clears session, `{}` |
| `GET /api/me`            | —                                 | `User` or 401 |
| `POST /api/me/password`  | `{current, new}`                  | `{}`; 400 if current is wrong |

Email compare is case-insensitive (store lower-cased).

## Users (admin only)

There is no email delivery. An admin creates an account with a starting password and tells the person.

| Method & path              | Body                                         | Result |
|----------------------------|----------------------------------------------|--------|
| `GET /api/users`           | —                                            | `[User]` |
| `POST /api/users`          | `{email, name, password, is_admin}`          | `User`; 409 if email taken |
| `PATCH /api/users/:id`     | any of `{name, is_admin, password}`          | `User` |
| `DELETE /api/users/:id`    | —                                            | `{}`; 400 when deleting yourself or the last admin. Their sessions are removed |

Demoting the last admin is also refused (400).

## Racks (shared: every signed-in user sees and edits all of them)

`RackMeta` = `{"id": int, "name": str, "version": int, "updated_at": str, "updated_by": str /* user name */}`

| Method & path            | Body                          | Result |
|--------------------------|-------------------------------|--------|
| `GET /api/racks`         | —                             | `[RackMeta]`, newest `updated_at` first |
| `POST /api/racks`        | `{name, doc}`                 | `RackMeta` (version 1) |
| `GET /api/racks/:id`     | —                             | `RackMeta` + `"doc": Doc` |
| `PUT /api/racks/:id`     | `{name, doc, version}`        | `RackMeta` with version+1. If `version` ≠ stored version → 409 `{"error": "...", "version": current, "updated_by": name}` |
| `DELETE /api/racks/:id`  | —                             | `{}` |

`doc` is the same `.rack.json` document the desktop app saves. The server stores the JSON text as received
(after checking it parses as the `Doc` model) so unknown fields survive.

## Compute (same as the desktop Tauri commands)

| Method & path               | Body              | Result |
|-----------------------------|-------------------|--------|
| `POST /api/route_cables`    | `{doc, face}`     | `RouteResult` (exactly what `router::route_all` returns) |
| `POST /api/port_positions`  | `{doc}`           | `[[id, x, y, s], ...]` (same as Tauri `port_positions`) |

Request body limit: 20 MB.
