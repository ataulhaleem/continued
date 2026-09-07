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
Usage: ./bundle.sh [--install] [--reinstall]

	--install    Install generated VSIX into local VS Code
	--reinstall  Uninstall old extension first, then install new VSIX
EOF
}

INSTALL=false
REINSTALL=false

for arg in "$@"; do
	case "$arg" in
		--install)
			INSTALL=true
			;;
		--reinstall)
			INSTALL=true
			REINSTALL=true
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

log "Building extension"
npm run compile

VERSIONS_DIR="$ROOT_DIR/versions"
mkdir -p "$VERSIONS_DIR"

VERSION="$(node -p "require('./package.json').version")"
VSIX_FILE="$VERSIONS_DIR/${EXT_NAME}-${VERSION}.vsix"

log "Packaging VSIX into versions/"
npx @vscode/vsce package --out "$VSIX_FILE"

if [[ ! -f "$VSIX_FILE" ]]; then
	warn "Expected VSIX not found at ${VSIX_FILE}. Using latest continued-*.vsix in versions/."
	VSIX_FILE="$(ls -t "$VERSIONS_DIR"/continued-*.vsix 2>/dev/null | head -n1 || true)"
fi

[[ -n "${VSIX_FILE:-}" ]] || fail "No VSIX file found after packaging"

if [[ "$INSTALL" == "true" ]]; then
	need_cmd code

	if [[ "$REINSTALL" == "true" ]]; then
		log "Uninstalling existing extension (${EXT_PUBLISHER}.${EXT_NAME})"
		code --uninstall-extension "${EXT_PUBLISHER}.${EXT_NAME}" || true
	fi

	log "Installing VSIX: $(basename "$VSIX_FILE")"
	code --install-extension "$VSIX_FILE"
fi

log "Done"
echo "VSIX: $VSIX_FILE"