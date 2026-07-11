/**
 * file-server.mjs — Lightweight file API for per-user Expo preview.
 *
 * Projects are created via npx create-expo-app@latest for a valid Expo base.
 * The designer pushes code changes into the active project via the file API.
 *
 * Endpoints:
 *   GET  /api/health                              — health + current project
 *   GET  /api/projects/current                     — { project, path }
 *   POST /api/projects/switch  { name }            — create/switch project, restart Expo
 *   POST /api/files/write  { path, content }       — write file (relative to project)
 *   GET  /api/files/read?path=...                  — read file
 *   GET  /api/files/list?dir=...                   — list directory
 *   POST /api/files/mkdir  { path }                — create directory
 *   DELETE /api/files/delete?path=...              — delete file
 *   POST /api/build                                — npm install + restart Expo
 *   POST /api/exec  { script }                     — execute shell script
 *   GET  /api/logs                                  — preview logs
 */

import { createServer } from 'http';
import http from 'http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, watchFile, cpSync, copyFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { execSync, spawn } from 'child_process';

const PORT = parseInt(process.env.FILE_API_PORT || '9091', 10);
const WORKSPACE_BASE = process.env.WORKSPACE_BASE || '/workspace';
const TEMPLATE = '/workspace/my-project';  // Pre-built default from Dockerfile
const PREVIEW_PORT = parseInt(process.env.PREVIEW_PORT || '19006', 10);
const EXPO_INTERNAL_PORT = 19007;
const EXPO_INTERACTIVE_WRAPPER = String(process.env.EXPO_INTERACTIVE_WRAPPER || '1') !== '0';

let currentProject = 'my-project';
let WORKSPACE = join(WORKSPACE_BASE, currentProject);
let fileVersion = 0;  // Increments on every file write — used for cache-busting

// Ensure base exists
if (!existsSync(WORKSPACE_BASE)) mkdirSync(WORKSPACE_BASE, { recursive: true });

// ── Security: prevent path traversal ──
function safePath(requestedPath) {
  const resolved = resolve(join(WORKSPACE, requestedPath));
  if (!resolved.startsWith(resolve(WORKSPACE))) {
    throw new Error('Path traversal denied');
  }
  return resolved;
}

// ── Create project: copy from pre-built template if needed ──
function createProject(name) {
  const projectPath = join(WORKSPACE_BASE, name);

  // Already has node_modules? Reuse.
  if (existsSync(join(projectPath, 'node_modules', 'expo'))) {
    console.log(`[file-server] Project "${name}" ready (existing node_modules).`);
    return projectPath;
  }

  console.log(`[file-server] Setting up project "${name}"...`);
  if (!existsSync(projectPath)) mkdirSync(projectPath, { recursive: true });

  // Copy node_modules from pre-built default project (fast, local fs)
  if (existsSync(join(TEMPLATE, 'node_modules', 'expo')) && !existsSync(join(projectPath, 'node_modules'))) {
    try {
      cpSync(join(TEMPLATE, 'node_modules'), join(projectPath, 'node_modules'), { recursive: true });
      console.log(`[file-server] Copied node_modules from template.`);
    } catch (err) {
      console.error(`[file-server] node_modules copy failed: ${err.message}`);
    }
  }

  // Copy package.json from template if missing (Expo requires it at the project root)
  if (!existsSync(join(projectPath, 'package.json')) && existsSync(join(TEMPLATE, 'package.json'))) {
    try {
      copyFileSync(join(TEMPLATE, 'package.json'), join(projectPath, 'package.json'));
      console.log('[file-server] Copied package.json from template.');
    } catch (err) {
      console.error(`[file-server] package.json copy failed: ${err.message}`);
    }
  }

  // Copy package.json from template if missing (needed for Expo to start)
  if (!existsSync(join(projectPath, 'package.json')) && existsSync(join(TEMPLATE, 'package.json'))) {
    try {
      copyFileSync(join(TEMPLATE, 'package.json'), join(projectPath, 'package.json'));
      console.log(`[file-server] Copied package.json from template.`);
    } catch (err) {
      console.error(`[file-server] package.json copy failed: ${err.message}`);
    }
  }

  // Write project skeleton files (app.json, tsconfig.json, App.tsx) if missing
  // NOTE: Do NOT write package.json — the template already has a valid one with Expo entry point
  if (!existsSync(join(projectPath, 'app.json'))) {
    writeFileSync(join(projectPath, 'app.json'), JSON.stringify({
      expo: { name, slug: name, version: '0.0.1', platforms: ['web'], web: { bundler: 'metro' } },
    }, null, 2));
  }
  if (!existsSync(join(projectPath, 'tsconfig.json'))) {
    writeFileSync(join(projectPath, 'tsconfig.json'), JSON.stringify({
      extends: 'expo/tsconfig.base', compilerOptions: { strict: true },
    }, null, 2));
  }
  if (!existsSync(join(projectPath, 'App.tsx'))) {
    writeFileSync(join(projectPath, 'App.tsx'), `import React from 'react';
import { View, Text, SafeAreaView, StyleSheet } from 'react-native';
export default function App() {
  return <SafeAreaView style={s.container}><View style={s.content}><Text style={s.title}>${name}</Text><Text style={s.sub}>Preview Ready</Text></View></SafeAreaView>;
}
const s = StyleSheet.create({
  container: { flex:1, backgroundColor:'#fff' },
  content: { flex:1, alignItems:'center', justifyContent:'center', padding:24 },
  title: { fontSize:20, fontWeight:'600', color:'#16191f', marginBottom:8 },
  sub: { fontSize:14, color:'#8d99a8', textAlign:'center' },
});`);
  }

  console.log(`[file-server] Project "${name}" ready.`);
  return projectPath;
}

// ── Switch to a different project ──
function switchProject(name) {
  const safeName = (name || 'my-project')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'my-project';

  const projectPath = createProject(safeName);

  // Only restart Expo if the project actually changed
  const changed = (safeName !== currentProject);
  currentProject = safeName;
  WORKSPACE = projectPath;
  console.log(`[file-server] Active project: "${currentProject}"${changed ? ' (changed)' : ' (unchanged)'}`);

  if (changed) {
    // Kill old Expo and restart with new project dir
    if (expoProcess) {
      killExpoProcessTree(expoProcess);
      expoProcess = null;
    }
    // Wait for port to free, then restart
    setTimeout(startExpo, 4000);
    // Re-watch package.json on new project
    try { watchFile(join(WORKSPACE, 'package.json'), watchPkgHandler); } catch {}
  }
}

// ── Start Expo dev server ──
let expoProcess = null;
let expoStarting = false;
let expoRetries = 0;

function sendExpoInput(input) {
  if (!input) return false;
  if (!expoProcess?.stdin?.writable) return false;
  try {
    expoProcess.stdin.write(String(input) + '\n');
    return true;
  } catch {
    return false;
  }
}

function triggerExpoReload() {
  return sendExpoInput('r');
}

function killExpoProcessTree(proc) {
  if (!proc || !proc.pid) return;
  try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
  try { process.kill(proc.pid, 'SIGTERM'); } catch {}
  setTimeout(() => {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
    try { process.kill(proc.pid, 'SIGKILL'); } catch {}
  }, 2500);
}

function freeExpoPorts() {
  try {
    execSync(`sh -lc "fuser -k ${EXPO_INTERNAL_PORT}/tcp >/dev/null 2>&1 || true"`, { stdio: 'pipe' });
  } catch {
    // best-effort
  }
}

function startExpo() {
  if (expoStarting) {
    console.log('[file-server] Expo start already in progress, skipping.');
    return;
  }
  expoStarting = true;

  // Kill existing process — use SIGTERM first, then SIGKILL after a short wait
  if (expoProcess) {
    const old = expoProcess;
    expoProcess = null;
    killExpoProcessTree(old);
  }

  freeExpoPorts();

  console.log(`[file-server] Starting Expo in ${WORKSPACE}... (interactive wrapper: ${EXPO_INTERACTIVE_WRAPPER ? 'on' : 'off'})`);
  const startedAt = Date.now();
  let sawPortPrompt = false;
  // Keep stdin writable for live commands (r/d/etc). Wrapper can run under pseudo-tty via `script`.
  if (EXPO_INTERACTIVE_WRAPPER) {
    const cmd = `if command -v script >/dev/null 2>&1; then script -qec \"npx expo start --web --port ${EXPO_INTERNAL_PORT}\" /dev/null; else npx expo start --web --port ${EXPO_INTERNAL_PORT}; fi`;
    expoProcess = spawn('sh', ['-lc', cmd], {
      cwd: WORKSPACE,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Keep output deterministic; avoid color control chars in logs.
        FORCE_COLOR: '0',
      },
    });
  } else {
    expoProcess = spawn('npx', ['expo', 'start', '--web', '--port', String(EXPO_INTERNAL_PORT), '--non-interactive'], {
      cwd: WORKSPACE,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        EXPO_NO_PORT_PROMPT: '1',
        EXPO_NO_INTERACTIVE: '1',
        FORCE_COLOR: '0',
      },
    });
  }

  // Pipe stdout to console
  if (expoProcess.stdout) {
    expoProcess.stdout.on('data', (data) => {
      const line = data.toString();
      if (line.includes('Port 19007 is being used') || line.includes('Use port 19008 instead')) {
        sawPortPrompt = true;
        // In interactive mode explicitly decline alternate port, then recover with clean restart.
        if (EXPO_INTERACTIVE_WRAPPER) sendExpoInput('n');
      }
      process.stdout.write(line);
    });
  }
  // Pipe stderr to console
  if (expoProcess.stderr) {
    expoProcess.stderr.on('data', (data) => {
      const line = data.toString();
      if (line.includes('Port 19007 is being used') || line.includes('Use port 19008 instead')) {
        sawPortPrompt = true;
        if (EXPO_INTERACTIVE_WRAPPER) sendExpoInput('n');
      }
      process.stderr.write(line);
    });
  }

  expoProcess.on('exit', (code) => {
    console.log(`[file-server] Expo exited with code ${code}.`);
    expoProcess = null;
    expoStarting = false;
    const aliveMs = Date.now() - startedAt;
    const unexpectedEarlyExit = (code === 0 && aliveMs < 30000) || sawPortPrompt;
    // Retry on port conflicts or crashes (but cap retries)
    if ((code !== 0 || unexpectedEarlyExit) && expoRetries < 5) {
      expoRetries++;
      console.log(`[file-server] Expo restarting in 4s (retry ${expoRetries}/5)...`);
      setTimeout(startExpo, 4000);
    } else if (code === 0) {
      expoRetries = 0;
    } else {
      console.log(`[file-server] Expo failed after ${expoRetries} retries. Giving up.`);
      expoRetries = 0;
    }
  });

  // Mark start complete after Expo is likely up (but DON'T reset retry counter here)
  setTimeout(() => { expoStarting = false; }, 8000);
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

// Eager body buffering for async handlers — handles edge case where
// data/end events fire before the async callback attaches listeners.
function bufferBody(req) {
  return new Promise((resolve) => {
    if (req._body !== undefined) return resolve();
    // Pause the stream to prevent data loss, then resume after listeners attached
    req.pause();
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { req._body = Buffer.concat(chunks).toString(); resolve(); });
    req.on('error', () => { req._body = ''; resolve(); });
    req.resume();
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── Server ──
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method.toUpperCase();

  // Sync body collection — avoids event race with pause/resume on ended streams
  let rawBody = '';
  const bodyReady = method === 'GET' || method === 'HEAD' || method === 'DELETE'
    ? Promise.resolve('')
    : new Promise((resolve) => {
        req.on('data', c => rawBody += c);
        req.on('end', () => resolve(rawBody));
        req.on('error', () => resolve(''));
      });

  bodyReady.then(() => {
    let body = {};
    try { if (rawBody) body = JSON.parse(rawBody); } catch {}
    req._body = rawBody;

    try {
    // ── Health ──
    if (method === 'GET' && url.pathname === '/api/health') {
      return json(res, { ok: true, project: currentProject, workspace: WORKSPACE, version: fileVersion });
    }

    // ── Project management ──
    if (method === 'GET' && url.pathname === '/api/projects/current') {
      return json(res, { project: currentProject, path: WORKSPACE });
    }

    if (method === 'POST' && url.pathname === '/api/projects/switch') {
      const { name } = body;
      if (!name) return json(res, { error: 'name required' }, 400);
      // Respond immediately; heavy work (npm/node_modules copy) happens async
      const safeName = (name || 'my-project')
        .replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'my-project';
      json(res, { ok: true, project: safeName, switching: safeName !== currentProject });
      // Do the actual switch in background
      setImmediate(() => switchProject(safeName));
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
      const { path: filePath, content, encoding } = body;
      if (!filePath || content === undefined) return json(res, { error: 'path and content required' }, 400);
      const fullPath = safePath(filePath);
      const dir = dirname(fullPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      // Support base64-encoded content for binary/special-char safety
      let decoded = content;
      if (encoding === 'base64') {
        try {
          decoded = Buffer.from(content, 'base64').toString('utf-8');
        } catch (err) {
          return json(res, { error: `base64 decode failed: ${err.message}` }, 400);
        }
      }
      writeFileSync(fullPath, decoded);
      fileVersion++;

      // Auto-reload Metro after file writes (send "r" to Expo stdin)
      triggerExpoReload();

      return json(res, { ok: true, path: filePath, bytes: decoded.length });
    }

    // ── Batch file write (multiple files in one request, one reload) ──
    if (method === 'POST' && url.pathname === '/api/files/write-batch') {
      const { files } = body;
      if (!files || !Array.isArray(files)) return json(res, { error: 'files array required' }, 400);

      const results = [];
      for (const f of files) {
        const { path: fp, content, encoding } = f;
        if (!fp || content === undefined) {
          results.push({ path: fp, error: 'path and content required' });
          continue;
        }
        try {
          const fullPath = safePath(fp);
          const dir = dirname(fullPath);
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          let decoded = content;
          if (encoding === 'base64') {
            decoded = Buffer.from(content, 'base64').toString('utf-8');
          }
          writeFileSync(fullPath, decoded);
          results.push({ path: fp, ok: true, bytes: decoded.length });
        } catch (err) {
          results.push({ path: fp, error: err.message });
        }
      }

      // One reload for the batch
      triggerExpoReload();

      return json(res, { ok: true, results });
    }

    // ── Expo stdin — send commands to Metro (r=reload, d=dev menu, etc.) ──
    if (method === 'POST' && url.pathname === '/api/expo/stdin') {
      const { input } = body;
      if (!input) return json(res, { error: 'input required (e.g., "r" for reload, "d" for dev menu)' }, 400);
      if (!expoProcess?.stdin?.writable) {
        return json(res, { error: 'Expo not running or stdin not available' }, 503);
      }
      const ok = sendExpoInput(input);
      if (!ok) {
        return json(res, { error: 'Failed to send input to Expo process' }, 500);
      }
      console.log(`[file-server] Sent to Expo stdin: "${input}"`);
      return json(res, { ok: true, sent: input });
    }

    // Create directory
    if (method === 'POST' && url.pathname === '/api/files/mkdir') {
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
      if (expoProcess) {
        killExpoProcessTree(expoProcess);
        expoProcess = null;
      }
      setTimeout(startExpo, 2000);
      return json(res, { ok: true, message: 'npm install + Expo restart triggered' });
    }

    // Execute a shell script in commands/ directory
    if (method === 'POST' && url.pathname === '/api/exec') {
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

    if (!res.writableEnded) json(res, { error: 'Not found' }, 404);
  } catch (err) {
    console.error('[file-server] Error:', err.message);
    if (!res.writableEnded) json(res, { error: err.message }, 500);
  }
  });  // closes bodyReady.then()
});    // closes createServer()

// ── Watch package.json for dependency changes ──
let npmInstallRunning = false;
async function watchPkgHandler(curr, prev) {
  if (curr.mtimeMs === prev.mtimeMs) return;
  if (npmInstallRunning) return;
  npmInstallRunning = true;
  console.log('[file-server] package.json changed — running npm install...');
  try {
    execSync('npm install --legacy-peer-deps', { cwd: WORKSPACE, stdio: 'pipe' });
    console.log('[file-server] npm install complete. Restarting Expo...');
    if (expoProcess) {
      killExpoProcessTree(expoProcess);
      expoProcess = null;
    }
    setTimeout(startExpo, 2000);
  } catch (err) {
    console.error('[file-server] npm install failed:', err.message);
  } finally {
    npmInstallRunning = false;
  }
}

function watchPackageJson() {
  watchFile(join(WORKSPACE, 'package.json'), watchPkgHandler);
  console.log('[file-server] Watching package.json for changes');
}

// ── Startup ──
console.log(`[file-server] Creating default project "my-project"...`);
createProject('my-project');
console.log(`[file-server] Workspace: ${WORKSPACE}`);
watchPackageJson();
startExpo();

server.listen(PORT, () => {
  console.log(`[file-server] File API listening on port ${PORT}`);
});

// ── Reverse proxy on port 19006 → Expo on 19007 (rewrites absolute asset paths) ──
// Also handles /api/* routes directly for ELB accessibility
const userHash = process.env.PREVIEW_USER_HASH || 'default';
const basePath = `/webapp/rn-pv-${userHash}`;

// Simplified API handler — takes pre-buffered body
function handleApiInProxySync(req, res, rawBody) {
  const url = new URL(req.url, `http://localhost:${PREVIEW_PORT}`);
  const method = req.method.toUpperCase();
  let body = {};
  try { body = JSON.parse(rawBody || '{}'); } catch {}

  // Health
  if (method === 'GET' && url.pathname === '/api/health') { json(res, { ok: true, project: currentProject, workspace: WORKSPACE, version: fileVersion }); return true; }
  // Projects
  if (method === 'GET' && url.pathname === '/api/projects/current') { json(res, { project: currentProject, path: WORKSPACE }); return true; }
  if (method === 'POST' && url.pathname === '/api/projects/switch') {
    const name = body.name;
    if (!name) { json(res, { error: 'name required' }, 400); return true; }
    const safeName = (name || 'my-project').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'my-project';
    json(res, { ok: true, project: safeName, switching: safeName !== currentProject });
    setImmediate(() => switchProject(safeName));
    return true;
  }
  // File read
  if (method === 'GET' && url.pathname === '/api/files/read') {
    const fp = url.searchParams.get('path'); if (!fp) { json(res, { error: 'path required' }, 400); return true; }
    const full = safePath(fp); if (!existsSync(full)) { json(res, { error: 'Not found' }, 404); return true; }
    json(res, { content: readFileSync(full, 'utf-8'), path: fp }); return true;
  }
  // File list
  if (method === 'GET' && url.pathname === '/api/files/list') {
    const dir = url.searchParams.get('dir') || '.'; const full = safePath(dir);
    if (!existsSync(full)) { json(res, { error: 'Not found' }, 404); return true; }
    const entries = readdirSync(full).map(n => { const s = statSync(join(full, n)); return { name: n, type: s.isDirectory() ? 'dir' : 'file', size: s.size }; });
    json(res, { entries }); return true;
  }
  // File write
  if (method === 'POST' && url.pathname === '/api/files/write') {
    const { path: fp, content, encoding } = body;
    if (!fp || content === undefined) { json(res, { error: 'path and content required' }, 400); return true; }
    const full = safePath(fp); const d = dirname(full); if (!existsSync(d)) mkdirSync(d, { recursive: true });
    let decoded = content;
    if (encoding === 'base64') { try { decoded = Buffer.from(content, 'base64').toString('utf-8'); } catch (e) { json(res, { error: 'base64 decode failed' }, 400); return true; } }
    writeFileSync(full, decoded);
    fileVersion++;
    triggerExpoReload();
    json(res, { ok: true, path: fp, bytes: decoded.length }); return true;
  }
  // Batch write
  if (method === 'POST' && url.pathname === '/api/files/write-batch') {
    const { files } = body;
    if (!files || !Array.isArray(files)) { json(res, { error: 'files array required' }, 400); return true; }
    const results = [];
    for (const f of files) {
      try { const full = safePath(f.path); const d = dirname(full); if (!existsSync(d)) mkdirSync(d, { recursive: true }); let dec = f.content; if (f.encoding === 'base64') dec = Buffer.from(f.content, 'base64').toString('utf-8'); writeFileSync(full, dec); results.push({ path: f.path, ok: true, bytes: dec.length }); }
      catch (e) { results.push({ path: f.path, error: e.message }); }
    }
    triggerExpoReload();
    fileVersion++;
    json(res, { ok: true, results }); return true;
  }
  // Mkdir
  if (method === 'POST' && url.pathname === '/api/files/mkdir') {
    const { path: dp } = body;
    if (!dp) { json(res, { error: 'path required' }, 400); return true; }
    const full = safePath(dp); if (!existsSync(full)) mkdirSync(full, { recursive: true });
    json(res, { ok: true, path: dp }); return true;
  }
  // Expo stdin
  if (method === 'POST' && url.pathname === '/api/expo/stdin') {
    const { input } = body;
    if (!input) { json(res, { error: 'input required' }, 400); return true; }
    if (!expoProcess?.stdin?.writable) { json(res, { error: 'Expo not running' }, 503); return true; }
    if (!sendExpoInput(input)) { json(res, { error: 'Failed to send input to Expo process' }, 500); return true; }
    json(res, { ok: true, sent: input }); return true;
  }
  return false;
}

const proxyServer = createServer((req, res) => {
  // WebSocket upgrade — handled by 'upgrade' event below, don't interfere
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
    return; // Let the upgrade event handle it
  }

  // Route /api/* — collect body synchronously, then handle
  if (req.url.startsWith('/api/')) {
    let rawBody = '';
    req.on('data', c => rawBody += c);
    req.on('end', () => {
      handleApiInProxySync(req, res, rawBody);
    });
    return;
  }

  const url = new URL(req.url, `http://localhost:${PREVIEW_PORT}`);
  // Strip basePath before forwarding to Metro (it expects bare paths)
  let metroPath = req.url;
  if (metroPath.startsWith(basePath)) metroPath = metroPath.slice(basePath.length) || '/';
  const proxyReq = http.request({
    hostname: 'localhost', port: EXPO_INTERNAL_PORT,
    path: metroPath, method: req.method, headers: req.headers,
  }, (proxyRes) => {
    const ct = proxyRes.headers['content-type'] || '';
    const isHtml = ct.includes('text/html');
    const isCss = ct.includes('text/css');

    if (isHtml || isCss) {
      let body = '';
      proxyRes.on('data', (chunk) => { body += chunk.toString(); });
      proxyRes.on('end', () => {
        if (isHtml) {
          // Inject base tag + auto-reload polling script
          body = body.replace('<head>', `<head><base href="${basePath}/">
<script>
let __version = 0;
setInterval(function(){
  fetch('${basePath}/api/health').then(r=>r.json()).then(d=>{
    if(d.version && __version===0) __version=d.version;
    if(d.version && d.version!==__version){ console.log('[auto-reload] v'+__version+'→v'+d.version); location.reload(); }
  }).catch(()=>{});
}, 2000);
</script>`);
          body = body.replace(/(src|href)=["']\/((?!(?:webapp|cdn|http|\/\/))[^"']*)["']/g,
            (m, attr, path) => `${attr}="${basePath}/${path}"`);
        }
        if (isCss) {
          body = body.replace(/url\(["']?\/((?!webapp\/|cdn|http)[^"')]+)["']?\)/g,
            (m, path) => `url("${basePath}/${path}")`);
        }
        const headers = { ...proxyRes.headers };
        delete headers['content-length'];
        res.writeHead(proxyRes.statusCode, headers);
        res.end(body);
      });
    } else {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  });
  proxyReq.on('error', () => { res.writeHead(502); res.end('Expo not ready'); });
  if (req.method !== 'GET' && req.method !== 'HEAD') req.pipe(proxyReq);
  else proxyReq.end();
});
proxyServer.listen(PREVIEW_PORT, () => {
  console.log(`[file-server] Expo proxy listening on port ${PREVIEW_PORT} → ${EXPO_INTERNAL_PORT}`);
});

// ── WebSocket upgrade proxying (for Metro HMR live reload) ──
proxyServer.on('upgrade', (req, socket, head) => {
  // Strip basePath prefix — Metro expects bare paths like /hot, /ws
  let wsPath = req.url;
  if (wsPath.startsWith(basePath)) wsPath = wsPath.slice(basePath.length) || '/';
  console.log(`[file-server] WebSocket upgrade: ${req.url} → ${wsPath}`);
  const options = {
    hostname: 'localhost', port: EXPO_INTERNAL_PORT,
    path: wsPath, method: 'GET',
    headers: { ...req.headers, connection: 'Upgrade', upgrade: req.headers.upgrade },
  };
  const wsProxy = http.request(options);
  wsProxy.on('upgrade', (proxyRes, proxySocket) => {
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      `Upgrade: ${proxyRes.headers.upgrade || 'websocket'}`,
      `Connection: ${proxyRes.headers.connection || 'Upgrade'}`,
    ];
    if (proxyRes.headers['sec-websocket-accept']) {
      headers.push(`Sec-WebSocket-Accept: ${proxyRes.headers['sec-websocket-accept']}`);
    }
    socket.write(headers.join('\r\n') + '\r\n\r\n');
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });
  wsProxy.on('error', (e) => { console.error('[file-server] WS proxy error:', e.message); socket.destroy(); });
  wsProxy.end();
});
