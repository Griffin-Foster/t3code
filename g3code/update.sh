#!/bin/bash
# g3code's updater: moves g3code onto the developers' newest T3 Code release.
# The update button in g3code runs this, and it also works from a terminal:
#
#   update.sh status            print the current release and the update's progress
#   update.sh check             look for a newer release (prints current=… latest=…)
#   update.sh prepare <vX.Y.Z>  build the update in a separate copy; the running app is untouched
#   update.sh resume            check that copy again after the helper thread fixed it
#   update.sh install           quit g3code, switch main to the update, push it, reopen g3code
#   update.sh cancel            throw a prepared update away
#   update.sh rollback          put main back to what it was before the last install
#
# Your projects and threads are never touched here: the g3code launcher backs them up
# whenever it starts a version it hasn't run before.

set -u

REPO="${G3CODE_REPO:-$HOME/Developer/t3code}"
STAGE="${G3CODE_UPDATE_STAGE:-$HOME/Developer/.g3code-update}"
STATE_DIR="${G3CODE_UPDATE_STATE:-$HOME/.t3/g3code-update}"
APP="${G3CODE_APP:-/Applications/g3code.app}"
STATUS="$STATE_DIR/status"
LOG="$STATE_DIR/update.log"
BRANCH=g3code/update
ROLLBACK_TAG=g3code/before-update
SERVER_CLI="${G3CODE_SERVER_CLI:-$REPO/apps/server/dist/bin.mjs}"
DATA="${G3CODE_DATA:-$HOME/.t3/dev}"

mkdir -p "$STATE_DIR"
command -v vp >/dev/null 2>&1 || source "$HOME/.config/vite-plus/env" 2>/dev/null

git_repo() { git -C "$REPO" "$@"; }
git_stage() { git -C "$STAGE" "$@"; }

# --- status file: one key=value per line, read by the desktop app -----------------------------

status_get() { [ -f "$STATUS" ] && sed -n "s/^$1=//p" "$STATUS" | tail -1; }

# status_set key=value ...  replaces the whole file, keeping keys that aren't given.
status_set() {
  local tmp="$STATUS.tmp" key line
  : > "$tmp"
  for key in phase target from base commit reason message files helper; do
    line=""
    for pair in "$@"; do
      case "$pair" in "$key="*) line="$pair" ;; esac
    done
    if [ -z "$line" ] && [ "${KEEP:-1}" = 1 ]; then
      local old
      old=$(status_get "$key")
      [ -n "$old" ] && line="$key=$old"
    fi
    [ -n "$line" ] && printf '%s\n' "$(printf '%s' "$line" | tr '\n' ' ')" >> "$tmp"
  done
  mv -f "$tmp" "$STATUS"
}

progress() { echo "::progress $1 $2"; echo "[$(date '+%H:%M:%S')] $2" >> "$LOG"; }

fail() {
  KEEP=1 status_set phase=failed "message=$1"
  echo "::error $1"
  exit 1
}

# --- releases ----------------------------------------------------------------------------------

# Releases are tagged vX.Y.Z; nightly and preview builds have a suffix and are skipped.
latest_release() { git_repo tag -l 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1; }
current_release() { git_repo describe --tags --abbrev=0 --match 'v[0-9]*' --exclude '*-*' main 2>/dev/null; }

# --- the g3code processes ----------------------------------------------------------------------

# Only the dev runner started from $REPO: worktree test apps run the same command elsewhere.
runner_pids() {
  local pid
  for pid in $(pgrep -f "dev-runner.ts dev:desktop"); do
    [ "$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" = "$REPO" ] && echo "$pid"
  done
}
window_running() { pgrep -f "$REPO/apps/desktop/.electron-runtime/" >/dev/null; }

stop_g3code() {
  local pids i
  pids=$(runner_pids)
  [ -n "$pids" ] && kill -TERM $pids 2>/dev/null
  for i in $(seq 1 60); do
    [ -z "$(runner_pids)" ] && ! window_running && return 0
    sleep 0.5
  done
  pids=$(runner_pids)
  [ -n "$pids" ] && kill -KILL $pids 2>/dev/null
  pkill -KILL -f "$REPO/apps/desktop/.electron-runtime/" 2>/dev/null
  sleep 1
}

# --- the helper thread ---------------------------------------------------------------------------

t3() { node "$SERVER_CLI" "$@"; }

# The helper thread's first message.
helper_message() {
  local reason="$1" target="$2" detail="$3"
  cat <<EOF
g3code's updater needs help moving g3code onto the T3 Code release $target.

You're in a temporary copy of the g3code repo at $STAGE, on the branch $BRANCH. It holds the
user's g3code changes (the commits on top of the previous release) being replayed onto $target.
The g3code app the user is running lives in $REPO and must not be touched.

What stopped the update: $reason
$detail

Please:
1. Make the update work while keeping every g3code change. Where a g3code change clashes with
   the new release, adopt the release's new code and re-apply the g3code behavior on top of it.
2. If a rebase is in progress, resolve each conflict, then \`git add\` the files and run
   \`GIT_EDITOR=true git rebase --continue\` until the rebase finishes.
3. Make \`vp run typecheck\` pass. Commit any extra fixes on this branch.
4. Don't push, merge, switch branches, or edit anything outside $STAGE.

When it's done, tell the user to click "Continue update" in g3code's update menu. g3code then
checks this copy again and offers to restart onto it.
EOF
}

# Opens a thread in g3code, working in the update copy, to fix what stopped the update.
open_helper_thread() {
  local reason="$1" target="$2" detail="$3"
  [ -f "$SERVER_CLI" ] || return 1
  [ -n "$(status_get helper)" ] && return 0
  # Helpers use one of these models at medium reasoning: whichever the user ran most recently,
  # else the first. (New projects have no default model.)
  local allowed="'codex/gpt-6.2-sol','codex/gpt-6.2-astra','claudeAgent/claude-opus-5-5'"
  local selection provider model effort_option
  selection=$(sqlite3 "file:$DATA/statev2.sqlite?mode=ro" "select key from (select json_extract(payload_json, '\$.modelSelection.instanceId') || '/' || json_extract(payload_json, '\$.modelSelection.model') as key, updated_at from orchestration_v2_projection_threads where deleted_at is null) where key in ($allowed) order by updated_at desc limit 1" 2>/dev/null)
  [ -n "$selection" ] || selection="codex/gpt-6.2-sol"
  provider="${G3CODE_UPDATE_PROVIDER:-${selection%%/*}}"
  model="${G3CODE_UPDATE_MODEL:-${selection#*/}}"
  [ -n "$provider" ] && [ -n "$model" ] || return 1
  # Codex calls the reasoning option reasoningEffort; Claude calls it effort.
  case "$provider" in
    claude*) effort_option="effort=medium" ;;
    *) effort_option="reasoningEffort=medium" ;;
  esac
  t3 project add --title "g3code update" "$STAGE" >> "$LOG" 2>&1
  if helper_message "$reason" "$target" "$detail" |
    t3 thread start --title "Update g3code to $target" --provider "$provider" --model "$model" --option "$effort_option" "$STAGE" - >> "$LOG" 2>&1; then
    KEEP=1 status_set helper=1
    return 0
  fi
  return 1
}

remove_helper_project() {
  [ -f "$SERVER_CLI" ] && [ -n "$(status_get helper)" ] && t3 project remove "$STAGE" --force >> "$LOG" 2>&1
}

needs_help() {
  local reason="$1" detail="$2" target message
  target=$(status_get target)
  message="$reason"
  if open_helper_thread "$reason" "$target" "$detail"; then
    message="$reason A thread called \"Update g3code to $target\" is working on it. Click Continue update when it's done."
  fi
  KEEP=1 status_set phase=needs-help "reason=$reason" "message=$message" "files=$(echo "$detail" | head -20 | tr '\n' ' ')"
  osascript -e "display notification \"${message//\"/}\" with title \"g3code update needs help\"" >/dev/null 2>&1
  echo "::needs-help $message"
  exit 3
}

# --- steps -------------------------------------------------------------------------------------

remove_stage() {
  [ -d "$STAGE" ] && git_repo worktree remove --force "$STAGE" >> "$LOG" 2>&1
  rm -rf "$STAGE"
  git_repo worktree prune
  git_repo show-ref --quiet --verify "refs/heads/$BRANCH" && git_repo branch -D "$BRANCH" >> "$LOG" 2>&1
  return 0
}

rebase_in_progress() {
  local dir
  dir=$(git_stage rev-parse --absolute-git-dir)
  [ -d "$dir/rebase-merge" ] || [ -d "$dir/rebase-apply" ]
}

# Installs and type-checks the update copy. Ends ready, or needing help.
verify_stage() {
  local target
  target=$(status_get target)
  progress 40 "Installing dependencies"
  if ! (cd "$STAGE" && vp i) >> "$LOG" 2>&1; then
    needs_help "Installing dependencies for $target failed." "$(tail -40 "$LOG")"
  fi
  progress 65 "Checking the code"
  if ! (cd "$STAGE" && vp run typecheck) > "$STATE_DIR/typecheck.log" 2>&1; then
    cat "$STATE_DIR/typecheck.log" >> "$LOG"
    needs_help "Your g3code changes don't type-check against $target." \
      "$(grep -E 'error TS|: error' "$STATE_DIR/typecheck.log" | head -40)"
  fi
  KEEP=1 status_set phase=ready "commit=$(git_stage rev-parse HEAD)" message= reason= files=
  progress 100 "Ready to restart"
}

cmd_status() {
  echo "current=$(current_release)"
  [ -f "$STATUS" ] && cat "$STATUS"
  return 0
}

cmd_check() {
  git_repo fetch --quiet upstream --tags >> "$LOG" 2>&1 || { echo "::error Couldn't reach GitHub to look for updates."; exit 1; }
  echo "current=$(current_release)"
  echo "latest=$(latest_release)"
}

cmd_prepare() {
  local target="${1:-}"
  [ -n "$target" ] || target=$(latest_release)
  git_repo rev-parse --quiet --verify "refs/tags/$target" >/dev/null || fail "There's no release called $target."
  : > "$LOG"
  KEEP=0 status_set phase=preparing "target=$target" "from=$(current_release)" "base=$(git_repo rev-parse main)"
  progress 5 "Making a separate copy to update"
  remove_stage
  git_repo worktree add --quiet -B "$BRANCH" "$STAGE" main >> "$LOG" 2>&1 || fail "Couldn't make a copy of the code to update."
  progress 15 "Adding your g3code changes on top of $target"
  if ! git_stage rebase --quiet "$target" >> "$LOG" 2>&1; then
    needs_help "Some of your g3code changes clash with $target." \
      "Files that clash: $(git_stage diff --name-only --diff-filter=U | tr '\n' ' ')"
  fi
  verify_stage
}

cmd_resume() {
  local target
  target=$(status_get target)
  [ -n "$target" ] && [ -d "$STAGE" ] || fail "There's no update in progress to continue. Click Update to start again."
  KEEP=1 status_set phase=preparing
  progress 20 "Checking the helper thread's fixes"
  if rebase_in_progress; then
    needs_help "The helper thread hasn't finished combining your changes with $target yet." \
      "Files that still clash: $(git_stage diff --name-only --diff-filter=U | tr '\n' ' ')"
  fi
  if [ -n "$(git_stage status --porcelain --untracked-files=no)" ]; then
    needs_help "The update copy has changes that aren't committed yet." "$(git_stage status --short | head -20)"
  fi
  git_stage merge-base --is-ancestor "$target" HEAD || needs_help "The update copy isn't based on $target." ""
  verify_stage
}

# Refuses to install without changing anything, so the prepared update stays ready to retry.
refuse_install() { echo "::error $1"; exit 1; }

cmd_install() {
  local commit base target
  commit=$(status_get commit); base=$(status_get base); target=$(status_get target)
  if [ -z "${G3CODE_UPDATE_DETACHED:-}" ]; then
    # A second Restart click while installing is a no-op, not a failure.
    case "$(status_get phase)" in installing | installed) exit 0 ;; esac
    [ "$(status_get phase)" = ready ] || refuse_install "The update isn't ready yet."
    [ "$(git_repo symbolic-ref --short HEAD 2>/dev/null)" = main ] || refuse_install "$REPO isn't on main, so the update wasn't installed."
    [ -z "$(git_repo status --porcelain --untracked-files=no)" ] || refuse_install "$REPO has uncommitted changes, so the update wasn't installed. Commit or stash them, then try again."
    [ "$(git_repo rev-parse main)" = "$base" ] || refuse_install "main changed after the update was prepared. Cancel it and update again."
    KEEP=1 status_set phase=installing
    # Quitting g3code ends its child processes, so carry on from a process of our own, running a
    # copy of this script: installing replaces this file, and bash reads scripts as it goes.
    cp -f "$0" "$STATE_DIR/install.sh"
    G3CODE_UPDATE_DETACHED=1 nohup /bin/bash "$STATE_DIR/install.sh" install >> "$LOG" 2>&1 < /dev/null &
    exit 0
  fi

  remove_helper_project
  stop_g3code
  git_repo tag -f "$ROLLBACK_TAG" "$base" >> "$LOG" 2>&1
  if ! git_repo reset --hard --quiet "$commit" >> "$LOG" 2>&1; then
    git_repo reset --hard --quiet "$base"
    KEEP=1 status_set phase=failed "message=Switching to $target failed; g3code is unchanged."
    open "$APP"
    exit 1
  fi
  remove_stage
  local pushed=1
  git_repo push --quiet --force-with-lease origin main >> "$LOG" 2>&1 || pushed=0
  KEEP=0 status_set phase=installed "target=$target" "from=$(status_get from)" "commit=$commit" \
    "message=$([ $pushed = 1 ] || echo "Updated, but pushing main to GitHub failed. Run: git -C $REPO push --force-with-lease origin main")"
  open "$APP"
}

cmd_cancel() {
  remove_helper_project
  remove_stage
  rm -f "$STATUS"
}

cmd_rollback() {
  git_repo rev-parse --quiet --verify "refs/tags/$ROLLBACK_TAG" >/dev/null || fail "There's no earlier version to go back to."
  [ -z "$(git_repo status --porcelain --untracked-files=no)" ] || fail "$REPO has uncommitted changes. Commit or stash them first."
  stop_g3code
  git_repo reset --hard --quiet "$ROLLBACK_TAG"
  git_repo push --quiet --force-with-lease origin main >> "$LOG" 2>&1
  KEEP=0 status_set phase=rolled-back
  echo "g3code is back on $(current_release). If it can't open your threads, run g3code-restore to bring back the backup from before the update."
  open "$APP"
}

case "${1:-}" in
  status) cmd_status ;;
  check) cmd_check ;;
  prepare) cmd_prepare "${2:-}" ;;
  resume) cmd_resume ;;
  install) cmd_install ;;
  cancel) cmd_cancel ;;
  rollback) cmd_rollback ;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
