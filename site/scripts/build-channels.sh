#!/usr/bin/env bash
# Builds the docs of both channels into dist/ (see src/lib/channel.ts):
#
#   /       latest — the last stable release's content/, in this checkout's site
#   /next/  next   — this checkout's content/, i.e. main
#
# Only content/ comes from the release tag; the site around it (layouts, the
# version picker, styles, the landing page) is this checkout's, so a site fix
# reaches both. Needs the release tags: in CI, a checkout with fetch-depth 0.
#
# Before the first stable release there is no tag to take the content from
# (and a tag older than the site has no site/content/). Both channels are then
# built from this checkout, and the version picker shows no stable version:
# the root must never be empty, and "the docs of main" is the honest answer
# while nothing is released.
set -euo pipefail
cd "$(dirname "$0")/.."
root=$(git rev-parse --show-toplevel)

# semver: a `-` suffix is a pre-release. The next version is the last release
# on this branch's history, pre-release or not: what `@next` last shipped.
stable=$(git tag -l 'v*' | grep -v -- - | sort -V | tail -1 || true)
next=$(git describe --tags --match 'v*' --abbrev=0 2>/dev/null || true)

content=content/docs
rm -rf .stable
if [ -n "$stable" ] && git -C "$root" cat-file -e "$stable:site/content/docs" 2>/dev/null; then
  # The stable content, extracted rather than checked out, so the working tree
  # (and anyone's uncommitted edits in it) is left alone.
  mkdir .stable
  git -C "$root" archive "$stable" site/content | tar -x --strip-components=1 -C .stable
  content=.stable/content/docs
  export DOCS_LATEST_VERSION=${stable#v}
  echo "docs: latest from $stable, next from $(git rev-parse --short HEAD) (${next:-no release yet})"
else
  echo "docs: no stable release with docs yet (${stable:-no stable tag}); both channels from $(git rev-parse --short HEAD)"
fi
[ -z "$next" ] || export DOCS_NEXT_VERSION=${next#v}

# `--force` clears the content layer's cache between builds. It keys rendered
# markdown on the source alone, and the same source renders differently per
# channel (links, install commands), so a cached page would carry the other
# channel's links. Astro empties its outDir first: latest before next.
DOCS_CHANNEL=latest DOCS_CONTENT=$content bunx astro build --force
bunx pagefind --site dist

DOCS_CHANNEL=next bunx astro build --force --outDir dist/next
# Its own index, so a search on one channel finds only that channel's pages.
# Pagefind prefixes results with the directory it is loaded from, `/next/`.
bunx pagefind --site dist/next

rm -rf .stable
