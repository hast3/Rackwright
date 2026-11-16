#!/usr/bin/env bash
# Copyright (c) 2026 Hrubak
# Author: Hrubak
# License: MIT | https://github.com/community-scripts/ProxmoxVE/raw/main/LICENSE
# Source: https://github.com/hast3/Rackwright
#
# Community-scripts style installer for Rackwright.
# Run on the Proxmox HOST (not inside a VM):
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/hast3/Rackwright/master/proxmox/ct/rackwright.sh)"
#
# Or copy this folder to the host and:  bash proxmox/ct/rackwright.sh
#
# Re-run this same file inside the LXC to update (git pull, rebuild, restart).

set -euo pipefail

APP="Rackwright"
# shellcheck disable=SC2034
NSAPP="rackwright"
var_tags="${var_tags:-rackwright;network}"
var_cpu="${var_cpu:-2}"
var_ram="${var_ram:-2048}"
var_disk="${var_disk:-8}"
# shellcheck disable=SC2034
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
var_unprivileged="${var_unprivileged:-1}"
var_port="${var_port:-8080}"
export var_port

# Where this script installs from. Change these two lines only; everything else derives from them.
# Inside an existing LXC, `update` follows the repo and branch the container was installed from
# (git origin and current branch). Set var_repo / var_branch to override that.
RW_DEFAULT_REPO="https://github.com/hast3/Rackwright.git"
RW_DEFAULT_BRANCH="master"

YW=$'\033[33m'
GN=$'\033[1;92m'
RD=$'\033[01;31m'
CL=$'\033[m'
BL=$'\033[36m'
BGN=$'\033[4;92m'
CM="${GN}✓${CL}"
CROSS="${RD}✗${CL}"

header_info() {
  clear
  cat <<"EOF"
    ____                      __                      _              __     __
   / __ \  ____ _   _____    / /__ _      __  _____   (_)  ____ _    / /_   / /_
  / /_/ / / __ `/  / ___/   / //_/| | /| / / / ___/  / /  / __ `/   / __ \ / __/
 / _, _/ / /_/ /  / /__    / ,<   | |/ |/ / / /     / /  / /_/ /   / / / // /_
/_/ |_|  \__,_/   \___/   /_/|_|  |__/|__/  /_/    /_/   \__, /   /_/ /_/ \__/
                                                        /____/
EOF
  echo -e "\n${BL}${APP}${CL}  LXC installer  ${YW}(community-scripts style)${CL}\n"
}

msg_info() { echo -e "${YW}→${CL} $1"; }
msg_ok() { echo -e "${CM} $1"; }
msg_error() { echo -e "${CROSS} ${RD}$1${CL}"; }

# Version from web/server/Cargo.toml in the given app dir (empty if unknown).
rw_version() {
  sed -n 's/^version *= *"\(.*\)"/\1/p' "$1/web/server/Cargo.toml" 2>/dev/null | head -n 1
}

is_pve_host() { [[ -d /etc/pve ]] && command -v pct >/dev/null 2>&1; }

next_ctid() {
  if command -v pvesh >/dev/null 2>&1; then
    pvesh get /cluster/nextid
  else
    local id=100
    while pct status "$id" >/dev/null 2>&1; do id=$((id + 1)); done
    echo "$id"
  fi
}

host_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    *) echo amd64 ;;
  esac
}

pick_template() {
  local version="$1" arch="$2"
  pveam available -section system | awk -v version="$version" -v arch="$arch" '
    $2 ~ ("debian-" version "-standard") && $2 ~ ("_" arch "\\.tar") { print $2 }
  ' | tail -1
}

# Update path: running inside an existing Rackwright LXC
update_script() {
  header_info
  if [[ ! -d /opt/rackwright/.git ]]; then
    msg_error "No ${APP} installation found in this container."
    exit 1
  fi
  msg_info "Stopping ${APP}"
  systemctl stop rackwright || true
  msg_ok "Stopped"

  cd /opt/rackwright
  # Follow what this container was installed from. var_repo / var_branch override when set.
  local repo branch
  repo="${var_repo:-}"
  if [[ -z "$repo" ]]; then
    repo="$(git remote get-url origin 2>/dev/null || true)"
  fi
  repo="${repo:-$RW_DEFAULT_REPO}"
  branch="${var_branch:-}"
  if [[ -z "$branch" ]]; then
    branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    if [[ -z "$branch" || "$branch" == "HEAD" ]]; then
      branch="$RW_DEFAULT_BRANCH"
    fi
  fi
  if [[ "$(git remote get-url origin 2>/dev/null || true)" != "$repo" ]]; then
    git remote set-url origin "$repo" 2>/dev/null || git remote add origin "$repo"
  fi

  msg_info "Pulling latest from ${branch} (${repo})"
  # Explicit refspec: a shallow --branch clone is single-branch, so be explicit about the ref.
  git fetch --depth 1 origin "+refs/heads/${branch}:refs/remotes/origin/${branch}"
  git checkout -f -B "$branch" "origin/${branch}"
  git reset --hard "origin/${branch}"
  msg_ok "Updated source"

  msg_info "Updating Rust"
  export PATH="/root/.cargo/bin:${PATH}"
  rustup update stable >/dev/null 2>&1 || true
  msg_ok "Rust is current"

  # Same build step as the installer, taken from the freshly pulled tree.
  echo -e "${YW}Rebuilding ${APP}. This takes several minutes.${CL}"
  # shellcheck source=/dev/null
  source /opt/rackwright/proxmox/install/rackwright-install.sh --functions-only
  build_app

  msg_info "Starting ${APP}"
  systemctl daemon-reload
  systemctl start rackwright
  local ver
  ver="$(rw_version /opt/rackwright)"
  msg_ok "Updated successfully${ver:+ (version ${ver})}"
  if [[ ! -x /usr/bin/update ]]; then
    cat <<'EOF' >/usr/bin/update
#!/usr/bin/env bash
set -euo pipefail
exec bash /opt/rackwright/proxmox/ct/rackwright.sh "$@"
EOF
    chmod 0755 /usr/bin/update
  fi
  if [[ ! -f /etc/systemd/system/container-getty@1.service.d/override.conf ]]; then
    mkdir -p /etc/systemd/system/container-getty@1.service.d
    cat >/etc/systemd/system/container-getty@1.service.d/override.conf <<'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin root --noclear --keep-baud tty%I 115200,38400,9600 $TERM
EOF
    passwd -d root >/dev/null 2>&1 || true
    systemctl daemon-reload
    systemctl restart container-getty@1.service >/dev/null 2>&1 || true
  fi
  echo -e "\n${GN}${APP}${CL}  http://$(hostname -I | awk '{print $1}'):${var_port}\n"
  echo -e "Next time: ${BL}update${CL}\n"
  exit 0
}

if ! is_pve_host; then
  update_script
fi

# Host path: apply the defaults (update_script above must not see them)
export var_repo="${var_repo:-$RW_DEFAULT_REPO}"
export var_branch="${var_branch:-$RW_DEFAULT_BRANCH}"

# Host path: create the LXC
header_info
if ! command -v whiptail >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq whiptail >/dev/null
fi

find_rw_ct() {
  local id hn
  while read -r id _; do
    [[ "$id" =~ ^[0-9]+$ ]] || continue
    hn="$(pct config "$id" 2>/dev/null | awk '/^hostname:/{print $2; exit}')"
    if [[ "$hn" == "rackwright" ]]; then
      echo "$id"
      return 0
    fi
  done < <(pct list 2>/dev/null)
  return 1
}

run_guest_install() {
  msg_info "Installing ${APP} inside CT ${CTID}"
  pct start "$CTID" >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    pct exec "$CTID" -- true >/dev/null 2>&1 && break
    sleep 1
  done

  local install_src=""
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-}")" >/dev/null 2>&1 && pwd || true)"
  if [[ -n "$script_dir" && -f "$script_dir/../install/rackwright-install.sh" ]]; then
    install_src="$script_dir/../install/rackwright-install.sh"
  else
    install_src="$(mktemp)"
    local slug="${var_repo#https://github.com/}"
    slug="${slug%.git}"
    curl -fsSL \
      "https://raw.githubusercontent.com/${slug}/${var_branch}/proxmox/install/rackwright-install.sh" \
      >"$install_src"
  fi
  pct push "$CTID" "$install_src" /root/rackwright-install.sh
  pct exec "$CTID" -- chmod 0755 /root/rackwright-install.sh
  echo -e "${YW}The first build compiles the web front end and the Rust server. It takes several minutes.${CL}"
  pct exec "$CTID" -- env \
    var_repo="$var_repo" \
    var_branch="$var_branch" \
    var_port="$var_port" \
    bash /root/rackwright-install.sh
  msg_ok "Installed ${APP}"
}

finish() {
  local ip ver
  ip="$(pct exec "$CTID" -- hostname -I | awk '{print $1}')"
  ver="$(pct exec "$CTID" -- sed -n 's/^version *= *"\(.*\)"/\1/p' /opt/rackwright/web/server/Cargo.toml 2>/dev/null | head -n 1 || true)"
  echo
  echo -e "${GN}${APP}${ver:+ ${ver}} setup has been successfully initialized!${CL}"
  echo -e "${YW}Access it using the following URL:${CL}"
  echo -e "  ${BGN}http://${ip}:${var_port}${CL}"
  echo
  echo -e "The first person to open that address creates the admin account."
  echo
  echo -e "Update later (from inside the LXC):"
  echo -e "  ${BL}update${CL}"
  echo
}

EXISTING="$(find_rw_ct || true)"
if [[ -n "$EXISTING" ]]; then
  CTID="$EXISTING"
  if ! whiptail --backtitle "Proxmox VE Helper Scripts" --title "$APP" \
    --yesno "LXC ${CTID} already has hostname rackwright.\n\nYES = resume install into ${CTID} (do not create another CT)\nNO  = abort" 12 70; then
    msg_error "Aborted. Destroy extras with:  pct stop <id>; pct destroy <id>"
    exit 1
  fi
  run_guest_install
  finish
  exit 0
fi

if ! whiptail --backtitle "Proxmox VE Helper Scripts" --title "$APP" \
  --yesno "Create an unprivileged Debian ${var_version} LXC and install ${APP}?\n\nDefault: ${var_cpu} CPU · ${var_ram} MB RAM · ${var_disk} GB disk · port ${var_port}\n\nYes = Default settings\nNo  = Advanced" 16 72; then
  ADVANCED=1
else
  ADVANCED=0
fi

CTID="${var_ctid:-$(next_ctid)}"
HN="${var_hostname:-rackwright}"
BRIDGE="${var_bridge:-vmbr0}"
VLAN="${var_vlan:-}"
STORAGE=""
if command -v pvesm >/dev/null 2>&1; then
  STORAGE="$(pvesm status -content rootdir | awk 'NR==2 {print $1}')"
fi
STORAGE="${var_storage:-${STORAGE:-local-lvm}}"

if [[ "$ADVANCED" == "1" ]]; then
  CTID=$(whiptail --inputbox "Container ID" 10 60 "$CTID" 3>&1 1>&2 2>&3)
  HN=$(whiptail --inputbox "Hostname" 10 60 "$HN" 3>&1 1>&2 2>&3)
  var_cpu=$(whiptail --inputbox "CPU cores" 10 60 "$var_cpu" 3>&1 1>&2 2>&3)
  var_ram=$(whiptail --inputbox "RAM (MB)" 10 60 "$var_ram" 3>&1 1>&2 2>&3)
  var_disk=$(whiptail --inputbox "Disk (GB)" 10 60 "$var_disk" 3>&1 1>&2 2>&3)
  STORAGE=$(whiptail --inputbox "Storage" 10 60 "$STORAGE" 3>&1 1>&2 2>&3)
  BRIDGE=$(whiptail --inputbox "Bridge" 10 60 "$BRIDGE" 3>&1 1>&2 2>&3)
  VLAN=$(whiptail --inputbox "VLAN tag (blank = none)" 10 60 "$VLAN" 3>&1 1>&2 2>&3)
fi

msg_info "Refreshing template list"
pveam update >/dev/null
TMPL_STORE="$(pvesm status -content vztmpl | awk 'NR==2 {print $1}')"
TMPL_STORE="${TMPL_STORE:-local}"
ARCH="$(host_arch)"
TEMPLATE_NAME="$(pick_template 13 "$ARCH")"
if [[ -z "$TEMPLATE_NAME" ]]; then
  TEMPLATE_NAME="$(pick_template 12 "$ARCH")"
fi
[[ -n "$TEMPLATE_NAME" ]] || { msg_error "No Debian 13/12 ${ARCH} template found in pveam"; exit 1; }
if ! pveam list "$TMPL_STORE" | grep -q "$TEMPLATE_NAME"; then
  msg_info "Downloading $TEMPLATE_NAME"
  pveam download "$TMPL_STORE" "$TEMPLATE_NAME"
fi
TEMPLATE="${TMPL_STORE}:vztmpl/${TEMPLATE_NAME}"
msg_ok "Template ${TEMPLATE_NAME}"

NET="name=eth0,bridge=${BRIDGE},ip=dhcp"
[[ -n "$VLAN" ]] && NET="${NET},tag=${VLAN}"

if pct status "$CTID" >/dev/null 2>&1; then
  msg_error "CT ${CTID} already exists. Aborting create."
  echo "To resume: the installer detects hostname rackwright first."
  exit 1
fi

msg_info "Creating LXC ${CTID} (${HN})"
pct create "$CTID" "$TEMPLATE" \
  --hostname "$HN" \
  --memory "$var_ram" \
  --cores "$var_cpu" \
  --rootfs "${STORAGE}:${var_disk}" \
  --net0 "$NET" \
  --unprivileged "$var_unprivileged" \
  --features nesting=1,keyctl=1 \
  --onboot 1 \
  --timezone host \
  --tags "${var_tags//;/,}" \
  --description "<div align='center'><h2>${APP}</h2><p>Network rack designer</p></div>"
pct start "$CTID"
for _ in $(seq 1 30); do
  pct exec "$CTID" -- true >/dev/null 2>&1 && break
  sleep 1
done
msg_ok "LXC ${CTID} started"

run_guest_install
finish
echo
