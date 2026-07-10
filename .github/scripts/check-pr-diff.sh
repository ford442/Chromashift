#!/usr/bin/env bash
# Fail PRs that add build artifacts or likely secrets.
set -euo pipefail

if [[ "${GITHUB_EVENT_NAME:-}" != "pull_request" ]]; then
  if git ls-files 'dist/' | grep -q .; then
    echo "::error::dist/ is tracked in git. Remove build artifacts from version control."
    exit 1
  fi
  exit 0
fi

BASE_SHA="${GITHUB_EVENT_PULL_REQUEST_BASE_SHA:?missing base sha}"
HEAD_SHA="${GITHUB_SHA:?missing head sha}"

while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  if [[ "$path" == dist/* ]]; then
    echo "::error::PR adds or modifies dist/: $path — commit sources, not build output."
    exit 1
  fi
done < <(git diff --name-only "$BASE_SHA" "$HEAD_SHA")

ADDED_LINES=$(git diff "$BASE_SHA" "$HEAD_SHA" | grep -E '^\+' | grep -v '^\+\+\+' || true)
if [[ -n "$ADDED_LINES" ]]; then
  if echo "$ADDED_LINES" | grep -qE 'ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA |OPENSSH )?PRIVATE KEY-----'; then
    echo "::error::Possible secret material detected in PR diff."
    exit 1
  fi
fi

echo "PR diff guard passed."
