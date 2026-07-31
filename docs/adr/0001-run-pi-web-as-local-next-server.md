# Run Pi Web as a local Next.js server

Pi Web is a Next.js application with server-side behavior, while Pi Agent needs to package it as a Windows Tauri desktop application. We will have the desktop wrapper start a local Next.js server and load it in the Tauri window, accepting the extra Node/Next runtime complexity instead of forcing a static export that may break Pi Web functionality.

## Consequences

The Windows distribution still targets a single `pi-agent.exe`, but that executable must embed or otherwise arrange the Node/Next runtime needed to serve Pi Web locally. The runtime bundle will use Windows x64 Node.js v24.14.1. The app may assume Microsoft Edge WebView2 Runtime is already installed on the target system.
