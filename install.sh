#!/usr/bin/env bash
set -e

REPO="Mitriyweb/model-router"
GITHUB_URL="https://github.com/${REPO}"
BINARY_NAME="model-router"

# Text styles
BOLD="\033[1m"
GREEN="\033[32m"
BLUE="\033[34m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

echo -e "${BOLD}${BLUE}==> Installing model-router...${RESET}"

# 1. Detect OS
OS="$(uname -s)"
case "${OS}" in
  Darwin)
    TARGET_OS="darwin"
    ;;
  Linux)
    TARGET_OS="linux"
    ;;
  *)
    echo -e "${RED}Error: Unsupported operating system: ${OS}${RESET}"
    exit 1
    ;;
esac

# 2. Detect Architecture
ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64|amd64)
    TARGET_ARCH="x64"
    ;;
  arm64|aarch64)
    TARGET_ARCH="arm64"
    ;;
  *)
    echo -e "${RED}Error: Unsupported architecture: ${ARCH}${RESET}"
    exit 1
    ;;
esac

TARGET_NAME="model-router-${TARGET_OS}-${TARGET_ARCH}"
DOWNLOAD_URL="${GITHUB_URL}/releases/latest/download/${TARGET_NAME}"

# 3. Determine install destination
INSTALL_DIR="${HOME}/.local/bin"
mkdir -p "${INSTALL_DIR}"
TARGET_PATH="${INSTALL_DIR}/${BINARY_NAME}"

echo -e "Target system: ${GREEN}${TARGET_OS}-${TARGET_ARCH}${RESET}"
echo -e "Downloading latest release from ${BLUE}${DOWNLOAD_URL}${RESET}..."

# 4. Download binary
TEMP_FILE="$(mktemp)"
HTTP_STATUS=$(curl -fsSL -w "%{http_code}" -o "${TEMP_FILE}" "${DOWNLOAD_URL}" || true)

if [ "${HTTP_STATUS}" -ne 200 ] && [ "${HTTP_STATUS}" -ne 302 ]; then
  # If release binary not yet published, check if bun is available to build locally
  echo -e "${YELLOW}Notice: Prebuilt binary not found on GitHub Releases (HTTP ${HTTP_STATUS}).${RESET}"
  if command -v bun >/dev/null 2>&1; then
    echo -e "${BLUE}Attempting to build with local Bun...${RESET}"
    BUILD_TMP="$(mktemp -d)"
    git clone --depth 1 "${GITHUB_URL}.git" "${BUILD_TMP}"
    (cd "${BUILD_TMP}" && bun install && bun run build)
    mv "${BUILD_TMP}/dist/model-router" "${TARGET_PATH}"
    rm -rf "${BUILD_TMP}" "${TEMP_FILE}"
  else
    echo -e "${RED}Error: Failed to download ${TARGET_NAME} and Bun is not installed to compile from source.${RESET}"
    rm -f "${TEMP_FILE}"
    exit 1
  fi
else
  mv "${TEMP_FILE}" "${TARGET_PATH}"
fi

chmod +x "${TARGET_PATH}"

echo -e "${GREEN}✓ Successfully installed ${BINARY_NAME} to ${TARGET_PATH}${RESET}"

# 5. Check PATH
case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo -e ""
    echo -e "${YELLOW}Note:${RESET} ${INSTALL_DIR} is not in your PATH."
    echo -e "Add it to your shell configuration (e.g. ~/.bashrc or ~/.zshrc):"
    echo -e "  ${BOLD}export PATH=\"\$HOME/.local/bin:\$PATH\"${RESET}"
    ;;
esac

echo -e ""
echo -e "${BOLD}Quick Start:${RESET}"
echo -e "  1. Run ${BLUE}model-router --help${RESET} to check options"
echo -e "  2. Configure your API keys (e.g. ${BLUE}export GROQ_API_KEY=...${RESET} or ${BLUE}export GEMINI_API_KEY=...${RESET})"
echo -e "  3. Start model-router: ${BLUE}model-router${RESET}"
echo -e "  4. Point Claude Code to it: ${BLUE}export ANTHROPIC_BASE_URL=http://localhost:8787${RESET}"
