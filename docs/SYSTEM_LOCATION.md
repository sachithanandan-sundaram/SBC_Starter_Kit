# System Location & Overview

- Repository root: /home/hrithik/Documents/starterkit/Starter-Kit-Development
- Key components in this repository:
  - `backend/` — Python backend, contains FastAPI app, Dockerfile, requirements, model artifacts.
  - `frontend/` — Frontend web app (Vite + React/TS), contains source under `src/` and Dockerfile.
  - `data/` — Persistent data for events, HLS, models, recordings, uploads.
  - `docker-compose.yml` — Orchestrates services for local development.

## Quick start (Docker)

From the repository root run:

```bash
docker compose up --build
```

This will build and start the backend and frontend services as defined in `docker-compose.yml`.

## Notes about environment files

- Per project instructions, environment files (`.env`, `env.*`, etc.) are NOT added to `.gitignore` here. Handle them carefully: secrets should be stored securely and not committed to public repositories unless intentionally managed.

## Helpful paths

- Backend app entry: backend/app/main.py
- Frontend entry: frontend/src/main.tsx
- Example model files: backend/yolo11n.pt and data/models/

If you want this doc adapted into the main `README.md` or expanded with run/debug steps, tell me where you'd like it placed.
