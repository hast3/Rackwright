#!/usr/bin/env bash
# Copyright (c) 2026 Hrubak
# Author: Hrubak
# License: MIT
# Source: https://github.com/hast3/Rackwright
#
# Runs INSIDE the LXC. Debian templates have no curl or git — install packages first.
# The `update` command sources this file with --functions-only to reuse build_app.

set -euo pipefail

YW=$'\033[33m'
GN=$'\033[1;92m'
RD=$'\033[01;31m'
CL=$'\033[m'
msg_info() { echo -e "${YW}→${CL} $1"; }
msg_ok() { echo -e "${GN}✓${CL} $1"; }
msg_error() { echo -e "${RD}✗${CL} $1"; }

APP_DIR="/opt/rackwright"
DATA_DIR="/var/lib/rackwright"

# Build the web front end, then the Rust server. Used by install and by `update`.
build_app() {
  export PATH="/root/.cargo/bin:${PATH}"

  msg_info "Building the web front end"
  (
    cd "${APP_DIR}/rackwright-tauri"
    npm ci --no-audit --no-fund
    npm run build:web
  )
  msg_ok "Built the web front end"

  msg_info "Building the server (Rust, release)"
  (
    cd "${APP_DIR}/web/server"
    # --locked only for a Cargo.lock that comes from the repository. A lock file that an
    # earlier build wrote here is not tracked and may be out of date, so cargo may refresh it.
    if git -C "${APP_DIR}" ls-files --error-unmatch web/server/Cargo.lock >/dev/null 2>&1; then
      cargo build --release --locked
    else
      cargo build --release
    fi
  )
  msg_ok "Built the server"
}

if [[ "${1:-}" == "--functions-only" ]]; then
  return 0 2>/dev/null || exit 0
fi

export DEBIAN_FRONTEND=noninteractive
export LANG=C.UTF-8
export LC_ALL=C.UTF-8

# Prefer IPv4. A container with a broken IPv6 route retries deb.debian.org until apt prints
# "Tried to start delayed item ... InRelease, but failed" for a long time.
if ! grep -q '^precedence ::ffff:0:0/96' /etc/gai.conf 2>/dev/null; then
  printf '\nprecedence ::ffff:0:0/96  100\n' >> /etc/gai.conf
fi
cat >/etc/apt/apt.conf.d/99rackwright <<'EOF'
Acquire::ForceIPv4 "true";
Acquire::Retries "3";
Acquire::http::Timeout "20";
Acquire::https::Timeout "20";
EOF

wait_for_dns() {
  local try
  for try in $(seq 1 30); do
    if getent hosts deb.debian.org >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  msg_error "This container cannot resolve deb.debian.org. Check DHCP and DNS, then run the installer again."
  exit 1
}

apt_update() {
  local try
  for try in 1 2 3; do
    if apt-get update -o Acquire::ForceIPv4=true; then
      return 0
    fi
    msg_info "Package list update failed, retrying (${try}/3)"
    sleep 5
  done
  msg_error "Could not download the Debian package lists from deb.debian.org."
  exit 1
}

msg_info "Waiting for DNS"
wait_for_dns
msg_ok "DNS is working"

msg_info "Installing base packages"
apt_update
apt-get install -y -qq curl ca-certificates git build-essential pkg-config locales >/dev/null
sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen 2>/dev/null || true
locale-gen en_US.UTF-8 >/dev/null 2>&1 || true
msg_ok "Installed base packages"

# The host script (proxmox/ct/rackwright.sh) passes var_repo / var_branch. These fallbacks only
# apply when this file is run by hand; keep them equal to RW_DEFAULT_REPO / RW_DEFAULT_BRANCH there.
REPO="${var_repo:-https://github.com/hast3/Rackwright.git}"
BRANCH="${var_branch:-master}"
PORT="${var_port:-8080}"

msg_info "Installing Node.js 22"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
apt-get install -y -qq nodejs >/dev/null
msg_ok "Installed Node.js $(node --version)"

msg_info "Installing Rust (stable)"
if [[ ! -x /root/.cargo/bin/rustup ]]; then
  curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal >/dev/null 2>&1
fi
export PATH="/root/.cargo/bin:${PATH}"
msg_ok "Installed $(rustc --version)"

msg_info "Cloning Rackwright"
rm -rf "$APP_DIR"
git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
msg_ok "Cloned Rackwright"

install -d -m 700 "$DATA_DIR"

echo -e "${YW}The first build takes several minutes. Please wait.${CL}"
build_app

msg_info "Creating Service"
cat <<EOF >/etc/systemd/system/rackwright.service
[Unit]
Description=Rackwright
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
Restart=always
RestartSec=3
User=root
WorkingDirectory=${APP_DIR}
Environment=RW_DATA=${DATA_DIR}
Environment=RW_HOST=0.0.0.0
Environment=RW_PORT=${PORT}
Environment=RW_STATIC=${APP_DIR}/web/dist
ExecStart=${APP_DIR}/web/server/target/release/rackwright-server

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q --now rackwright
msg_ok "Created Service"

install_update_cmd() {
  cat <<'EOF' >/usr/bin/update
#!/usr/bin/env bash
# Rackwright — same as community-scripts: type `update` inside the LXC.
set -euo pipefail
exec bash /opt/rackwright/proxmox/ct/rackwright.sh "$@"
EOF
  chmod 0755 /usr/bin/update

  cat <<EOF >/etc/profile.d/00_rackwright.sh
echo
echo -e "  Rackwright LXC"
echo -e "  URL:    http://\$(hostname -I | awk '{print \$1}'):${PORT}"
echo -e "  Update: type \\033[1;92mupdate\\033[m"
echo
EOF
  chmod 0644 /etc/profile.d/00_rackwright.sh
}

enable_console_autologin() {
  local dir=/etc/systemd/system/container-getty@1.service.d
  mkdir -p "$dir"
  cat >"$dir/override.conf" <<'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin root --noclear --keep-baud tty%I 115200,38400,9600 $TERM
EOF
  passwd -d root >/dev/null 2>&1 || true
  systemctl daemon-reload
  systemctl restart container-getty@1.service >/dev/null 2>&1 || true
}

install_update_cmd
enable_console_autologin
msg_ok "Installed 'update' command + console autologin"

echo
echo -e "${GN}Rackwright is running.${CL}  http://$(hostname -I | awk '{print $1}'):${PORT}"
echo "The first person to open that address creates the admin account."
