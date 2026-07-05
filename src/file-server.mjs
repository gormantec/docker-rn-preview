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
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, watchFile, cpSync, copyFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { execSync, spawn } from 'child_process';

const PORT = parseInt(process.env.FILE_API_PORT || '9091', 10);
const WORKSPACE_BASE = process.env.WORKSPACE_BASE || '/workspace';
const TEMPLATE = '/workspace/my-project';  // Pre-built default project from Dockerfile
const PREVIEW_PORT = process.env.PREVIEW_PORT || '19006';

let currentProject = 'my-project';
let WORKSPACE = join(WORKSPACE_BASE, currentProject);

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
    // Restart Expo with new project
    if (expoProcess) { expoProcess.kill('SIGKILL'); expoProcess = null; }
    setTimeout(startExpo, 2000);
    // Re-watch package.json on new project
    try { watchFile(join(WORKSPACE, 'package.json'), watchPkgHandler); } catch {}
  }
}

// ── Start Expo dev server ──
let expoProcess = null;
let expoStarting = false;
function startExpo() {
  if (expoStarting) {
    console.log('[file-server] Expo start already in progress, skipping.');
    return;
  }
  expoStarting = true;

  // Kill existing process if any
  if (expoProcess) {
    try { expoProcess.kill('SIGKILL'); } catch {}
    expoProcess = null;
  }

  console.log(`[file-server] Starting Expo in ${WORKSPACE}...`);
  expoProcess = spawn('npx', ['expo', 'start', '--web', '--port', PREVIEW_PORT], {
    cwd: WORKSPACE,
    stdio: 'inherit',
    env: { ...process.env, CI: 'true' },
  });
  expoProcess.on('exit', (code) => {
    console.log(`[file-server] Expo exited with code ${code}.`);
    expoProcess = null;
    // Only auto-restart on crashes (non-zero exit), not port-conflict clean exits
    if (code !== 0 && code !== null) {
      console.log('[file-server] Expo crashed — restarting in 5s...');
      expoStarting = false;
      setTimeout(startExpo, 5000);
    } else {
      expoStarting = false;
    }
  });

  // Mark start complete after a short delay (Expo is async)
  setTimeout(() => { expoStarting = false; }, 5000);
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
    // ── Health ──
    if (method === 'GET' && url.pathname === '/api/health') {
      return json(res, { ok: true, project: currentProject, workspace: WORKSPACE });
    }

    // ── Project management ──
    if (method === 'GET' && url.pathname === '/api/projects/current') {
      return json(res, { project: currentProject, path: WORKSPACE });
    }

    if (method === 'POST' && url.pathname === '/api/projects/switch') {
      const body = await parseBody(req);
      const { name } = body;
      if (!name) return json(res, { error: 'name required' }, 400);
      const result = switchProject(name);
      return json(res, { ok: true, ...result });
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
async function watchPkgHandler(curr, prev) {
  if (curr.mtimeMs === prev.mtimeMs) return;
  if (npmInstallRunning) return;
  npmInstallRunning = true;
  console.log('[file-server] package.json changed — running npm install...');
  try {
    execSync('npm install --legacy-peer-deps', { cwd: WORKSPACE, stdio: 'pipe' });
    console.log('[file-server] npm install complete. Restarting Expo...');
    if (expoProcess) { expoProcess.kill(); expoProcess = null; }
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
