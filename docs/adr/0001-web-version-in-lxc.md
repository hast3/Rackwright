# Web version in an LXC

The browser version reuses the Tauri React front end, so the desktop and the web app draw racks the same way. A small Rust server (axum) serves that front end and reuses the desktop `router.rs`, `geom.rs` and `model.rs`, so cables route identically in both. Racks are stored in SQLite in one data folder.

People sign in with an account. The first visitor creates the admin. An admin adds the others on the Users page with a starting password, because the container has no mail. Racks are shared by every signed-in user, and saving checks a version number so two people cannot overwrite each other without notice.

It runs in an unprivileged Debian 13 container on Proxmox, in the same install shape as CW Compare: 2 CPU, 2 GB RAM, 8 GB disk, port 8080. The container builds Rust and Node itself from the public repository, so there is no binary to publish and `update` is a pull and a rebuild. The first build takes several minutes. Data stays in `/var/lib/rackwright` and an update never touches it.
