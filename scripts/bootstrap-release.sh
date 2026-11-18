#!/usr/bin/env bash
set -euo pipefail

# One-time, interactive bootstrap for nod's publishing pipeline. The release
# workflows are switched off (skipped) until the very last phase sets the
# RELEASE_ENABLED repository variable. npm requires a package to exist before a
# trusted publisher can be attached to it, but CI has no stored token to make
# that first publish, so someone has to break the cycle by hand, once. This
# script does everything around that manual core that CAN be automated or
# verified, and pauses for the steps that genuinely cannot (npm org creation
# and trusted-publisher entry both need a browser).
#
# EVERY outward-facing step first prints what it will do and asks for
# confirmation; answering anything but "y" skips that step. Nothing is
# changed by merely reading this file or by answering "n" throughout.
#
# Idempotent: every step checks what already exists before acting, so a failure
# part-way through is fixed by just re-running the script.
#
# Usage (run from a checkout of FreshlyBrewedCode/nod):
#   scripts/bootstrap-release.sh              # all phases, in order
#   scripts/bootstrap-release.sh github       # environment, branch protection, stable branch, tag
#   scripts/bootstrap-release.sh ui           # nod-ui repo, deploy key, UI Pages
#   scripts/bootstrap-release.sh npm          # npm package-name stub
#   scripts/bootstrap-release.sh trusted-publishers
#   scripts/bootstrap-release.sh enable       # sets RELEASE_ENABLED=true: the switch
#
# DNS is not in here: point `ui.nod` (and, once the site exists, `nod`) under
# frebreco.de at freshlybrewedcode.github.io with CNAME records wherever the
# zone lives. The `dns` phase prints exactly what to add.

OWNER="FreshlyBrewedCode"
REPO="nod"
UI_REPO="nod-ui"
UI_DOMAIN="ui.nod.frebreco.de"
SITE_DOMAIN="nod.frebreco.de"
PAGES_HOST="freshlybrewedcode.github.io"
UI_SECRET="UI_DEPLOY_KEY"
SWITCH_VARIABLE="RELEASE_ENABLED"
NPM_ORG="frebreco"
REPO_SLUG="${OWNER}/${REPO}"
WORKFLOW_FILE="release.yml"
ENVIRONMENT="release"
FLOOR_TAG="v0.1.0"
REQUIRED_CHECK="check"
PACKAGES=("@frebreco/nod")

log()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$1"; }
info() { printf '    - %s\n' "$1"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$1" >&2; }
die()  { printf 'error: %s\n' "$1" >&2; exit 1; }

# Asks before an outward-facing step; the caller skips the step on a non-zero
# return. Usage: if will "what it does" "the command line"; then ...; fi
will() {
  printf '\n    \033[1mWILL:\033[0m %s\n' "$1"
  [ -z "${2:-}" ] || printf '          $ %s\n' "$2"
  local answer
  read -r -p "    Proceed? [y/N] " answer || answer=""
  case "$answer" in
    y | Y | yes) return 0 ;;
    *) info "skipped"; return 1 ;;
  esac
}

confirm() {
  read -r -p "    Press Enter once done (Ctrl-C to abort)... " _ || true
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not on PATH."
}

# ---------------------------------------------------------------- Phase 1

phase_github() {
  log "Phase 1 — GitHub"
  require_cmd gh
  require_cmd git

  gh auth status >/dev/null 2>&1 || die "gh is not authenticated; run 'gh auth login' first."
  ok "gh is authenticated as $(gh api user -q .login)"
  gh repo view "$REPO_SLUG" >/dev/null 2>&1 || die "repository $REPO_SLUG not found or not visible."

  if [ "$(gh config get git_protocol 2>/dev/null || echo unknown)" = "https" ] \
    && ! gh auth status 2>&1 | grep -q "'workflow'"; then
    warn "the 'workflow' scope may be missing; pushing .github/workflows/* over"
    warn "HTTPS needs it — run 'gh auth refresh -s workflow' if a push below fails."
  fi

  if gh api "repos/${REPO_SLUG}/environments/${ENVIRONMENT}" >/dev/null 2>&1; then
    ok "the '${ENVIRONMENT}' environment already exists"
  elif will "create the '${ENVIRONMENT}' environment on ${REPO_SLUG} (no required reviewers: it exists to narrow the OIDC subject npm trusts)" \
    "gh api --method PUT repos/${REPO_SLUG}/environments/${ENVIRONMENT}"; then
    gh api --method PUT "repos/${REPO_SLUG}/environments/${ENVIRONMENT}" >/dev/null
  fi

  if will "require the '${REQUIRED_CHECK}' status check on main and allow squash-merge only on ${REPO_SLUG}" \
    "gh api --method PUT repos/${REPO_SLUG}/branches/main/protection ...; gh api --method PATCH repos/${REPO_SLUG} -f allow_squash_merge=true -f allow_merge_commit=false -f allow_rebase_merge=false"; then
    gh api --method PUT "repos/${REPO_SLUG}/branches/main/protection" --input - >/dev/null <<JSON
{
  "required_status_checks": { "strict": true, "contexts": ["${REQUIRED_CHECK}"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
    gh api --method PATCH "repos/${REPO_SLUG}" \
      -f allow_squash_merge=true \
      -f allow_merge_commit=false \
      -f allow_rebase_merge=false >/dev/null
    ok "branch protection applied"
  fi

  # semantic-release needs a non-pre-release branch configured, which is why
  # `.releaserc.json` names `stable`. The branch itself is never pushed to or
  # published from; it exists so the config is valid and stable releases can
  # still be cut from main on demand via workflow_dispatch.
  if git ls-remote --exit-code --heads "git@github.com:${REPO_SLUG}.git" stable >/dev/null 2>&1; then
    ok "the 'stable' branch already exists"
  elif will "create the 'stable' branch at main (referenced by .releaserc.json, never published from)" \
    "git push git@github.com:${REPO_SLUG}.git <main sha>:refs/heads/stable"; then
    gh api --method POST "repos/${REPO_SLUG}/git/refs" \
      -f ref="refs/heads/stable" \
      -f sha="$(gh api "repos/${REPO_SLUG}/git/ref/heads/main" -q .object.sha)" >/dev/null
  fi

  if gh api "repos/${REPO_SLUG}/git/ref/tags/${FLOOR_TAG}" >/dev/null 2>&1; then
    ok "$FLOOR_TAG is already tagged"
  elif will "tag ${FLOOR_TAG} at main: establishes the 0.x floor so semantic-release never parses history before it" \
    "gh api --method POST repos/${REPO_SLUG}/git/refs -f ref=refs/tags/${FLOOR_TAG} -f sha=<main sha>"; then
    gh api --method POST "repos/${REPO_SLUG}/git/refs" \
      -f ref="refs/tags/${FLOOR_TAG}" \
      -f sha="$(gh api "repos/${REPO_SLUG}/git/ref/heads/main" -q .object.sha)" >/dev/null
  fi
}

# Sets a Pages site's custom domain, and HTTPS once GitHub has its certificate
# (which needs the DNS record in place first — re-run to finish).
pages_domain() {
  local slug="$1" domain="$2"
  gh api --method PUT "repos/${slug}/pages" -f cname="$domain" >/dev/null
  ok "$slug serves $domain"
  if gh api --method PUT "repos/${slug}/pages" -F https_enforced=true >/dev/null 2>&1; then
    ok "HTTPS is enforced on $domain"
  else
    warn "HTTPS can't be enforced on $domain yet — GitHub issues the certificate once"
    warn "DNS points at it. Re-run this phase later."
  fi
}

# ---------------------------------------------------------------- Phase 2

phase_ui() {
  log "Phase 2 — the web app's Pages repo"
  require_cmd gh
  require_cmd git
  require_cmd ssh-keygen

  local ui_slug="${OWNER}/${UI_REPO}"
  if gh repo view "$ui_slug" >/dev/null 2>&1; then
    ok "repository $ui_slug already exists"
  elif will "create the public repository ${ui_slug} (built files only, deployed by ui.yml)" \
    "gh repo create ${ui_slug} --public --homepage https://${UI_DOMAIN}"; then
    gh repo create "$ui_slug" --public \
      --description "Built web app of ${REPO_SLUG}, served at https://${UI_DOMAIN}. Deployed by its release workflow, don't edit." \
      --homepage "https://${UI_DOMAIN}"
  else
    return 0
  fi

  # Pages needs a branch to serve before it can be enabled; the first commit
  # holds only what every deploy writes anyway.
  if gh api "repos/${ui_slug}/branches/main" >/dev/null 2>&1; then
    ok "$ui_slug has a main branch"
  elif will "push a first commit (CNAME, .nojekyll) to ${ui_slug} main" \
    "git push git@github.com:${ui_slug}.git main"; then
    local seed name email
    seed=$(mktemp -d)
    # The identity of this checkout, which may not be set globally.
    name=$(git config user.name)
    email=$(git config user.email)
    (
      cd "$seed"
      git init -q -b main
      git config user.name "$name"
      git config user.email "$email"
      echo "$UI_DOMAIN" >CNAME
      touch .nojekyll
      git add -A
      git commit -q -m "chore: seed Pages"
      git push -q "git@github.com:${ui_slug}.git" main
    )
    rm -rf "$seed"
  fi

  if gh api "repos/${ui_slug}/pages" >/dev/null 2>&1; then
    ok "GitHub Pages is enabled on $ui_slug"
  elif will "enable GitHub Pages (source: main, /) on ${ui_slug}" \
    "gh api --method POST repos/${ui_slug}/pages -f source[branch]=main -f source[path]=/"; then
    gh api --method POST "repos/${ui_slug}/pages" \
      -f "source[branch]=main" -f "source[path]=/" >/dev/null
  fi

  if will "set the custom domain ${UI_DOMAIN} on ${ui_slug} Pages and enforce HTTPS if the certificate is ready (DNS must point at it first)" \
    "gh api --method PUT repos/${ui_slug}/pages -f cname=${UI_DOMAIN}"; then
    pages_domain "$ui_slug" "$UI_DOMAIN"
  fi

  if gh secret list --repo "$REPO_SLUG" | grep -q "^${UI_SECRET}\b"; then
    ok "$REPO_SLUG has the $UI_SECRET secret"
  elif will "mint an ed25519 deploy key: public half as a write deploy key on ${ui_slug}, private half as the ${UI_SECRET} secret on ${REPO_SLUG}" \
    "ssh-keygen ...; gh repo deploy-key add ... --allow-write; gh secret set ${UI_SECRET} --repo ${REPO_SLUG}"; then
    local keydir
    keydir=$(mktemp -d)
    ssh-keygen -q -t ed25519 -N "" -C "${REPO_SLUG} ui.yml" -f "${keydir}/key"
    gh repo deploy-key add "${keydir}/key.pub" --repo "$ui_slug" --allow-write --title "${REPO_SLUG} ui.yml"
    gh secret set "$UI_SECRET" --repo "$REPO_SLUG" <"${keydir}/key"
    rm -rf "$keydir"
  fi
}

# ---------------------------------------------------------------- Phase 3

phase_dns() {
  log "DNS records (not automated: add them wherever the frebreco.de zone lives)"
  printf '      %-6s %-24s %s\n' "CNAME" "ui.nod" "$PAGES_HOST"
  printf '      %-6s %-24s %s\n' "CNAME" "nod" "$PAGES_HOST   (only once the site exists; there is none yet)"
  info "Then re-run the 'ui' phase so GitHub can enforce HTTPS on ${UI_DOMAIN}."
  confirm
}

# ---------------------------------------------------------------- Phase 4

phase_npm() {
  log "Phase 3 — npm package stub"
  require_cmd npm

  local npm_version smallest
  npm_version=$(npm --version)
  smallest=$(printf '%s\n%s\n' "11.5.1" "$npm_version" | sort -V | head -1)
  [ "$smallest" = "11.5.1" ] || die "npm ${npm_version} is too old; trusted publishing needs npm >= 11.5.1."
  ok "npm ${npm_version} (>= 11.5.1)"

  if npm whoami >/dev/null 2>&1; then
    ok "npm logged in as $(npm whoami)"
  else
    warn "not logged in to npm."
    info "run 'npm login', then re-run this script."
    exit 1
  fi

  if ! npm org ls "$NPM_ORG" >/dev/null 2>&1; then
    die "the @${NPM_ORG} organisation doesn't exist (or you're not a member); create it at https://www.npmjs.com/org/create"
  else
    ok "the @${NPM_ORG} organisation exists"
  fi

  local stub_root
  stub_root=$(mktemp -d)

  for pkg in "${PACKAGES[@]}"; do
    if npm view "$pkg" version >/dev/null 2>&1; then
      ok "$pkg already exists on the registry"
      continue
    fi
    will "publish a 0.0.1 placeholder of ${pkg} to the npm registry, enough for a trusted publisher to attach to (cannot be undone)" \
      "npm publish --access public" || continue
    local dir="${stub_root}/${pkg//\//-}"
    mkdir -p "$dir"
    cat >"${dir}/package.json" <<JSON
{
  "name": "${pkg}",
  "version": "0.0.1",
  "description": "Placeholder that reserves this name before the first real release.",
  "license": "MIT",
  "repository": { "type": "git", "url": "git+https://github.com/${REPO_SLUG}.git" }
}
JSON
    echo "Placeholder for \`${pkg}\`. See https://github.com/${REPO_SLUG}." >"${dir}/README.md"
    (cd "$dir" && npm publish --access public)
  done

  rm -rf "$stub_root"
}

# ---------------------------------------------------------------- Phase 5

phase_trusted_publishers() {
  log "Phase 4 — npm trusted publishers"
  info "For EACH of the ${#PACKAGES[@]} packages below, open its npmjs.com settings"
  info "(Settings → Trusted Publisher → GitHub Actions) and enter these exact values:"
  echo
  printf '      %-20s %s\n' "Organization/user:" "$OWNER"
  printf '      %-20s %s\n' "Repository:" "$REPO"
  printf '      %-20s %s\n' "Workflow filename:" "$WORKFLOW_FILE"
  printf '      %-20s %s\n' "Environment name:" "$ENVIRONMENT"
  echo
  warn "npm's 2026-09-03 policy defaults new trusted-publisher configs to allow only"
  warn "'npm stage publish'. Tick the 'npm publish' allowed-action checkbox explicitly —"
  warn "npm does not validate this on save; a mistake here surfaces later as an opaque"
  warn "404 or 422 during the first real release."

  for pkg in "${PACKAGES[@]}"; do
    echo
    info "package: ${pkg}"
    info "  https://www.npmjs.com/package/${pkg}/access"
    confirm
  done

  log "Re-verifying all ${#PACKAGES[@]} package(s) resolve"
  for pkg in "${PACKAGES[@]}"; do
    if npm view "$pkg" version >/dev/null 2>&1; then
      ok "$pkg resolves on the registry"
    else
      warn "$pkg does not resolve — recheck the trusted-publisher setup above."
    fi
  done
}

# ---------------------------------------------------------------- Phase 6

phase_enable() {
  log "Phase 5 — switch the release workflows on"
  require_cmd gh
  warn "After this, every merge to main publishes @frebreco/nod@next and deploys ui.nod.frebreco.de/next."
  warn "Do it only once the previous phases are done."
  if will "set the repository variable ${SWITCH_VARIABLE}=true on ${REPO_SLUG}" \
    "gh variable set ${SWITCH_VARIABLE} --body true --repo ${REPO_SLUG}"; then
    gh variable set "$SWITCH_VARIABLE" --body true --repo "$REPO_SLUG"
    ok "${SWITCH_VARIABLE}=true: the release workflows are on"
  fi
}

# --------------------------------------------------------------------- Main

main() {
  case "${1:-all}" in
    github) phase_github ;;
    ui) phase_ui ;;
    dns) phase_dns ;;
    npm) phase_npm ;;
    trusted-publishers) phase_trusted_publishers ;;
    enable) phase_enable ;;
    all)
      phase_github
      phase_ui
      phase_dns
      phase_npm
      phase_trusted_publishers
      phase_enable
      ;;
    *) die "usage: $0 [github|ui|dns|npm|trusted-publishers|enable|all]" ;;
  esac
  log "Done."
}

main "$@"
