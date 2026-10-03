#!/usr/bin/env bash
# Installs or updates "T3 Code (Fork)" on an Apple Silicon Mac from the
# rolling fork-desktop-latest prerelease. The fork runs side by side with the
# official app. A fork that runs from the install dir is asked to quit before
# the swap and is reopened afterwards.
# Usage: curl -fsSL https://raw.githubusercontent.com/Silthus/t3code/main/scripts/fork/install-mac.sh | bash
# Env: T3CODE_FORK_DOWNLOAD_URL (a file:// URL installs a local build),
#      T3CODE_FORK_INSTALL_DIR (default /Applications)
set -euo pipefail

app_name="T3 Code (Fork).app"
bundle_id="com.silthus.t3code.fork"
download_url="${T3CODE_FORK_DOWNLOAD_URL:-https://github.com/Silthus/t3code/releases/download/fork-desktop-latest/T3-Code-Fork-arm64.zip}"
install_dir="${T3CODE_FORK_INSTALL_DIR:-/Applications}"
target="$install_dir/$app_name"

fail() {
  echo "install-mac: $1" >&2
  exit 1
}

bundle_id_of() {
  plutil -extract CFBundleIdentifier raw -o - "$1/Contents/Info.plist" 2>/dev/null || true
}

# Asks the fork running from $target to quit, the same way Cmd-Q does, and
# prints "quit" once it has exited. Prints nothing when it is not running.
quit_running_fork() {
  osascript -l JavaScript - "$bundle_id" "$target" <<'JXA'
ObjC.import("AppKit");
function run([bundleId, target]) {
  const running = ObjC.unwrap(
    $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId),
  ).filter((app) => ObjC.unwrap(app.bundleURL.path) === target);
  running.forEach((app) => app.terminate);
  for (let waited = 0; waited < 60 && running.some((app) => !app.terminated); waited++) {
    delay(0.5);
  }
  if (running.some((app) => !app.terminated)) {
    throw new Error(`${target} did not quit within 30 seconds`);
  }
  return running.length > 0 ? "quit" : "";
}
JXA
}

[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] ||
  fail "the fork app is built for Apple Silicon Macs only"

download="$(mktemp -d)"
staging="$(mktemp -d "$install_dir/.t3code-fork-install.XXXXXX")"
trap 'rm -rf "$download" "$staging"' EXIT

echo "Downloading $download_url"
curl -fL --progress-bar -o "$download/fork.zip" "$download_url" || fail "download failed"
ditto -x -k "$download/fork.zip" "$staging" || fail "could not unpack the download"
[[ -d "$staging/$app_name" ]] || fail "the download does not contain $app_name"
[[ "$(bundle_id_of "$staging/$app_name")" == "$bundle_id" ]] ||
  fail "the downloaded app is not $bundle_id"
xattr -dr com.apple.quarantine "$staging/$app_name"

was_running="$(quit_running_fork)" || fail "close $app_name and run the installer again"
rm -rf "$target"
mv "$staging/$app_name" "$target"
echo "Installed $target"

# A shell inside an Electron app, such as an agent in T3 Code, can carry
# ELECTRON_RUN_AS_NODE, which open passes on and which starts the fork as Node.
if [[ "$was_running" == "quit" ]]; then
  env -u ELECTRON_RUN_AS_NODE open "$target"
fi
