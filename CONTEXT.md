# Pi Agent

Pi Agent is a Windows desktop packaging project for the pi-web interface.

## Language

**Pi Web**:
The upstream web interface imported from `https://github.com/agegr/pi-web` as a git subtree under `./pi-web`.
_Avoid_: vendored copy, external checkout

**Pi Agent App**:
The user-facing product name shown in the desktop window and web interface title areas. It is applied by the Desktop wrapper by patching a temporary Pi Web build copy without modifying Pi Web subtree source.
_Avoid_: pi-web, Pi Agent, upstream title

**Desktop wrapper**:
The root-level Tauri layer that packages Pi Web as the Pi Agent Windows desktop application. It owns `src-tauri/` and desktop build configuration.
_Avoid_: upstream app, web frontend

**Local Pi Web server**:
The loopback-only Next.js server started by the desktop wrapper to serve Pi Web inside the Tauri window. It prefers `127.0.0.1:30141` and may fall back to another free loopback port when that port is unavailable. Startup failures are surfaced in the desktop window with a readable error and log location.
_Avoid_: LAN server, public web server

**Runtime bundle**:
The Node/Next resources embedded in `pi-agent.exe` and extracted to a user data directory on first run so the desktop wrapper can serve Pi Web locally.
_Avoid_: external prerequisite, installed server

**Standalone executable**:
A single Windows `.exe` file that can be copied and run without an installer or companion application files. It may assume the target Windows system already has Microsoft Edge WebView2 Runtime installed and may extract its Runtime bundle to a user data directory at runtime.
_Avoid_: installer, app bundle, distributable app
