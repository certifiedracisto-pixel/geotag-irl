#!/usr/bin/env bash
# Publish GeoTag IRL to GitHub Pages (main branch, repo root) in one command.
#
#   bash deploy.sh              # creates/uses a public repo named "geotag-irl"
#   bash deploy.sh my-repo      # use a different repo name
#
# Needs: git, and the GitHub CLI (https://cli.github.com) signed in with `gh auth login`.
# On Windows run it from Git Bash.
set -euo pipefail
cd "$(dirname "$0")"

REPO_NAME="${1:-geotag-irl}"
BRANCH="main"

command -v git >/dev/null || { echo "git is required: https://git-scm.com"; exit 1; }
command -v gh  >/dev/null || { echo "GitHub CLI is required: https://cli.github.com"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Not signed in. Run: gh auth login"; exit 1; }

# Stamp the service-worker cache version so phones fetch the new files.
STAMP="$(date +%Y%m%d%H%M%S)"
sed -i.bak -E "s/^const VERSION = '.*';/const VERSION = 'geotag-${STAMP}';/" sw.js && rm -f sw.js.bak

[ -d .git ] || git init -q -b "$BRANCH"
git add -A
git commit -q -m "Deploy GeoTag IRL ${STAMP}" || echo "Nothing new to commit."
git branch -M "$BRANCH"

OWNER="$(gh api user -q .login)"
if git remote get-url origin >/dev/null 2>&1; then
  REPO_NAME="$(basename -s .git "$(git remote get-url origin)")"
elif gh repo view "$OWNER/$REPO_NAME" >/dev/null 2>&1; then
  git remote add origin "https://github.com/$OWNER/$REPO_NAME.git"
else
  gh repo create "$REPO_NAME" --public --source=. --remote=origin
fi

git push -u origin "$BRANCH"

# Turn on Pages for main:/ (POST creates it, PUT updates it if it already exists).
gh api -X POST "repos/$OWNER/$REPO_NAME/pages" -f "source[branch]=$BRANCH" -f "source[path]=/" >/dev/null 2>&1 \
  || gh api -X PUT "repos/$OWNER/$REPO_NAME/pages" -f "source[branch]=$BRANCH" -f "source[path]=/" >/dev/null 2>&1 \
  || echo "Could not switch Pages on automatically. Do it in Settings > Pages (branch: $BRANCH, folder: / root)."

echo
echo "Done. Your game will be live in about a minute at:"
echo "  https://$OWNER.github.io/$REPO_NAME/"
