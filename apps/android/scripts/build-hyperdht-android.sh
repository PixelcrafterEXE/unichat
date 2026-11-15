#!/usr/bin/env bash
# Stages the two native add-ons HyperDHT needs on Android ("Reach my devices from anywhere", packages/sync/src/dht.ts):
#   apps/android/android/app/hyperdht/bin/<abi>/libudx_native.so  and  libsodium_native.so      (jniLibs; NodeRuntime.java System.loadLibrary()s them,
#   src/dht-native-loader.cjs then process.dlopen()s them by soname inside the bundle)
#
#   scripts/build-hyperdht-android.sh [--abis "arm64-v8a x86_64"] [--from-source --ndk DIR]
#
# STATUS: UNVERIFIED ON A DEVICE. Statically checked only (ELF class/arch, 16 KB page alignment, every undefined napi_* symbol is exported by the pinned libnode.so).
#
# 1. DEFAULT (no compiler needed): the npm packages udx-native 1.22.1 and sodium-native 5.2.1 ship Android prebuilds for android-arm64 / android-x64 / (arm, ia32) as N-API
#    `.node` files (NDK r30, API 29, 16 KB aligned, libc++_shared.so for udx). They were built for Termux-style hosts where the `node` EXECUTABLE exports napi_*; they list only
#    libm/libc++_shared/libdl/libc in DT_NEEDED. On nodejs-mobile the N-API symbols live in libnode.so, which System.loadLibrary mapped into the app's linker namespace and which
#    is NOT visible to a later dlopen unless the add-on lists it: the same class of problem the libsignal neon patch solves (build-libsignal-android.sh). Fix without a compiler:
#    `patchelf --add-needed libnode.so` (the soname is already mapped, so the linker reuses it). `pip install patchelf` or the distro package; set PATCHELF=/path.
#    (Android's linker can also run an add-on with unresolved symbols only lazily; do not rely on it.) minSdk is 24, the prebuilds target API 29: they only use libc functions that
#    exist since API 21-24 as far as `readelf` shows, but that is also unproven below API 29.
# 2. --from-source: rebuilds the same sources with the NDK clang against libnode.so (`-lnode`), minSdk 24, same -Wl,-z,max-page-size=16384. The packages build with cmake-bare (bare-addon);
#    for Node/N-API use `cmake-js`-style flags: see the CMake invocation below. Slower and equally unverified; use it when the prebuilds do not load (e.g. API < 29).
#
# Env: PATCHELF, ANDROID_NDK_HOME. Needs: node + the repo's node_modules (pnpm install), readelf (binutils or llvm-readelf).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; app="$(cd "$here/.." && pwd)"; repo="$(cd "$app/../.." && pwd)"
ABIS="arm64-v8a x86_64"; SRC=0; NDK="${ANDROID_NDK_HOME:-${ANDROID_HOME:-$HOME/Android/Sdk}/ndk/27.2.12479018}"; PATCHELF="${PATCHELF:-patchelf}"
while [ $# -gt 0 ]; do case "$1" in --abis) ABIS="$2"; shift 2;; --from-source) SRC=1; shift;; --ndk) NDK="$2"; shift 2;; *) echo "unknown arg $1" >&2; exit 2;; esac; done
command -v "$PATCHELF" >/dev/null || [ "$SRC" = 1 ] || { echo "missing tool: patchelf (pip install patchelf, or set PATCHELF=...)" >&2; exit 1; }
RE=$(command -v readelf || command -v llvm-readelf) || { echo "missing tool: readelf" >&2; exit 1; }
# resolve the two packages exactly as hyperdht does (pnpm keeps them in a virtual store)
pkgdir() { node -e 'const {createRequire}=require("module"),fs=require("fs");const r=createRequire(process.argv[1]+"/packages/sync/package.json");const h=createRequire(fs.realpathSync(r.resolve("hyperdht")));console.log(require("path").dirname(fs.realpathSync(h.resolve(process.argv[2]+"/package.json"))))' "$repo" "$1"; }
udx="$(pkgdir udx-native)"; sod="$(pkgdir sodium-native)"
echo "udx-native:    $udx"; echo "sodium-native: $sod"
for abi in $ABIS; do
  case "$abi" in arm64-v8a) pre=android-arm64;; x86_64) pre=android-x64;; *) echo "unsupported abi $abi" >&2; exit 1;; esac
  libnode="$app/android/app/libnode/bin/$abi/libnode.so"; [ -f "$libnode" ] || { echo "run scripts/fetch-nodejs-mobile.mjs first ($libnode missing)" >&2; exit 1; }
  dest="$app/android/app/hyperdht/bin/$abi"; mkdir -p "$dest"
  for pair in "udx-native:$udx" "sodium-native:$sod"; do
    name="${pair%%:*}"; dir="${pair#*:}"; so="lib${name//-/_}.so"
    if [ "$SRC" = 1 ]; then
      echo "--from-source: not implemented in this iteration (see header). Cross-compile ${name} with: \$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/${abi/arm64-v8a/aarch64}-linux-android24-clang++ ... -shared -lnode -Wl,-z,max-page-size=16384" >&2; exit 3
    fi
    cp "$dir/prebuilds/$pre/$name.node" "$dest/$so"
    "$PATCHELF" --add-needed libnode.so --set-soname "$so" "$dest/$so"
    # static checks: right ELF machine, 16 KB LOAD alignment, every undefined napi_* / node_api_* symbol is exported by libnode.so
    "$RE" -h "$dest/$so" | grep -q "Type:.*DYN" || { echo "$so is not a shared object" >&2; exit 1; }
    for al in $("$RE" -lW "$dest/$so" | awk '$1=="LOAD" {print $NF}'); do (( al >= 16384 )) || { echo "$so: LOAD alignment $al is below 16 KB" >&2; exit 1; }; done
    missing=0; exported="$("$RE" --dyn-syms -W "$libnode" | awk '{print $8}')"
    for sym in $("$RE" --dyn-syms -W "$dest/$so" | awk '/UND/ && /napi_|node_api/ {print $8}'); do grep -qx "$sym" <<<"$exported" || { echo "  libnode.so does not export $sym" >&2; missing=1; }; done
    [ "$missing" = 0 ] || { echo "$so needs N-API functions this libnode.so lacks" >&2; exit 1; }
    echo "staged $dest/$so  (NEEDED: $("$RE" -d "$dest/$so" | awk '/NEEDED/ {gsub(/[\[\]]/,"",$NF); printf "%s ", $NF}'))"
  done
done
cat <<MSG

Next: node scripts/build-backend-bundle.mjs && pnpm exec cap sync android && (cd android && ./gradlew assembleDebug)
UNVERIFIED on a device: turn on "Reach my devices from anywhere" (Settings > Sync > Advanced) and check Sync status: "Ready" = the add-ons loaded; "not available on this platform" = they did not (logcat tag UnimsgNode has the dlopen error).
MSG
