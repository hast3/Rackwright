# Rackwright

Standalone desktop app (Python 3.11+, tkinter only, no installs) for designing network racks.
Separate from CompAIre.

Run: double-click `Start Rackwright.bat` (or `python rackwright.py [file.rack.json]`).

- Rack view: any rack height, drag devices between U slots/racks (green/red ghost), half-width devices, off-rack devices.
- Front/rear: each device is mounted front, rear or both; "Flip front/rear" shows the back of the racks.
- Cables: click port to port; colour, length + unit, type, label, dashed style. Cable schedule + shopping list, CSV export.
- Logical view: same cables as device-to-device links with a "Logical connection" note (VLAN/purpose).
- Custom devices: any size, type, colour, ports (bulk add); save as reusable templates.
- File > Import rack list: paste `Rack1 / - Panel A - (2U) / - Open - (12U)` style lists and get a laid-out rack
  (names are mapped to device types; Open/Empty/Free leave gaps; add `rear` to a line for rear mount).
- Undo/redo, SVG export, device list CSV. Saves `.rack.json`.

## Real equipment (front and rear faceplates)
The library has Dell PowerEdge (R230-R760, 1U/2U with the right drive bays), Ubiquiti UniFi 24/48-port switches,
and Synology 4-bay NAS (DS desktop and RS rack). Use "Flip front/rear" to see the back (PSUs, fans, slots).
Imported lists match these by name (e.g. "Dell R650", "UniFi USW Pro 24", "Synology DS923+").

Also included (generic branded faceplates, front and rear): APC Smart-UPS SMT/SMC/SMX/SRT and their battery packs, APC/Eaton PDUs, Eaton 5PX/9PX,
Cisco Catalyst/ASA/Firepower/ISR, Meraki MS/MX/MR, Ruckus ICX, SonicWall TZ/NSa/NSsp, Fortinet, Aruba, Juniper and Palo Alto.
Imports match by model (e.g. "SonicWall NSa 2700", "Catalyst 9300-48P", "ICX7150-48P", "SRT3000RMXLI", "SRT96RMBP").

## Recent changes
- Cabling rewritten: thin cables with small plugs, routed along device edges, down rack-side cable managers and across an overhead tray in parallel lanes with rounded corners and Velcro ties. Power cords are dark.
- Rack-side finger ducts (per rack: both / left / right / none) and rack-mount organizers (Cable manager 1U/2U, Brush panel, D-ring manager).
- Power chains: connect UPS outlet → PDU input → device (power-to-power cables default to a black power cord).
- Multi-select: Shift/Ctrl-click or drag a marquee, then drag to move the group.
- Modern dark UI theme.

## Web version (Proxmox LXC)

On the **Proxmox host** shell (not inside a VM). The repo is public, so no token is needed.

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/hast3/Rackwright/master/proxmox/ct/rackwright.sh)"
```

Default LXC: Debian 13, 2 CPU, 2 GB RAM, 8 GB disk, unprivileged, DHCP on `vmbr0`, port 8080. Choose **No** on the first prompt for Advanced (CTID, VLAN, storage, and the rest). The container builds Rackwright itself, so the first install takes several minutes.

When it finishes it prints `http://<ct-ip>:8080`. The first person to open that address creates the admin account. An admin adds other people on the Users page with a starting password and tells them. There is no email. Racks are shared by all signed-in users.

**Update later** - open the LXC console and type:

```bash
update
```

That pulls the branch the container was installed from (`master` by default), rebuilds, and restarts `rackwright.service`. Data stays in `/var/lib/rackwright` (SQLite file `rackwright.db`) and an update never touches it.

Keep it on the LAN (or Tailscale). Do not publish this URL.

### Run on this PC

Needs Rust and Node. From this folder:

```
cd rackwright-tauri
npm ci
npm run build:web
cd ../web/server
cargo run --release
```

Open http://127.0.0.1:8080. Data is stored in `./data`. Set `RW_DATA`, `RW_HOST`, `RW_PORT` and `RW_STATIC` to change that (see `web/API.md`).
