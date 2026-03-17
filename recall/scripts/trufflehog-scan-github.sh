#!/usr/bin/env bash
# Scan all repositories in a GitHub org (or specific repos) with TruffleHog.
# Requires: trufflehog (brew install trufflesecurity/trufflehog/trufflehog), GITHUB_TOKEN.
#
# Usage:
#   GITHUB_TOKEN=ghp_xxx ./recall/scripts/trufflehog-scan-github.sh
#   GITHUB_TOKEN=ghp_xxx GITHUB_ORG=myorg ./recall/scripts/trufflehog-scan-github.sh
#   GITHUB_TOKEN=ghp_xxx ./recall/scripts/trufflehog-scan-github.sh myorg
#
# Optional env:
#   GITHUB_ORG     – GitHub org (or user) to scan; default: inferred from git remote
#   TRUFFLEHOG_VERIFIED_ONLY – set to 1 to only report verified secrets (default: 1)
#   TRUFFLEHOG_INCLUDE_MEMBERS – set to 1 to include org members' repos
#   TRUFFLEHOG_INCLUDE_WIKIS  – set to 1 to include wikis
#   TRUFFLEHOG_ISSUE_PR_COMMENTS – set to 1 to include issue/PR comments

set -e

if ! command -v trufflehog &>/dev/null; then
  echo "trufflehog not found. Install with: brew install trufflesecurity/trufflehog/trufflehog" >&2
  exit 1
fi

if [ -z "$GITHUB_TOKEN" ]; then
  echo "GITHUB_TOKEN is required (create a token with repo scope at https://github.com/settings/tokens)." >&2
  exit 1
fi

ORG="${GITHUB_ORG:-$1}"
if [ -z "$ORG" ]; then
  REMOTE="$(git remote get-url origin 2>/dev/null || true)"
  if [[ "$REMOTE" =~ github\.com[:/]([^/]+)/ ]]; then
    ORG="${BASH_REMATCH[1]}"
    echo "Using GitHub org/user from origin: $ORG"
  else
    echo "Could not infer GitHub org. Set GITHUB_ORG or run: $0 <org-name>" >&2
    exit 1
  fi
fi

EXTRA_ARGS=()
if [ "${TRUFFLEHOG_VERIFIED_ONLY:-1}" = "1" ]; then
  EXTRA_ARGS+=(--results=verified)
fi
[ "${TRUFFLEHOG_INCLUDE_MEMBERS:-0}" = "1" ] && EXTRA_ARGS+=(--include-members)
[ "${TRUFFLEHOG_INCLUDE_WIKIS:-0}" = "1" ] && EXTRA_ARGS+=(--include-wikis)
if [ "${TRUFFLEHOG_ISSUE_PR_COMMENTS:-0}" = "1" ]; then
  EXTRA_ARGS+=(--issue-comments --pr-comments)
fi

echo "Scanning GitHub org/user: $ORG"
exec trufflehog github --org="$ORG" --token="$GITHUB_TOKEN" "${EXTRA_ARGS[@]}" "$@"
