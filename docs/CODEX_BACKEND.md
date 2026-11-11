# JARVIS with Codex: experimental MCP integration

This fork supports OpenAI Codex as an alternative brain for JARVIS and retains
upstream ElevenLabs speech, the holographic HUD and the original Claude backend.

**Status:** Development branch. Live Codex, Chrome, camera and voice integration
has not yet undergone end-to-end testing. Do not merge or deploy publicly.

## 1. Install and start

Requires Node.js 20+, a working Codex CLI login, and a trusted workstation.
In the fork checkout:

    npm install
    npm install @openai/codex-sdk
    codex login
    npm test
    npm run build

On Bash:

    export JARVIS_AGENT=codex
    npm start

On Windows PowerShell:

    $env:JARVIS_AGENT="codex"
    npm start

The UI normally opens at http://localhost:5173. The bridge binds to
127.0.0.1:8787 by default. Claude remains the default without JARVIS_AGENT.
Do not run bridge:writes in Codex mode.

Until the SDK is pinned in package.json and package-lock.json, the separate
npm install @openai/codex-sdk step is required.

## 2. Capabilities and opt-in

The Codex SDK launches an MCP stdio server for each JARVIS WebSocket session.
Its 256-bit token is sent via the local child process environment and scoped
to that connection. No secrets are written to source files.

| Capability | Default | Opt in |
|---|---|---|
| HUD display, blades, themes and reactor | Enabled | None |
| Browser status and tab list | Disabled | JARVIS_CODEX_BROWSER=1 |
| Browser page text, structure and screenshots | Disabled | JARVIS_CODEX_BROWSER=1, approval for each read |
| Camera look/watch | Disabled | JARVIS_CODEX_CAMERA=1, approval for each capture |
| Browser navigate, scroll, click, type and keys | Disabled | JARVIS_CODEX_BROWSER=1 and JARVIS_CODEX_ACTIONS=1, approval for each action |
| Shell writes, disk writes, other privileged MCP tools | Disabled | Not supported by this bridge |

The JARVIS browser shows a native "Allow this single operation?" prompt.
Denying, closing or ignoring it rejects the operation. Prompts belong to the
foreground JARVIS window and cannot be approved by the model itself.

## 3. Browser access without Claude

Codex uses the Chrome DevTools Protocol by default. Start a **dedicated Chrome
profile**, not the user's normal signed-in browser. Chrome 136+ requires an
explicit non-default user-data-dir for remote debugging.

Example Windows PowerShell, enter as a single line:

    & "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir="$env:LOCALAPPDATA\JarvisChrome"

Example Bash:

    google-chrome --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --user-data-dir="$HOME/.jarvis/chrome-profile"

Then enable the browser connection in the JARVIS terminal:

Bash:

    export JARVIS_AGENT=codex
    export JARVIS_CODEX_BROWSER=1
    export JARVIS_CODEX_CDP_PORT=9222
    npm start

PowerShell:

    $env:JARVIS_AGENT="codex"
    $env:JARVIS_CODEX_BROWSER="1"
    npm start

For browser interaction, additionally set JARVIS_CODEX_ACTIONS=1. Every
navigation, scroll, click, keystroke and typed input still requires a fresh
confirmation. Do not launch Chrome debugging on a public interface.

Optional JARVIS_CODEX_BROWSER_DRIVER=native uses the original Claude extension
transport rather than CDP. It is not required for the recommended setup.

CDP currently supports listing tabs, page text, interactive element refs,
screenshots, navigation, scrolling, clicking, typing and Enter/Escape/Tab/
Backspace keys. It does not support complex iframe interactions, file uploads
or desktop-wide control.

## 4. Camera

Set JARVIS_CODEX_CAMERA=1 in the terminal running JARVIS. Each look or watch
asks for a fresh browser confirmation and may also trigger the normal browser
camera permission prompt. Images go from the browser capture handler to
the requesting MCP tool; they are not saved as files by this adapter.

## 5. ElevenLabs voice

The original TTS/STT routes remain unchanged. Set VITE_USE_ELEVENLABS=1 in
.env.local, set ELEVENLABS_API_KEY in the bridge process environment, and
optionally set JARVIS_VOICE_ID. The key must not be committed or put in a
VITE_* environment variable, which could ship it into the browser bundle.

## 6. Architecture

    JARVIS browser (WebSocket, camera, confirmation dialog)
                    |
            Node JARVIS bridge
             /codex/tool (token + loopback)
                    |
         Per-connection MCP stdio process
                    |
             Codex TypeScript SDK

The MCP server exposes an explicit minimal tool catalog instead of every
Claude tool. The bridge validates every call's session token, argument schema
and enabled capabilities. Disconnecting the WebSocket revokes the token.
Sensitive browser and camera actions are approved by the UI, not by the model.

## 7. Security boundaries

- Codex's read-only sandbox covers its built-in operations. It does NOT
  automatically confine unrelated MCP servers configured in the user's Codex
  installation. Disable or audit them before use. Avoid sensitive accounts.
- Chrome's debugging port itself is powerful. Use a dedicated disposable
  profile, loopback binding and a trusted machine. Other local processes with
  access to the CDP port may be able to control it independently of Jarvis.
- The MCP bridge validates action arguments and asks for user permission; it
  does not authorize shell writes or filesystem writes.
- The Codex SDK lacks a dedicated systemPrompt option on ThreadOptions; JARVIS
  instructions are prepended as ordinary context, not system instructions.
- The lightweight STDIO MCP implementation requires protocol conformance and
  cross-platform testing with the installed Codex version.
- Codex agent message events may be buffered until an item completes, so its
  speech can be slower than the Claude partial-token path.

## 8. Test before merging

    npm test
    npm run build
    npm run lint

Manual smoke test: HUD display/theme/reset, browser tabs, approval/denial for
page reads, screenshots, camera look/watch, navigate/click/type (actions
enabled), speech interruption, reconnects, and ElevenLabs speech. Also test
that the original Claude backend still starts normally.

The automated tests exercise mocked behavior; they do not establish that
live Codex authentication, Chrome, camera or ElevenLabs are working yet.
