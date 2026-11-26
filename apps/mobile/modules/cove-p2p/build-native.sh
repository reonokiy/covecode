#!/usr/bin/env bash
set -euo pipefail

crate="$(cd "$(dirname "$0")/../../../../native/cove-p2p" && pwd)"
export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
build() {
  local target="$1"
  shift
  rustup target add "$target"
  cargo rustc --locked --release --manifest-path "$crate/Cargo.toml" --target-dir "$CARGO_TARGET_DIR" --target "$target" -- "$@"
}

case "$1" in
  ios)
    export CARGO_TARGET_DIR="$DERIVED_FILE_DIR/cove-rust"
    archives=()
    for arch in $ARCHS; do
      case "$PLATFORM_NAME/$arch" in
        iphoneos/arm64) target=aarch64-apple-ios ;;
        iphonesimulator/arm64) target=aarch64-apple-ios-sim ;;
        iphonesimulator/x86_64) target=x86_64-apple-ios ;;
        *) echo "Unsupported iOS target $PLATFORM_NAME/$arch" >&2; exit 1 ;;
      esac
      build "$target"
      archives+=("$CARGO_TARGET_DIR/$target/release/libcove_p2p.a")
    done
    xcrun lipo -create "${archives[@]}" -output "$BUILT_PRODUCTS_DIR/libcove_p2p.a"
    ;;
  android)
    ndk="$2"; output="$3"; shift 3
    export CARGO_TARGET_DIR="$(dirname "$output")/cove-rust"
    case "$(uname -s)" in
      Darwin) host=darwin-x86_64 ;;
      Linux) host=linux-x86_64 ;;
      *) echo "Unsupported NDK host" >&2; exit 1 ;;
    esac
    for abi in "$@"; do
      case "$abi" in
        arm64-v8a) target=aarch64-linux-android; clang=aarch64-linux-android ;;
        armeabi-v7a) target=armv7-linux-androideabi; clang=armv7a-linux-androideabi ;;
        x86) target=i686-linux-android; clang=i686-linux-android ;;
        x86_64) target=x86_64-linux-android; clang=x86_64-linux-android ;;
        *) echo "Unsupported Android ABI $abi" >&2; exit 1 ;;
      esac
      tools="$ndk/toolchains/llvm/prebuilt/$host/bin"
      key="${target//-/_}"
      upper="$(echo "$key" | tr '[:lower:]' '[:upper:]')"
      export "CARGO_TARGET_${upper}_LINKER=$tools/${clang}24-clang" "CC_$key=$tools/${clang}24-clang" "AR_$key=$tools/llvm-ar"
      build "$target" -Clink-arg=-Wl,-z,max-page-size=16384
      mkdir -p "$output/$abi"
      cp "$CARGO_TARGET_DIR/$target/release/libcove_p2p.so" "$output/$abi/"
    done
    ;;
  *) exit 1 ;;
esac
