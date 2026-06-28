#!/bin/bash
# start-preview.sh — Boot script for per-user Expo preview container
#
# Mounted volume: /workspace (NAS per-user dir, shared with designer container)
# The designer writes App.tsx, screens/, etc. to /workspace/{PREVIEW_USER_HASH}
# Expo watches these files and hot-reloads on change

set -e

USER_HASH=${PREVIEW_USER_HASH:-default}
WORKSPACE=/workspace/$USER_HASH/current
TEMPLATE=/expo-template
PORT=${PORT:-19006}

echo "[rn-preview] Starting Expo preview on port $PORT"
echo "[rn-preview] User hash: $USER_HASH"
echo "[rn-preview] Workspace: $WORKSPACE"

# Ensure workspace exists
mkdir -p "$WORKSPACE"

# Copy template deps if workspace doesn't have node_modules yet
if [ ! -d "$WORKSPACE/node_modules" ]; then
  echo "[rn-preview] First boot: copying template deps..."
  cp "$TEMPLATE/package.json" "$WORKSPACE/package.json"
  cp -r "$TEMPLATE/node_modules" "$WORKSPACE/node_modules"
fi

# Write placeholder app if no App.tsx exists
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

echo "[rn-preview] Starting Expo dev server..."
cd "$WORKSPACE"

# Start Expo with file watcher — hot-reloads on any file change
exec npx expo start --web --non-interactive --host lan --port "$PORT"
