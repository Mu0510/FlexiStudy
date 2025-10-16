# Gemini Rescue Chat

This lightweight Next.js interface exposes just the chat surface so you can keep talking to Gemini even if the main UI is down.

## Runtime behaviour

Run the shared wrapper from `webnew/` and point it at the rescue server module:

```bash
npm run dev:rescue
```

This boots the slim chat surface on port **3001** (configurable) while reusing the same Gemini CLI orchestration logic as the main UI. Production-style runs use the analogous `npm run start:rescue` command.

From this directory you can forward to those scripts with `npm run dev:wrapper` or `npm run start:wrapper`.

### Configuration

These environment variables shape how the wrapper hosts the rescue UI:

| Variable | Description |
| --- | --- |
| `RESCUE_APP_PORT` | Port for the rescue UI (defaults to `3001`). |
| `RESCUE_APP_HOST` | Host/interface to bind (defaults to the main server host). |
| `RESCUE_APP_DIR` | Alternative Next.js directory to mount (defaults to this folder). |

### Developing the rescue UI in isolation

You can still run this project as a standalone Next.js app for UI tweaks:

```bash
npm install
NEXT_PUBLIC_CHAT_SERVER_ORIGIN="http://localhost:3000" npm run dev
```

Point `NEXT_PUBLIC_CHAT_SERVER_ORIGIN` (or `NEXT_PUBLIC_CHAT_SERVER_HOST` / `NEXT_PUBLIC_CHAT_SERVER_PORT`) at a running Gemini wrapper so the chat panel can connect to the live WebSocket API.

For a wrapper-driven production-style run use:

```bash
npm run build
NODE_ENV=production npm run start:wrapper
```
