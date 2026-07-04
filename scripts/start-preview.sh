#!/bin/bash
# start-preview.sh — Boot script for per-user Expo preview container
#
# Mounted volume: /workspace (NAS per-user dir, shared with designer container)
# The designer writes App.tsx, screens/, etc. to /workspace/{PREVIEW_USER_HASH}/current/
# Expo watches these files and hot-reloads on change.
#
# Self-healing features:
#   1. Watches package.json → auto-runs npm install on changes
#   2. Watches commands/ dir → executes .sh scripts (for agent-driven fixes)
#   3. Writes all Expo output to logs/preview.log on NAS for agent monitoring
#   4. Crash loop detection — prevents infinite restart cycles

USER_HASH=${PREVIEW_USER_HASH:-default}
WORKSPACE=/workspace/$USER_HASH/current
LOGDIR=/workspace/$USER_HASH/logs
CMDDIR=/workspace/$USER_HASH/commands
CMDOUTDIR=/workspace/$USER_HASH/commands/output
TEMPLATE=/expo-template
PORT=${PORT:-19006}
CRASH_FILE=/workspace/$USER_HASH/.crash-state

echo "[rn-preview] Starting Expo preview on port $PORT"
echo "[rn-preview] User hash: $USER_HASH"
echo "[rn-preview] Workspace: $WORKSPACE"

# Ensure directories exist
mkdir -p "$WORKSPACE" "$LOGDIR" "$CMDDIR" "$CMDOUTDIR"

# ═══════════════════════════════════════════════════════════════
# CRASH LOOP DETECTION — prevent infinite restart cycles
# ═══════════════════════════════════════════════════════════════
CRASH_WINDOW_SEC=300   # 5 minute window
MAX_CRASHES=5           # max crashes in that window before giving up

now=$(date +%s)
crash_count=0
crash_first=0

if [ -f "$CRASH_FILE" ]; then
  read -r crash_first crash_count < "$CRASH_FILE" 2>/dev/null || true
  crash_first=${crash_first:-0}
  crash_count=${crash_count:-0}
fi

# If first crash was within the window, increment. Otherwise reset.
if [ "$crash_first" -gt 0 ] && [ $((now - crash_first)) -lt $CRASH_WINDOW_SEC ]; then
  crash_count=$((crash_count + 1))
else
  crash_first=$now
  crash_count=1
fi

echo "$crash_first $crash_count" > "$CRASH_FILE"

if [ "$crash_count" -gt "$MAX_CRASHES" ]; then
  echo "[rn-preview] ❌ CRASH LOOP DETECTED: $crash_count crashes in $(( (now - crash_first) / 60 ))min" | tee -a "$LOGDIR/preview.log"
  echo "[rn-preview] Last crash was within the past $(( (now - crash_first) / 60 )) minutes. Max allowed: $MAX_CRASHES crashes in $((CRASH_WINDOW_SEC/60)) minutes."
  echo "[rn-preview] Writing SOS to log and sleeping indefinitely so a human/AI can intervene."

  # Write SOS to log for the log monitor / AI agent to detect
  cat >> "$LOGDIR/preview.log" << SOSEOF
╔══════════════════════════════════════════════════════════════╗
║  SOS: Preview container crash loop detected!               ║
║  User: $USER_HASH                                          ║
║  Crashes: $crash_count in $(( (now - crash_first) / 60 ))min                         ║
║  Time: $(date -Iseconds)                                   ║
║  Action needed: diagnose logs/preview.log, fix root cause, ║
║  then delete $CRASH_FILE to allow restart.                 ║
╚══════════════════════════════════════════════════════════════╝
SOSEOF

  # Sleep indefinitely — Swarm will NOT restart us because we exit 0 eventually?
  # Actually exit 1 so Swarm knows we're unhealthy, but with a long delay first
  # so the log monitor has time to detect the SOS and fire the AI agent.
  sleep 120
  exit 1
fi

echo "[rn-preview] Crash count: $crash_count/$MAX_CRASHES in window (first crash: $(date -d @$crash_first -Iseconds 2>/dev/null || echo "$crash_first"))" | tee -a "$LOGDIR/preview.log"

# ── Helper: run npm install with output to log ──
run_npm_install() {
  echo "[rn-preview] $(date -Iseconds) package.json changed — running npm install..." | tee -a "$LOGDIR/preview.log"
  cd "$WORKSPACE"
  if npm install --prefer-offline --no-audit --no-fund >> "$LOGDIR/preview.log" 2>&1; then
    echo "[rn-preview] $(date -Iseconds) npm install OK" | tee -a "$LOGDIR/preview.log"
  else
    echo "[rn-preview] $(date -Iseconds) npm install FAILED (exit $?)" | tee -a "$LOGDIR/preview.log"
  fi
}

# ── Copy template deps if workspace doesn't have them yet ──
if [ ! -f "$WORKSPACE/node_modules/.bin/expo" ] || [ ! -d "$WORKSPACE/node_modules/@expo/metro-runtime" ] || [ ! -d "$WORKSPACE/node_modules/expo-asset" ]; then
  echo "[rn-preview] Copying template deps to workspace node_modules (local Docker volume — fast)..."
  rm -rf "$WORKSPACE/node_modules" "$WORKSPACE/package.json" 2>/dev/null || true
  cp "$TEMPLATE/package.json" "$WORKSPACE/package.json"
  cp -r "$TEMPLATE/node_modules" "$WORKSPACE/node_modules"
  echo "[rn-preview] node_modules ready."
fi

# ── Auto-detect TypeScript: if any .tsx files exist but typescript is missing, install it ──
if ls "$WORKSPACE"/*.tsx "$WORKSPACE"/**/*.tsx "$WORKSPACE"/**/*.ts 2>/dev/null | head -1 | grep -q .; then
  if [ ! -f "$WORKSPACE/node_modules/.bin/tsc" ] && [ ! -d "$WORKSPACE/node_modules/typescript" ]; then
    echo "[rn-preview] $(date -Iseconds) Detected .tsx/.ts files but no typescript — installing..." | tee -a "$LOGDIR/preview.log"
    cd "$WORKSPACE"
    npm install --prefer-offline --no-audit --no-fund typescript@~5.3.3 @types/react@~18.3.12 >> "$LOGDIR/preview.log" 2>&1 && \
      echo "[rn-preview] $(date -Iseconds) typescript installed OK" | tee -a "$LOGDIR/preview.log" || \
      echo "[rn-preview] $(date -Iseconds) typescript install FAILED" | tee -a "$LOGDIR/preview.log"
  fi
fi

# ── Write placeholder app if no App.tsx exists ──
if [ ! -f "$WORKSPACE/App.tsx" ]; then
  echo "[rn-preview] Writing placeholder App.tsx..."
  cat > "$WORKSPACE/App.tsx" << 'EOF'
import React from 'react';
import { View, Text, StyleSheet, SafeAreaView, ActivityIndicator } from 'react-native';

export default function App() {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <ActivityIndicator size="large" color="#0972d3" style={{ marginBottom: 16 }} />
        <Text style={styles.title}>Preview Ready</Text>
        <Text style={styles.subtitle}>Add widgets to the canvas to see them here.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fafafa' },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { fontSize: 18, fontWeight: '700', color: '#16191f', marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#8d99a8', textAlign: 'center' },
});
EOF
fi

# Ensure app.json exists
if [ ! -f "$WORKSPACE/app.json" ]; then
  cat > "$WORKSPACE/app.json" << 'JSONEOF'
{
  "expo": {
    "name": "Preview",
    "slug": "preview",
    "version": "0.0.1",
    "platforms": ["web"],
    "web": { "bundler": "metro" }
  }
}
JSONEOF
fi

# Ensure babel config
if [ ! -f "$WORKSPACE/babel.config.js" ]; then
  echo "module.exports = function(api) { api.cache(true); return { presets: ['babel-preset-expo'] }; };" > "$WORKSPACE/babel.config.js"
fi

# ═══════════════════════════════════════════════════════════════
# BACKGROUND PROCESS 1: Watch package.json → auto npm install
# Uses stat-based polling (no inotify-tools dependency)
# ═══════════════════════════════════════════════════════════════
(
  echo "[rn-preview] package.json watcher started (pid $$)"
  pkg_file="$WORKSPACE/package.json"
  last_mtime=$(stat -c %Y "$pkg_file" 2>/dev/null || echo 0)
  while true; do
    sleep 3
    curr_mtime=$(stat -c %Y "$pkg_file" 2>/dev/null || echo 0)
    if [ "$curr_mtime" != "$last_mtime" ] && [ "$curr_mtime" != "0" ]; then
      sleep 1  # debounce — wait for write to finish
      run_npm_install
      last_mtime=$curr_mtime
    fi
  done
) &
WATCHER_PID=$!

# ═══════════════════════════════════════════════════════════════
# BACKGROUND PROCESS 2: Watch commands/ dir → exec .sh scripts
# Uses polling (no inotify-tools dependency)
# ═══════════════════════════════════════════════════════════════
(
  echo "[rn-preview] command executor started (pid $$)"
  while true; do
    sleep 2
    for script in "$CMDDIR"/*.sh; do
      [ -f "$script" ] || continue
      script_name=$(basename "$script")
      OUTFILE="$CMDOUTDIR/${script_name%.sh}.out"
      echo "[rn-preview] $(date -Iseconds) Executing: $script_name" | tee -a "$LOGDIR/preview.log"
      chmod +x "$script"
      cd "$WORKSPACE"
      if bash "$script" > "$OUTFILE" 2>&1; then
        echo "[rn-preview] $(date -Iseconds) $script_name OK (exit 0)" | tee -a "$LOGDIR/preview.log"
        echo "EXIT_CODE=0" >> "$OUTFILE"
      else
        rc=$?
        echo "[rn-preview] $(date -Iseconds) $script_name FAILED (exit $rc)" | tee -a "$LOGDIR/preview.log"
        echo "EXIT_CODE=$rc" >> "$OUTFILE"
      fi
      # Move script to archive so it's not re-executed
      mkdir -p "$CMDDIR/archive"
      mv "$script" "$CMDDIR/archive/${script_name}.$(date +%s).done"
    done
  done
) &
CMDEXEC_PID=$!

# ═══════════════════════════════════════════════════════════════
# MAIN PROCESS: Expo dev server → logs to NAS + Docker stdout
# ═══════════════════════════════════════════════════════════════
echo "[rn-preview] Starting Expo dev server (logs → $LOGDIR/preview.log)..."
cd "$WORKSPACE"

# CI=1 replaces the deprecated --non-interactive flag in Expo 52+
export CI=1

# Run Expo, tee output to both Docker stdout and NAS log file
exec npx expo start --web --host lan --port "$PORT" 2>&1 | tee -a "$LOGDIR/preview.log"
