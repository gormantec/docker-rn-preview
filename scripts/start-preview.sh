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

set -e

USER_HASH=${PREVIEW_USER_HASH:-default}
WORKSPACE=/workspace/$USER_HASH/current
LOGDIR=/workspace/$USER_HASH/logs
CMDDIR=/workspace/$USER_HASH/commands
CMDOUTDIR=/workspace/$USER_HASH/commands/output
TEMPLATE=/expo-template
PORT=${PORT:-19006}

echo "[rn-preview] Starting Expo preview on port $PORT"
echo "[rn-preview] User hash: $USER_HASH"
echo "[rn-preview] Workspace: $WORKSPACE"

# Ensure directories exist
mkdir -p "$WORKSPACE" "$LOGDIR" "$CMDDIR" "$CMDOUTDIR"

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
