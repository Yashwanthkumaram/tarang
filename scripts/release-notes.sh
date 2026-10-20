#!/usr/bin/env bash
# Writes friendly, non-technical release notes for a published release and puts them on
# GitHub. Called by the release workflow once every file is uploaded; also safe to run by
# hand:  scripts/release-notes.sh v0.2.0
# Links point at the files actually attached to the release, so a platform whose build
# failed is simply left out.
set -euo pipefail
tag="${1:?usage: scripts/release-notes.sh vX.Y.Z}"
repo="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
v="${tag#v}"

assets=$(gh release view "$tag" --repo "$repo" --json assets -q '.assets[].name')
find_asset() { grep -E "$1" <<<"$assets" | grep -vE '\.sig$' | head -1 || true; }
link() { echo "https://github.com/$repo/releases/download/$tag/$1"; }

win=$(find_asset '_x64-setup\.exe$')
apk=$(find_asset '\.apk$')
mac=$(find_asset '\.dmg$')
appimage=$(find_asset '\.AppImage$')
deb=$(find_asset '\.deb$')

# The previous notes may hold GitHub's generated changelog; keep it, folded away.
old_body=$(gh release view "$tag" --repo "$repo" --json body -q .body)
changes=$(sed -n '/## What.s Changed/,$p; /Full Changelog/p' <<<"$old_body" | awk '!seen[$0]++')
[ -n "$changes" ] || changes="**Full Changelog**: https://github.com/$repo/commits/$tag"

notes=$(mktemp)
{
  echo "## 🎵 Tarang $v"
  echo
  echo "Your music, online or off. Search and stream YouTube Music, download songs to play"
  echo "without internet, make playlists, and bring your playlists over from Spotify."
  echo
  echo "### ⬇️ Which file do I download?"
  echo
  echo "| Your device | Download this |"
  echo "|---|---|"
  [ -n "$win" ] && echo "| 🪟 **Windows** PC or laptop | [**Tarang for Windows**]($(link "$win")) |"
  [ -n "$apk" ] && echo "| 🤖 **Android** phone | [**Tarang for Android**]($(link "$apk")) |"
  [ -n "$mac" ] && echo "| 🍎 **Mac** | [**Tarang for Mac**]($(link "$mac")) |"
  [ -n "$appimage" ] && echo "| 🐧 **Linux** | [**Tarang for Linux**]($(link "$appimage")) (works on any Linux)$([ -n "$deb" ] && echo " · [.deb for Ubuntu/Debian]($(link "$deb"))") |"
  echo
  echo "Already have Tarang? You don't need to download anything. It updates itself and"
  echo "tells you when a new version is ready (or open **Settings → About → Check for updates**)."
  echo
  echo "### 📲 How to install"
  echo
  if [ -n "$win" ]; then
    echo "<details open><summary><b>🪟 Windows</b></summary>"
    echo
    echo "1. Click **Tarang for Windows** above and open the file once it has downloaded."
    echo "2. If a blue box says **\"Windows protected your PC\"**, click **More info**, then **Run anyway**."
    echo "   (This shows for apps from small developers. Tarang is safe, and its code is public here.)"
    echo "3. Tarang installs by itself in a few seconds and opens. Find it later in the **Start menu**."
    echo
    echo "</details>"
    echo
  fi
  if [ -n "$apk" ]; then
    echo "<details open><summary><b>🤖 Android</b></summary>"
    echo
    echo "1. On your phone, tap **Tarang for Android** above. It downloads like any file."
    echo "2. Tap the download when it finishes (or find it in your **Files → Downloads**)."
    echo "3. If your phone says installing from this source isn't allowed, tap **Settings**,"
    echo "   turn on **Allow from this source**, then go back and tap **Install**."
    echo "4. If Play Protect warns about an unknown app, tap **More details → Install anyway**."
    echo "5. Open **Tarang** from your home screen and allow the permissions it asks for."
    echo
    echo "</details>"
    echo
  fi
  if [ -n "$mac" ]; then
    echo "<details><summary><b>🍎 Mac</b></summary>"
    echo
    echo "1. Click **Tarang for Mac** above and open the downloaded file."
    echo "2. Drag **Tarang** into the **Applications** folder."
    echo "3. The first time, **right-click** Tarang in Applications and choose **Open**, then **Open** again."
    echo "   If macOS still refuses, go to **System Settings → Privacy & Security** and click **Open Anyway**."
    echo
    echo "</details>"
    echo
  fi
  if [ -n "$appimage" ]; then
    echo "<details><summary><b>🐧 Linux</b></summary>"
    echo
    echo "1. Download **Tarang for Linux** (the .AppImage)."
    echo "2. Right-click it → **Properties → Permissions** → tick **Allow executing as a program**"
    echo "   (or run \`chmod +x Tarang_*.AppImage\`), then double-click it."
    echo "3. On Ubuntu or Debian you can instead double-click the **.deb** to install it with your app store."
    echo
    echo "The AppImage updates itself; the .deb is updated by downloading the new .deb."
    echo
    echo "</details>"
    echo
  fi
  echo "### ❓ Something not working?"
  echo
  echo "[Tell us here](https://github.com/$repo/issues/new) and describe what happened. A screenshot helps."
  echo
  echo "<details><summary>Technical changes in this version</summary>"
  echo
  echo "$changes"
  echo
  echo "</details>"
} > "$notes"

gh release edit "$tag" --repo "$repo" --title "Tarang $v" --notes-file "$notes"
rm -f "$notes"
echo "Release notes for $tag updated."
