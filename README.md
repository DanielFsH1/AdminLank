# AdminLank

AdminLank is a Firebase-backed admin dashboard built with React/Vite and Python Cloud Functions.

This public repository intentionally contains only source code and public templates. Runtime data, credentials, exports, local agent configuration, Firebase auth exports, and operational backups must stay outside Git.

## Local Setup

1. Copy `.env.example` to `.env.local`.
2. Fill Firebase web config and Cloud Functions URL in `.env.local`.
3. Install and verify the dashboard:

```bash
cd dashboard
npm install
npm run lint
npm run build
npm test
```

4. Install and verify Cloud Functions:

```bash
cd functions
python3 -m venv venv
venv/bin/pip install -r requirements.txt
venv/bin/python -m pytest
```

## Private Files

Do not commit:

- `.env.local`
- `.secrets/`
- Firebase auth exports
- service account JSON files
- operational `data/` exports
- local MCP, agent, logs, cache, or backup files

If a local-only file is required for operations, keep it ignored or outside the repository.
