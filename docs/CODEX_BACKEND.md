# Experimental Codex backend (phase 1)

This fork offers a selectable OpenAI Codex SDK backend while preserving the upstream Claude Agent SDK implementation. It reuses the existing JARVIS WebSocket frontend and ElevenLabs endpoints.

## Setup

Requires Node.js 20+, a working Codex CLI login and an audited local Codex configuration. The Node bridge does not automatically read .env.local.

Bash:

    npm install
    npm install @openai/codex-sdk
    codex login
    npm test
    npm run build
    JARVIS_AGENT=codex npm start

Windows PowerShell:

    npm install
    npm install @openai/codex-sdk
    codex login
    npm test
    npm run build
    $env:JARVIS_AGENT="codex"
    npm start

The current adaptation resolves @openai/codex-sdk dynamically, so it must be installed separately for now. npm install will update package.json and package-lock.json on the local machine. Do not use --writes or JARVIS_ALLOW_WRITES=1 in Codex mode.

## ElevenLabs

Voice synthesis and transcription already exist in upstream JARVIS. For the browser frontend, set VITE_USE_ELEVENLABS=1 in .env.local. Set ELEVENLABS_API_KEY in the shell running the bridge, and optionally JARVIS_VOICE_ID. Never commit credentials.

## Implemented

- One Codex thread per browser connection; history persists across turns.
- Incremental agent-message updates mapped into JARVIS speech events.
- Tool activity events and errors mapped to the existing wire protocol.
- Interruptions mapped to AbortController for barge-in.
- Built-in Codex sandbox set to read-only and approvals disabled.
- Claude remains the default: JARVIS_AGENT=claude.

## Limitations and safety

This is a first-stage adapter, not a fully working AI desktop agent. Unit tests use mock Codex event streams; live Codex authentication, browser voice functionality, ElevenLabs and reconnection behavior still require end-to-end testing.

Claude-specific in-process MCP servers are not connected in Codex mode. That includes agent-controlled display/blades, UI controls, Chrome extension, and camera tools.

The Codex SDK can inherit MCP server configuration from the user's Codex installation. Read-only sandbox restrictions DO NOT guarantee external MCP servers cannot mutate data. Audit or disable privileged MCP servers before running. Keep JARVIS bound to loopback, and do not connect production accounts yet.

The SDK currently has no system prompt parameter on ThreadOptions, so the persona is prepended to each turn as user-level context. This is not equivalent to a system instruction.

Upstream's npm run setup still checks Claude. Use the Codex setup above instead.

## Next phase

1. Safely expose selected JARVIS MCP tools to Codex, with an allowlist.
2. Add per-action approval UI and external-tool permission gates.
3. Pin the Codex SDK in package.json and regenerate package-lock.json using npm in a network-enabled environment.
4. Run full automated tests and a live smoke test before any merge.
