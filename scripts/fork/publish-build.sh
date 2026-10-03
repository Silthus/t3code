#!/usr/bin/env bash
# Publishes a fork Mac build to the rolling fork-desktop-latest prerelease,
# which scripts/fork/install-mac.sh downloads by its stable asset name.
# The zip uploads under a commit-named asset first. The stable name then moves
# from the previous build to the new one, and moves back if that fails, so the
# download never disappears and a failed publish keeps the last good build.
# Called by .github/workflows/fork-desktop-mac.yml.
# Usage: scripts/fork/publish-build.sh <zip> <upstream-version>
# Env: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA
set -euo pipefail

zip="$1"
version="$2"
tag="fork-desktop-latest"
stable="T3-Code-Fork-arm64.zip"
staged="T3-Code-Fork-arm64-${GITHUB_SHA:0:7}.zip"
previous="T3-Code-Fork-arm64-previous.zip"
release_api="repos/$GITHUB_REPOSITORY/releases"

asset_id() {
  gh api "$release_api/tags/$tag" --jq ".assets[] | select(.name == \"$1\") | .id"
}

rename_asset() {
  gh api --silent -X PATCH "$release_api/assets/$1" -f name="$2"
}

remove_other_assets() {
  gh release view "$tag" -R "$GITHUB_REPOSITORY" --json assets --jq '.assets[].name' |
    while read -r name; do
      if [[ "$name" != "$stable" ]]; then
        gh release delete-asset "$tag" "$name" -R "$GITHUB_REPOSITORY" --yes || return 1
      fi
    done
}

release_notes() {
  cat <<EOF
Unsigned Apple Silicon build of fork \`main\` at $GITHUB_SHA (upstream version $version).

Install or update:

\`\`\`sh
curl -fsSL https://raw.githubusercontent.com/$GITHUB_REPOSITORY/main/scripts/fork/install-mac.sh | bash
\`\`\`
EOF
}

if ! gh release view "$tag" -R "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
  gh release create "$tag" -R "$GITHUB_REPOSITORY" --prerelease --target "$GITHUB_SHA" \
    --title "T3 Code (Fork) latest" --notes "Publishing the first build."
fi

staged_zip="$(dirname "$zip")/$staged"
cp "$zip" "$staged_zip"
gh release upload "$tag" -R "$GITHUB_REPOSITORY" --clobber "$staged_zip"

old_id="$(asset_id "$stable")"
new_id="$(asset_id "$staged")"
previous_id="$(asset_id "$previous")"
[[ -z "$previous_id" ]] || gh api --silent -X DELETE "$release_api/assets/$previous_id"
[[ -z "$old_id" ]] || rename_asset "$old_id" "$previous"
if ! rename_asset "$new_id" "$stable"; then
  [[ -z "$old_id" ]] || rename_asset "$old_id" "$stable"
  echo "publish-build: could not promote $staged; the previous build stays published" >&2
  exit 1
fi

gh release edit "$tag" -R "$GITHUB_REPOSITORY" --notes "$(release_notes)" ||
  echo "publish-build: published, but could not update the release notes" >&2
remove_other_assets ||
  echo "publish-build: published, but could not remove older assets" >&2
