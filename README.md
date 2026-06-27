# React Native Preview Container

Per-user Expo live preview. Started as a Docker Swarm service by the React Native Designer.

## How It Works

1. Designer detects a new user → creates Swarm service `rn-pv-<userIdHash>` with this image
2. Container boots → writes placeholder App.tsx → starts Expo
3. Designer writes canvas changes to shared NAS volume at `/workspace/`
4. Expo's file watcher detects changes → hot-reloads in <500ms
5. User idle 20min → sweeper removes service

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Designer container                                   │
│  Writes to NAS: /mnt/nas/preview/<userId>/            │
│       │                                               │
│       ▼ (shared NAS mount)                            │
│  ┌──────────────────────────────────────────────┐    │
│  │  Preview container (this image)               │    │
│  │  /workspace → NAS /mnt/nas/preview/<userId>/  │    │
│  │  Expo watches /workspace/App.tsx              │    │
│  │  Hot-reloads on any file change               │    │
│  └──────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
```

## Port

- **19006** — Expo web dev server

## Build

```bash
npm run build:image-force
```
