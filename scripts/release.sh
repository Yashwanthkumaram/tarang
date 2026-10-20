#!/usr/bin/env bash
# Cuts a release: bumps the version everywhere, commits, tags vX.Y.Z and pushes.
# GitHub Actions (.github/workflows/release.yml) then builds and publishes every platform.
#   scripts/release.sh 0.2.0
set -euo pipefail
cd "$(dirname "$0")/.."

v="${1:?usage: scripts/release.sh X.Y.Z}"
[[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must look like 1.2.3"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "commit or stash your changes first"; exit 1; }

python3 - "$v" <<'EOF'
import json, re, sys
v = sys.argv[1]
p = 'src-tauri/tauri.conf.json'; c = json.load(open(p)); c['version'] = v
open(p, 'w').write(json.dumps(c, indent=2) + '\n')
p = 'package.json'; c = json.load(open(p)); c['version'] = v
open(p, 'w').write(json.dumps(c, indent=2) + '\n')
p = 'Cargo.toml'; s = open(p).read()
s = re.sub(r'(\[workspace\.package\][^\[]*?\nversion = )"[^"]*"', rf'\1"{v}"', s, count=1, flags=re.S)
open(p, 'w').write(s)
EOF
cargo update --workspace --offline >/dev/null 2>&1 || cargo update --workspace >/dev/null

git add src-tauri/tauri.conf.json package.json Cargo.toml Cargo.lock
git commit -m "Release v$v"
git tag "v$v"
git push origin HEAD "v$v"
echo "Pushed v$v — follow the build at: $(gh repo view --json url -q .url)/actions"
