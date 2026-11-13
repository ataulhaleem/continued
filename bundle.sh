#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

EXT_PUBLISHER="AtaUlHaleem"
EXT_NAME="continued"

log() {
	printf "\n\033[1;34m==> %s\033[0m\n" "$1"
}

warn() {
	printf "\n\033[1;33m[warn]\033[0m %s\n" "$1"
}

fail() {
	printf "\n\033[1;31m[error]\033[0m %s\n" "$1"
	exit 1
}

need_cmd() {
	command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

print_usage() {
	cat <<EOF
Usage: ./bundle.sh [--install] [--reinstall] [--keep-build] [--clean] [--vsix-only]

	--install     Install generated VSIX into local VS Code
	--reinstall   Uninstall old extension first, then install new VSIX
	--keep-build  Keep dist/ and out/ after packaging (default: remove them)
	--clean       Remove build intermediates and exit without building
	--vsix-only   Skip the browser extension and the command-line host

The deliverable is the VSIX in artifacts/, which is never removed. Everything
else the build touches (dist/, out/) is an intermediate and is cleaned up.
EOF
}

# Intermediates only. artifacts/ holds the deliverables and is never touched here.
BUILD_DIRS=(dist out)

clean_build_dirs() {
	local removed=()
	for dir in "${BUILD_DIRS[@]}"; do
		if [[ -e "$ROOT_DIR/$dir" ]]; then
			rm -rf "${ROOT_DIR:?}/$dir"
			removed+=("$dir/")
		fi
	done
	if [[ ${#removed[@]} -gt 0 ]]; then
		printf "    removed %s\n" "${removed[*]}"
	fi
}

INSTALL=false
REINSTALL=false
KEEP_BUILD=false
BROWSER=true
CLEAN_ONLY=false

for arg in "$@"; do
	case "$arg" in
		--install)
			INSTALL=true
			;;
		--reinstall)
			INSTALL=true
			REINSTALL=true
			;;
		--vsix-only)
			BROWSER=false
			;;
		--keep-build)
			KEEP_BUILD=true
			;;
		--clean)
			CLEAN_ONLY=true
			;;
		-h|--help)
			print_usage
			exit 0
			;;
		*)
			fail "Unknown argument: $arg"
			;;
	esac
done

if [[ "$CLEAN_ONLY" == "true" ]]; then
	log "Cleaning build intermediates"
	clean_build_dirs
	log "Done"
	exit 0
fi

# Safety net for the failure path: a broken build leaves nothing behind either. The success
# path cleans up explicitly further down so the VSIX path stays the last line printed.
CLEANED=false

on_exit() {
	local status=$?
	if [[ "$KEEP_BUILD" != "true" && "$CLEANED" != "true" ]]; then
		clean_build_dirs
	fi
	exit "$status"
}
trap on_exit EXIT

need_cmd npm
need_cmd npx
need_cmd node

if [[ ! -d node_modules ]]; then
	log "Installing dependencies"
	npm install
fi

log "Type checking"
npm run check-types

log "Linting"
npm run lint

log "Building extension (production bundle)"
clean_build_dirs
# `compile` is the development build: unminified and with a sourcemap. A release uses `package`.
npm run package

ARTIFACTS_DIR="$ROOT_DIR/artifacts"
mkdir -p "$ARTIFACTS_DIR"

VERSION="$(node -p "require('./package.json').version")"
VSIX_FILE="$ARTIFACTS_DIR/${EXT_NAME}-${VERSION}.vsix"

log "Packaging VSIX into artifacts/"
npx @vscode/vsce package --out "$VSIX_FILE"

if [[ ! -f "$VSIX_FILE" ]]; then
	warn "Expected VSIX not found at ${VSIX_FILE}. Using latest continued-*.vsix in artifacts/."
	VSIX_FILE="$(ls -t "$ARTIFACTS_DIR"/continued-*.vsix 2>/dev/null | head -n1 || true)"
fi

[[ -n "${VSIX_FILE:-}" ]] || fail "No VSIX file found after packaging"

# The command-line host: one npm tarball, installable with `npm install -g <tgz>`.
CLI_TGZ=""
if [[ "$BROWSER" == "true" ]]; then
	log "Building command-line host into artifacts/"
	(cd cli && npm run check-types && npm run build && mkdir -p "$ARTIFACTS_DIR" && rm -f "$ARTIFACTS_DIR"/enclave-harness-*.tgz && npm pack --pack-destination "$ARTIFACTS_DIR" >/dev/null)
	CLI_TGZ="$(ls -t "$ARTIFACTS_DIR"/enclave-harness-*.tgz 2>/dev/null | head -n1 || true)"
	[[ -n "$CLI_TGZ" ]] || fail "Expected CLI tarball not found in $ARTIFACTS_DIR"
fi

# The browser extension: one zip per store, ready to upload or to unpack for testing. The
# unpacked build stays in browser-plugin/dist/ so "Load unpacked" / web-ext run work directly.
BROWSER_ZIPS=""
if [[ "$BROWSER" == "true" ]]; then
	log "Building browser extension (Chrome + Firefox) into artifacts/"
	(cd browser-plugin && npm run check-types && npm run zip && npm run source-zip)
	BROWSER_VERSION="$(node -p "require('./browser-plugin/package.json').version")"
	BROWSER_ZIPS="$ARTIFACTS_DIR/enclave-chrome-${BROWSER_VERSION}.zip $ARTIFACTS_DIR/enclave-firefox-${BROWSER_VERSION}.zip"
	for zip in $BROWSER_ZIPS; do
		[[ -f "$zip" ]] || fail "Expected browser zip not found: $zip"
	done
fi

if [[ "$INSTALL" == "true" ]]; then
	need_cmd code

	if [[ "$REINSTALL" == "true" ]]; then
		log "Uninstalling existing extension (${EXT_PUBLISHER}.${EXT_NAME})"
		code --uninstall-extension "${EXT_PUBLISHER}.${EXT_NAME}" || true
	fi

	log "Installing VSIX: $(basename "$VSIX_FILE")"
	code --install-extension "$VSIX_FILE"
fi

if [[ "$KEEP_BUILD" != "true" ]]; then
	log "Cleaning up build intermediates"
	clean_build_dirs
	CLEANED=true
fi

log "Done"
echo "VSIX: $VSIX_FILE"
if [[ -n "$CLI_TGZ" ]]; then echo "CLI: $CLI_TGZ"; fi
if [[ -n "$BROWSER_ZIPS" ]]; then
	for zip in $BROWSER_ZIPS; do echo "Browser: $zip"; done
	echo "Unpacked (for chrome://extensions → Load unpacked): $ROOT_DIR/browser-plugin/dist/chrome"
fi