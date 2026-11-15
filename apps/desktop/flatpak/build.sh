#!/usr/bin/env bash
# Optional local build of the Flatpak (CI does this in the "flatpak" job of .github/workflows/release.yml).
# Needs: flatpak-builder (or `flatpak install flathub org.flatpak.Builder`), runtime/SDK/BaseApp 25.08 from flathub.
set -euo pipefail
cd "$(dirname "$0")"
pnpm --filter @unimsg/ui build
pnpm --filter @unimsg/desktop package:dir
FB=flatpak-builder; command -v flatpak-builder >/dev/null || FB="flatpak run org.flatpak.Builder"
$FB --user --force-clean --install-deps-from=flathub --repo=build-repo --install build-dir org.unichat.desktop.yml
flatpak build-bundle build-repo "unichat-desktop-${UNICHAT_VERSION:-dev}.flatpak" org.unichat.desktop
echo "run: flatpak run org.unichat.desktop"
