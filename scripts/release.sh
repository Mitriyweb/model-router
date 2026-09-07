#!/usr/bin/env sh

set -eu

bump_type="${1:-}"
case "$bump_type" in
  major|minor|patch) ;;
  *)
    printf 'Usage: bun run release -- <major|minor|patch>\n' >&2
    exit 1
    ;;
esac

command -v git >/dev/null 2>&1 || { printf 'git is required\n' >&2; exit 1; }
command -v gh >/dev/null 2>&1 || { printf 'GitHub CLI (gh) is required\n' >&2; exit 1; }

git diff --cached --quiet || { printf 'Staged changes exist; commit or unstage them first\n' >&2; exit 1; }

bun run bump:version -- "$bump_type"
bun run verify

git add package.json
version="$(bun -e "console.log((await Bun.file('package.json').json()).version)")"
tag="${version}"

git commit -m "chore: bump version to ${version}"
git tag "$tag"
git push origin HEAD "$tag"
gh release create "$tag" --generate-notes --verify-tag

printf 'Published model-router %s\n' "$tag"
