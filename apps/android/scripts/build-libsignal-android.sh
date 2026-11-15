#!/usr/bin/env bash
# Cross-compiles libsignal's Node add-on (crate libsignal-node, neon / N-API) for nodejs-mobile on Android and drops it where Gradle packages it:
#   apps/android/android/app/libsignal/bin/<abi>/libsignal_client_node.so      (jniLibs; NodeRuntime.java System.loadLibrary()s it)
# `node scripts/build-backend-bundle.mjs` then picks the REAL @signalapp/libsignal-client automatically (otherwise the throwing stub).
#
#   scripts/build-libsignal-android.sh [--ndk DIR] [--tag v0.106.2] [--abis "arm64-v8a x86_64"] [--toolchain stable]
#
# Env: LIBSIGNAL_WORK (clone, default apps/android/build/libsignal-src), CARGO_TARGET_DIR (big: ~3 GB per ABI; point it at a roomy disk), TMPDIR.
# Needs: rustup + cargo (+ `cargo install cargo-ndk --locked`, done below), git, protoc, cmake, clang, NDK 27.2.12479018, scripts/fetch-nodejs-mobile.mjs run before.
#
# Two things that were found the hard way (emulator, x86_64):
#  1. neon 1.x resolves every napi_* function with dlsym on `Library::this()` (= dlopen(NULL)). On Android nodejs-mobile's libnode.so is loaded by
#     System.loadLibrary into the app's linker namespace, so those symbols are NOT visible that way and neon panics ("Failed to find N-API version",
#     "panic in a function that cannot unwind" -> the whole app process aborts). Fix: a copy of neon 1.1.1 patched to open "libnode.so" by soname
#     first (android only) and `[patch.crates-io]`-ed into the libsignal workspace below. Linking with -lnode is NOT needed (the add-on has no
#     undefined napi_* symbols).
#  2. The pinned rust-toolchain of libsignal (1.98.1) is not required: any recent stable that satisfies rust-version works (1.97.1 used).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; app="$(cd "$here/.." && pwd)"
NDK="${ANDROID_NDK_HOME:-${ANDROID_HOME:-$HOME/Android/Sdk}/ndk/27.2.12479018}"; TAG="v0.106.2"; ABIS="arm64-v8a x86_64"; TOOLCHAIN="${RUSTUP_TOOLCHAIN:-stable}"
while [ $# -gt 0 ]; do case "$1" in --ndk) NDK="$2"; shift 2;; --tag) TAG="$2"; shift 2;; --abis) ABIS="$2"; shift 2;; --toolchain) TOOLCHAIN="$2"; shift 2;; *) echo "unknown arg $1" >&2; exit 2;; esac; done
need() { command -v "$1" >/dev/null || { echo "missing tool: $1 ($2)" >&2; exit 1; }; }
need cargo "install rustup: https://rustup.rs"; need rustup "install rustup"; need git git; need protoc "package protobuf-compiler / protobuf"; need cmake cmake; need clang clang
[ -d "$NDK" ] || { echo "NDK not found at $NDK (sdkmanager \"ndk;27.2.12479018\")" >&2; exit 1; }
export RUSTUP_TOOLCHAIN="$TOOLCHAIN" ANDROID_NDK_HOME="$NDK"
command -v cargo-ndk >/dev/null || cargo install cargo-ndk --locked
work="${LIBSIGNAL_WORK:-$app/build/libsignal-src}"
[ -d "$work/.git" ] || git clone --depth 1 --branch "$TAG" https://github.com/signalapp/libsignal.git "$work"
cd "$work"
# --- patched neon (see 1.) -------------------------------------------------------------------------------------------------------------
neon_dir="$(dirname "$work")/neon-patched"
if [ ! -d "$neon_dir" ]; then
  cargo fetch --quiet
  src="$(ls -d "${CARGO_HOME:-$HOME/.cargo}"/registry/src/*/neon-1.1.1 | head -1)"; cp -r "$src" "$neon_dir"
  python3 - "$neon_dir/src/sys/bindings/functions.rs" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
old="""    #[cfg(not(windows))]
    let host = libloading::os::unix::Library::this().into();"""
new="""    // UniChat/Android: libnode.so lives in the app's linker namespace; open it by soname (already mapped: same handle)
    #[cfg(target_os = "android")]
    let host = libloading::os::unix::Library::open(Some("libnode.so"), libloading::os::unix::RTLD_NOW)
        .unwrap_or_else(|_| libloading::os::unix::Library::this())
        .into();
    #[cfg(all(not(windows), not(target_os = "android")))]
    let host = libloading::os::unix::Library::this().into();"""
assert old in s; open(p,"w").write(s.replace(old,new))
PY
fi
grep -q "neon-patched" Cargo.toml || sed -i "s|^\[patch.crates-io\]|[patch.crates-io]\nneon = { path = \"$neon_dir\" }|" Cargo.toml
# ---------------------------------------------------------------------------------------------------------------------------------------
for abi in $ABIS; do
  case "$abi" in arm64-v8a) triple=aarch64-linux-android;; x86_64) triple=x86_64-linux-android;; *) echo "unsupported abi $abi"; exit 1;; esac
  rustup target add "$triple"
  # same cfgs/profile choices as libsignal's node/build_node_bridge.py, but thin LTO (fat LTO needs a lot of RAM) and symbols stripped;
  # 16 KB page alignment for Android 15+ devices; CMAKE_ARGS works around the cmake-rs issue libsignal documents.
  export RUSTFLAGS="--cfg tokio_unstable --cfg aes_armv8 -C link-arg=-Wl,-z,max-page-size=16384"
  export CARGO_PROFILE_RELEASE_LTO=thin CARGO_PROFILE_RELEASE_DEBUG=0 CARGO_PROFILE_RELEASE_STRIP=symbols CMAKE_ARGS="-DCMAKE_SYSTEM_NAME="
  cargo ndk --target "$abi" --platform 24 build --release -p libsignal-node --features log/release_max_level_info
  dest="$app/android/app/libsignal/bin/$abi"; mkdir -p "$dest"
  cp "${CARGO_TARGET_DIR:-$work/target}/$triple/release/libsignal_node.so" "$dest/libsignal_client_node.so"
  echo "built $dest/libsignal_client_node.so"
done
cat <<MSG

Next: node scripts/build-backend-bundle.mjs && pnpm exec cap sync android && (cd android && ./gradlew assembleDebug)
Verify on a device/emulator with the provider tests, see README "Provider probe / Signal tests".
MSG
