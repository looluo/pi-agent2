# Pi Agent App

Windows desktop wrapper for the upstream [`agegr/pi-web`](https://github.com/agegr/pi-web) interface.

## Build

Prerequisites:

- Windows x64
- Rust/Cargo
- Node.js/npm
- Microsoft Edge WebView2 Runtime on target machines

Build the standalone executable:

```bash
npm install --include=dev
npm run build
```

The build produces:

```text
dist/pi-agent.exe
```

`pi-agent.exe` embeds a runtime bundle containing Node.js v24.14.1 for Windows x64 and a production Pi Web build. On first run it extracts that bundle under the user's local app data directory, starts Pi Web on `127.0.0.1:30141` or another free loopback port, then opens it in the Tauri window.

## Notes

- `pi-web/` is imported as a git subtree and should stay unmodified.
- The desktop build patches a temporary copy of `pi-web/` so visible branding and document/window titles read `Pi Agent App`.
- `src-tauri/resources/runtime-bundle.zip` and `dist/pi-agent.exe` are generated artifacts and are ignored by git.
