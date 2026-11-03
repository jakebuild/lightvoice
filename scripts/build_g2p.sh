#!/usr/bin/env bash
# Build sea-g2p for the browser and copy it, with its dictionary, into web/g2p.
#
# Upstream sea-g2p (Apache-2.0) is fetched at a pinned commit into vendor/sea-g2p
# and patched with vendor/sea-g2p-lightvoice.patch: in-memory dictionary loading
# plus a `wasm` feature (src/wasm.rs). Needs git, Rust with the
# wasm32-unknown-unknown target, gzip and python3.
set -euo pipefail
cd "$(dirname "$0")/.."

SEA_G2P_REPO=https://github.com/pnnbao97/sea-g2p.git
SEA_G2P_COMMIT=e825173f235d08ea19315b2b279fb11153b44cea

# Checked by Cargo.toml, not the directory: CI restores a cached target/ into
# vendor/sea-g2p before the sources exist. Fetching into the existing directory
# keeps that cache.
if [[ ! -f vendor/sea-g2p/Cargo.toml ]]; then
  mkdir -p vendor/sea-g2p
  git -C vendor/sea-g2p init -q
  git -C vendor/sea-g2p fetch -q --depth 1 "$SEA_G2P_REPO" "$SEA_G2P_COMMIT"
  git -C vendor/sea-g2p checkout -q FETCH_HEAD
  git -C vendor/sea-g2p apply ../sea-g2p-lightvoice.patch
fi

(cd vendor/sea-g2p && cargo build --release --target wasm32-unknown-unknown --no-default-features --features wasm)

# wasm-bindgen-cli must match the wasm-bindgen crate version exactly.
WB_VERSION=$(grep -A1 'name = "wasm-bindgen"$' vendor/sea-g2p/Cargo.lock | sed -n 's/version = "\(.*\)"/\1/p' | head -1)
if ! command -v wasm-bindgen >/dev/null || [[ "$(wasm-bindgen --version)" != *"$WB_VERSION"* ]]; then
  cargo install -f wasm-bindgen-cli --version "$WB_VERSION"
fi

mkdir -p web/g2p
wasm-bindgen --target web --no-typescript --out-dir web/g2p \
  vendor/sea-g2p/target/wasm32-unknown-unknown/release/sea_g2p_rs.wasm
if command -v wasm-opt >/dev/null; then wasm-opt -Oz web/g2p/sea_g2p_rs_bg.wasm -o web/g2p/sea_g2p_rs_bg.wasm; fi
# Vietnamese/English tables only: the Thai and Indonesian sections are ~13 MB the browser never reads.
python3 scripts/strip_dict.py vendor/sea-g2p/python/sea_g2p/sea_g2p.bin web/g2p/sea_g2p.bin
# Shipped pre-gzipped (50 -> 15 MB): hosts rarely compress octet-stream on their own.
# The worker inflates it with DecompressionStream.
gzip -9 -n -f web/g2p/sea_g2p.bin
ls -la web/g2p
