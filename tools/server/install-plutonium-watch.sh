#!/bin/bash
# Install a watch that keeps "a5e" in Plutonium's manifest on a Docker host.
#
#   curl -sL https://raw.githubusercontent.com/WesleySniperss/plutonium-a5e-bridge/main/tools/server/install-plutonium-watch.sh | bash
#
# Foundry hides a module whose manifest does not name the active system, and it
# decides that before any module code runs, so no module can fix it from inside
# Foundry. Every Plutonium update rewrites the manifest without "a5e".
#
# This puts a systemd path unit on each Plutonium manifest found in a Foundry
# container's mounted data. When one changes, a worker waits for the update to
# finish writing, adds "a5e" back if it is missing, and restarts that container
# so Foundry reads the manifest again — Plutonium is updated from the Setup
# screen, where no world is running, so the restart interrupts nobody.
#
# Safe to run again: it replaces its own units, and the worker writes nothing
# when "a5e" is already listed. It runs once at the end, which fixes the current
# state too — so run it when nobody is playing.

# Everything is inside a function so bash reads the whole script before running
# any of it: piped in through curl, a command reading stdin would otherwise eat
# the rest of the script. Heredoc bodies are deliberately not indented — their
# terminators must start the line, and the Python inside must not be shifted.
main() {
set -u

sudo tee /usr/local/bin/plutonium-a5e-keep.sh >/dev/null <<'SH'
#!/bin/sh
# Keep "a5e" in Plutonium's manifest for every Foundry container on this host,
# and restart a container whose manifest had to be fixed so Foundry reads it.
#
# Foundry hides a module whose manifest does not name the active system, and it
# reads manifests into memory once — so after a Plutonium update the fixed file
# only takes effect on a restart. Plutonium is updated from the Setup screen,
# where no world is running, so restarting then interrupts nobody.
set -u

# Adds "a5e" if it is missing. Exits 0 only when it changed the file, so the
# watch that runs this is not set off again by its own write.
PATCH='import json,shutil,sys
f=sys.argv[1]
m=json.load(open(f,encoding="utf-8"))
s=m.setdefault("relationships",{}).setdefault("systems",[])
if any(isinstance(x,dict) and x.get("id")=="a5e" for x in s): sys.exit(3)
shutil.copy(f,f+".bak")
s.append({"id":"a5e","type":"system"})
json.dump(m,open(f,"w",encoding="utf-8"),indent="\t")
print("systems now:",", ".join(x.get("id","") for x in s if isinstance(x,dict)))'

# An update writes many files. Wait until nothing under the module has changed
# for 15 s, so a restart never lands in the middle of one (5 minutes at most).
settle() {
  n=0
  while [ "$n" -lt 30 ]; do
    [ -z "$(find "$1" -newermt '15 seconds ago' -print -quit 2>/dev/null)" ] && return 0
    sleep 10
    n=$((n + 1))
  done
}

docker ps -a --format '{{.Names}} {{.Image}}' | grep -i foundry | while read -r name _image; do
  changed=0
  for src in $(docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$name"); do
    for f in $(find "$src" -maxdepth 5 -path '*/modules/plutonium/module.json' 2>/dev/null); do
      settle "$(dirname "$f")"
      if python3 -c "$PATCH" "$f" </dev/null; then
        echo "$name: patched $f"
        changed=1
      fi
    done
  done

  # Never start a container that was stopped — only restart a running one.
  if [ "$changed" = 1 ] && [ "$(docker inspect -f '{{.State.Running}}' "$name")" = true ]; then
    echo "$name: restarting so Foundry reads the manifest again"
    docker restart "$name" >/dev/null </dev/null
  fi
done
SH
sudo chmod +x /usr/local/bin/plutonium-a5e-keep.sh

sudo tee /etc/systemd/system/plutonium-a5e.service >/dev/null <<'SVC'
[Unit]
Description=Keep a5e in Plutonium's manifest
[Service]
Type=oneshot
TimeoutStartSec=10min
ExecStart=/usr/local/bin/plutonium-a5e-keep.sh
SVC

# Every Plutonium manifest in the data mounted into a Foundry container.
P=$(for c in $(docker ps -a --format '{{.Names}} {{.Image}}' | grep -i foundry | cut -d' ' -f1); do
  for s in $(docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' "$c"); do
    sudo -n find "$s" -maxdepth 5 -path '*/modules/plutonium/module.json' 2>/dev/null
  done
done | sort -u)

if [ -n "$P" ]; then
  printf '[Unit]\nDescription=Watch Plutonium manifests\n[Path]\n%s\n[Install]\nWantedBy=multi-user.target\n' \
    "$(echo "$P" | sed 's/^/PathChanged=/')" | sudo tee /etc/systemd/system/plutonium-a5e.path
  sudo systemctl daemon-reload
  sudo systemctl enable --now plutonium-a5e.path
  echo "--- running once now (waits for the files to settle, may restart Foundry) ---"
  sudo systemctl start plutonium-a5e.service
  journalctl -u plutonium-a5e.service -n 10 --no-pager
else
  echo "!!! Plutonium's manifest was not found in any Foundry container."
fi
}

main "$@"
