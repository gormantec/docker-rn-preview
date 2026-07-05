/**
 * file-server.mjs — Lightweight file API for per-user Expo preview.
 *
 * Replaces NAS-mounted workspace with a clean API:
 *   POST /api/files/write  { path, content }  — write a file
 *   GET  /api/files/read?path=...              — read a file
 *   GET  /api/files/list?dir=...               — list directory
 *   POST /api/build                            — npm install + expo start
 *   GET  /api/health                            — health check
 */

import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, watchFile } from 'fs';
import { join, resolve, dirname } from 'path';
import { execSync, spawn } from 'child_process';

const PORT = parseInt(process.env.FILE_API_PORT || '9091', 10);
const WORKSPACE = process.env.WORKSPACE || '/workspace/current';
const TEMPLATE = '/expo-template';
const PREVIEW_PORT = process.env.PREVIEW_PORT || '19006';

// Ensure workspace exists
if (!existsSync(WORKSPACE)) mkdirSync(WORKSPACE, { recursive: true });

// ── Security: prevent path traversal ──
function safePath(requestedPath) {
  const resolved = resolve(join(WORKSPACE, requestedPath));
  if (!resolved.startsWith(resolve(WORKSPACE))) {
    throw new Error('Path traversal denied');
  }
  return resolved;
}

// ── Copy template node_modules and create default project ──
function setupDefaultProject() {
  // Copy node_modules
  if (!existsSync(join(WORKSPACE, 'node_modules', 'expo'))) {
    console.log('[file-server] Copying template node_modules...');
    execSync(`cp -r ${TEMPLATE}/node_modules ${WORKSPACE}/node_modules`, { stdio: 'pipe' });
  }

  // Write package.json
  const pkg = JSON.stringify({
    name: 'preview', version: '0.0.1', private: true,
    main: 'node_modules/expo/AppEntry.js',
    scripts: { start: 'expo start --web', web: 'expo start --web' },
    dependencies: { expo: '~52.0.0', react: '18.3.1', 'react-native': '0.76.7', 'react-native-web': '~0.19.13', typescript: '~5.3.3', '@types/react': '~18.3.12' },
  }, null, 2);
  writeFileSync(join(WORKSPACE, 'package.json'), pkg);

  // Write app.json
  writeFileSync(join(WORKSPACE, 'app.json'), JSON.stringify({
    expo: { name: 'Preview', slug: 'preview', version: '0.0.1', platforms: ['web'], web: { bundler: 'metro' } },
  }, null, 2));

  // Write tsconfig.json for TypeScript
  writeFileSync(join(WORKSPACE, 'tsconfig.json'), JSON.stringify({
    extends: 'expo/tsconfig.base',
    compilerOptions: { strict: true },
  }, null, 2));

  // Write default App.tsx (white screen, replaced by designer)
  writeFileSync(join(WORKSPACE, 'App.tsx'), `import React from 'react';
import { View, StyleSheet, SafeAreaView, Text } from 'react-native';

export default function App() {
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.title}>Preview Ready</Text>
        <Text style={styles.subtitle}>Build your app on the canvas to see it here.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { fontSize: 20, fontWeight: '600', color: '#16191f', marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#8d99a8', textAlign: 'center' },
});
`);

  console.log('[file-server] Default project ready.');
}

// ── Start Expo dev server ──
let expoProcess = null;
function startExpo() {
  if (expoProcess) return;
  console.log('[file-server] Starting Expo dev server...');
  expoProcess = spawn('npx', ['expo', 'start', '--web', '--port', PREVIEW_PORT], {
    cwd: WORKSPACE,
    stdio: 'inherit',
    env: { ...process.env, CI: 'true' },
  });
  expoProcess.on('exit', (code) => {
    console.log(`[file-server] Expo exited with code ${code}, restarting in 3s...`);
    expoProcess = null;
    setTimeout(startExpo, 3000);
  });
}

// ── Request parsing ──
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── Server ──
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method.toUpperCase();

  try {
    // Health
    if (method === 'GET' && url.pathname === '/api/health') {
      return json(res, { ok: true, workspace: WORKSPACE });
    }

    // List directory
    if (method === 'GET' && url.pathname === '/api/files/list') {
      const dir = url.searchParams.get('dir') || '.';
      const fullPath = safePath(dir);
      if (!existsSync(fullPath)) return json(res, { error: 'Not found' }, 404);
      const entries = readdirSync(fullPath).map(name => {
        const full = join(fullPath, name);
        const stat = statSync(full);
        return { name, type: stat.isDirectory() ? 'dir' : 'file', size: stat.size };
      });
      return json(res, { entries });
    }

    // Read file
    if (method === 'GET' && url.pathname === '/api/files/read') {
      const filePath = url.searchParams.get('path');
      if (!filePath) return json(res, { error: 'path required' }, 400);
      const fullPath = safePath(filePath);
      if (!existsSync(fullPath)) return json(res, { error: 'Not found' }, 404);
      const content = readFileSync(fullPath, 'utf-8');
      return json(res, { content, path: filePath });
    }

    // Write file
    if (method === 'POST' && url.pathname === '/api/files/write') {
      const body = await parseBody(req);
      const { path: filePath, content } = body;
      if (!filePath || content === undefined) return json(res, { error: 'path and content required' }, 400);
      const fullPath = safePath(filePath);
      const dir = dirname(fullPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, content);
      return json(res, { ok: true, path: filePath });
    }

    // Create directory
    if (method === 'POST' && url.pathname === '/api/files/mkdir') {
      const body = await parseBody(req);
      const { path: dirPath } = body;
      if (!dirPath) return json(res, { error: 'path required' }, 400);
      const fullPath = safePath(dirPath);
      if (!existsSync(fullPath)) mkdirSync(fullPath, { recursive: true });
      return json(res, { ok: true, path: dirPath });
    }

    // Delete file
    if (method === 'DELETE' && url.pathname === '/api/files/delete') {
      const filePath = url.searchParams.get('path');
      if (!filePath) return json(res, { error: 'path required' }, 400);
      const fullPath = safePath(filePath);
      if (!existsSync(fullPath)) return json(res, { error: 'Not found' }, 404);
      unlinkSync(fullPath);
      return json(res, { ok: true });
    }

    // Build — npm install + restart Expo
    if (method === 'POST' && url.pathname === '/api/build') {
      console.log('[file-server] Build triggered — running npm install...');
      try {
        execSync('npm install --legacy-peer-deps', { cwd: WORKSPACE, stdio: 'pipe' });
        console.log('[file-server] npm install complete. Restarting Expo...');
      } catch (err) {
        console.error('[file-server] npm install failed:', err.message);
      }
      if (expoProcess) { expoProcess.kill(); expoProcess = null; }
      setTimeout(startExpo, 2000);
      return json(res, { ok: true, message: 'npm install + Expo restart triggered' });
    }

    // Execute a shell script in commands/ directory
    if (method === 'POST' && url.pathname === '/api/exec') {
      const body = await parseBody(req);
      const { script } = body;
      if (!script) return json(res, { error: 'script filename required' }, 400);
      const scriptPath = safePath(`commands/${script}`);
      if (!existsSync(scriptPath)) return json(res, { error: 'Script not found' }, 404);
      console.log(`[file-server] Executing: ${script}`);
      try {
        const output = execSync(`bash ${scriptPath}`, { cwd: WORKSPACE, stdio: 'pipe', timeout: 30000 });
        return json(res, { ok: true, output: output.toString() });
      } catch (err) {
        return json(res, { ok: false, output: err.stdout?.toString() || '', error: err.stderr?.toString() || err.message });
      }
    }

    // Get npm install output / logs
    if (method === 'GET' && url.pathname === '/api/logs') {
      const logPath = join(dirname(WORKSPACE), 'logs', 'preview.log');
      if (existsSync(logPath)) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(readFileSync(logPath, 'utf-8'));
      }
      return json(res, { logs: '' });
    }

    json(res, { error: 'Not found' }, 404);
  } catch (err) {
    console.error('[file-server] Error:', err.message);
    json(res, { error: err.message }, 500);
  }
});

// ── Watch package.json for dependency changes ──
let npmInstallRunning = false;
function watchPackageJson() {
  const pkgPath = join(WORKSPACE, 'package.json');
  watchFile(pkgPath, async (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    if (npmInstallRunning) return;
    npmInstallRunning = true;
    console.log('[file-server] package.json changed — running npm install...');
    try {
      execSync('npm install --legacy-peer-deps', { cwd: WORKSPACE, stdio: 'pipe' });
      console.log('[file-server] npm install complete. Restarting Expo...');
      // Restart Expo so Metro picks up any new modules
      if (expoProcess) { expoProcess.kill(); expoProcess = null; }
      setTimeout(startExpo, 2000);
    } catch (err) {
      console.error('[file-server] npm install failed:', err.message);
    } finally {
      npmInstallRunning = false;
    }
  });
  console.log('[file-server] Watching package.json for changes');
}

// ── Start ──
setupDefaultProject();
watchPackageJson();
startExpo();
server.listen(PORT, () => {
  console.log(`[file-server] File API listening on port ${PORT}`);
  console.log(`[file-server] Workspace: ${WORKSPACE}`);
});
