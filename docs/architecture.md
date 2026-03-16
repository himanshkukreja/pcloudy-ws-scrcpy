# ws-scrcpy Architecture & Working Guide

A comprehensive guide to how ws-scrcpy works — how video streaming, touch/keyboard controls, and audio playback are orchestrated together in real time.

## Table of Contents

1. [What is ws-scrcpy](#what-is-ws-scrcpy)
2. [High-Level Architecture](#high-level-architecture)
3. [The Three Pillars: Stream, Controls, Audio](#the-three-pillars-stream-controls-audio)
4. [Server Side (Node.js)](#server-side-nodejs)
   - [Entry Point & Service Startup](#entry-point--service-startup)
   - [HTTP & WebSocket Servers](#http--websocket-servers)
   - [Middleware System](#middleware-system)
   - [Device Discovery (ControlCenter + ADB)](#device-discovery-controlcenter--adb)
   - [ScrcpyServer (Launching scrcpy on Device)](#scrcpyserver-launching-scrcpy-on-device)
   - [Multi-Tab Session Sharing Architecture](#multi-tab-session-sharing-architecture)
   - [ScrcpyDeviceSession (Shared Per-Device Session)](#scrcpydevicesession-shared-per-device-session)
   - [ScrcpyTcpProxy (Thin Per-Client Wrapper)](#scrcpytcpproxy-thin-per-client-wrapper)
5. [Browser Side (TypeScript SPA)](#browser-side-typescript-spa)
   - [Entry Point & Action Routing](#entry-point--action-routing)
   - [Device List & Stream Configuration](#device-list--stream-configuration)
   - [StreamClientScrcpy (The Orchestrator)](#streamclientscrcpy-the-orchestrator)
   - [StreamReceiver (WebSocket Packet Dispatch)](#streamreceiver-websocket-packet-dispatch)
   - [Player System (Video Decoding & Rendering)](#player-system-video-decoding--rendering)
   - [AudioPlayer (Opus Decoding & Web Audio)](#audioplayer-opus-decoding--web-audio)
   - [Interaction Handlers (Touch & Scroll)](#interaction-handlers-touch--scroll)
   - [Control Messages (Binary Protocol)](#control-messages-binary-protocol)
   - [Keyboard Input Handling](#keyboard-input-handling)
   - [Toolbar UI (GoogToolBox)](#toolbar-ui-googtoolbox)
6. [End-to-End Data Flows](#end-to-end-data-flows)
   - [Video Frame: Device Screen → Browser Canvas](#video-frame-device-screen--browser-canvas)
   - [Touch Event: Browser Click → Device Touch](#touch-event-browser-click--device-touch)
   - [Audio Frame: Device Microphone → Browser Speaker](#audio-frame-device-microphone--browser-speaker)
7. [Connection Lifecycle (Full Walkthrough)](#connection-lifecycle-full-walkthrough)
8. [Multiplexer System](#multiplexer-system)
9. [Key File Reference](#key-file-reference)

---

## What is ws-scrcpy

ws-scrcpy is a **web-based Android device mirroring and remote control tool**. It lets you see your Android device's screen in a browser window and interact with it (touch, type, scroll) — all over a network connection.

Under the hood, it uses:
- **scrcpy-server v3.1** (a small Java binary from [Genymobile/scrcpy](https://github.com/Genymobile/scrcpy)) running on the Android device to capture the screen, record audio, and inject touch/key events
- **ADB (Android Debug Bridge)** to deploy and communicate with the scrcpy-server
- **Node.js** as a backend that bridges the TCP-based scrcpy protocol to WebSockets
- **Browser** as the frontend with HTML5 video decoders and Web Audio for playback

---

## High-Level Architecture

```
┌───────────────────────┐
│   ANDROID DEVICE      │
│                       │
│  scrcpy-server 3.1    │
│  (Java process)       │
│                       │
│  ┌─────────────────┐  │
│  │ Video Encoder   │  │       Abstract Unix Socket
│  │ (H.264/H.265)   │──┼──┐   (scrcpy_00000000)
│  └─────────────────┘  │  │
│  ┌─────────────────┐  │  │   3 sequential TCP connections
│  │ Audio Capture   │──┼──┤   over ADB port forwarding
│  │ (Opus)          │  │  │
│  └─────────────────┘  │  │
│  ┌─────────────────┐  │  │
│  │ Input Injector  │◄─┼──┘
│  │ (Controller)    │  │
│  └─────────────────┘  │
└───────────────────────┘
            │
            │ ADB (USB/WiFi)
            ▼
┌──────────────────────────────────────────────────────────┐
│                    NODE.JS SERVER                         │
│                                                          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │            ScrcpyDeviceSession (shared)              │ │
│  │     One instance per device, owns 3 TCP sockets     │ │
│  │                                                     │ │
│  │  video socket ─┐                                    │ │
│  │  audio socket ──┤── reads frames, broadcasts        │ │
│  │  control socket ┘   to all connected WS clients     │ │
│  │                                                     │ │
│  │  Cached state: initial msg, video config (SPS/PPS), │ │
│  │  last IDR keyframe, audio config                    │ │
│  └──────────────────────┬──────────────────────────────┘ │
│                         │                                │
│              ┌──────────┼──────────┐                     │
│              ▼          ▼          ▼                      │
│  ┌──────────────┐ ┌──────────┐ ┌──────────┐             │
│  │ScrcpyTcpProxy│ │  Proxy   │ │  Proxy   │  ...        │
│  │  (Tab 1 WS)  │ │ (Tab 2)  │ │ (Tab 3)  │             │
│  └──────┬───────┘ └────┬─────┘ └────┬─────┘             │
└─────────┼──────────────┼────────────┼────────────────────┘
          │              │            │
          │ WebSocket    │            │
          ▼              ▼            ▼
┌──────────────┐  ┌──────────┐  ┌──────────┐
│  Browser     │  │ Browser  │  │ Browser  │
│  Tab 1       │  │ Tab 2    │  │ Tab 3    │
│  ┌────────┐  │  │          │  │          │
│  │Player  │  │  │          │  │          │
│  │Canvas  │  │  │          │  │          │
│  │Audio   │  │  │          │  │          │
│  │Controls│  │  │          │  │          │
│  └────────┘  │  │          │  │          │
└──────────────┘  └──────────┘  └──────────┘
```

**Key insight**: The Node.js server is the central translator. The Android device speaks raw TCP (scrcpy protocol). The browser speaks WebSocket. Node.js bridges them. Multiple browser tabs share a single set of TCP connections to the device via the `ScrcpyDeviceSession` singleton.

---

## The Three Pillars: Stream, Controls, Audio

Everything in ws-scrcpy revolves around three concurrent data streams, all flowing through a single WebSocket connection between the browser and Node.js:

### 1. Video Stream (Device → Browser)

```
Android screen → MediaCodec H.264 encoder → TCP socket → ScrcpyDeviceSession
broadcasts to all WS clients → Browser H.264 decoder (WebCodecs/Broadway/MSE) → <canvas>
```

The device continuously captures screen frames, encodes them as H.264 NAL units, and sends them over TCP. The shared `ScrcpyDeviceSession` reads frames, strips scrcpy headers, and broadcasts raw encoded video to all connected browser tabs. Each browser decodes and renders frames to a canvas.

### 2. Controls (Browser → Device)

```
Mouse/touch event on <canvas> → coordinate transform → TouchControlMessage binary →
WebSocket → ScrcpyTcpProxy → ScrcpyDeviceSession → TCP control socket →
scrcpy InputManager → Android InputEvent injection
```

Browser touch/mouse events are captured on the canvas overlay, transformed from browser coordinates to device screen coordinates (accounting for rotation, zoom, and aspect ratio), serialized into scrcpy's binary control message format, and sent back through the WebSocket. The server forwards valid control messages (types 0–17) to the shared TCP control socket. scrcpy injects them as native Android input events. **Any** connected tab can send control messages — they all go to the same control socket.

### 3. Audio (Device → Browser)

```
Android AudioRecord (REMOTE_SUBMIX) → Opus encoder → TCP socket →
ScrcpyDeviceSession tags with magic → broadcasts to all WS clients →
Browser AudioDecoder (WebCodecs) → AudioBufferSourceNode → speakers
```

The device captures system audio output, encodes it as Opus frames, and sends them over a separate TCP socket. The session tags each frame with a magic prefix (`scrcpy_audio`) so the browser can distinguish audio from video packets on the shared WebSocket. The browser decodes Opus frames and schedules them for playback through the Web Audio API.

### How They Stay In Sync

All three streams are **independent but concurrent**:

- **Video and audio** are inherently synced at the source (the device captures both simultaneously). Minor drift is handled by the AudioPlayer's latency management (drops audio if >100ms behind).
- **Controls** are fire-and-forget from the browser's perspective — there's no acknowledgment. The visual feedback comes from the next video frame that reflects the touch.
- **Single WebSocket per tab, shared TCP sockets**: Each browser tab has one WebSocket connection to Node.js. Node.js maintains three shared TCP sockets per device. Video and audio are broadcast to all tabs; control messages from any tab are forwarded to the shared control socket.

---

## Server Side (Node.js)

### Entry Point & Service Startup

**File**: `src/server/index.ts`

The server boots in this sequence:

```
1. Load configuration (Config singleton from YAML/JSON)
2. Dynamically import platform modules:
   ├── Google/Android: ControlCenter, DeviceTracker, ScrcpyTcpProxy, ...
   └── Apple/iOS: ControlCenter, DeviceTracker, WebDriverAgentProxy, ...
3. Start services:
   ├── HttpServer (Express, static files, SSL/TLS)
   ├── WebSocketServer (ws library, connection routing)
   └── ControlCenter (ADB device tracker)
4. Register middleware:
   ├── mwList (direct WebSocket handlers): WebsocketProxy, WebsocketMultiplexer,
   │   RemoteDevtools, ScrcpyTcpProxy, WebsocketProxyOverAdb
   └── mw2List (multiplexed channel handlers): HostTracker, DeviceTracker,
       RemoteShell, FileListing
5. Listen for SIGINT/SIGTERM for graceful shutdown
```

**Middleware registration order matters**: `ScrcpyTcpProxy` is registered before `WebsocketProxyOverAdb` in `mwList`. This ensures that scrcpy-related `proxy-adb` requests are handled by `ScrcpyTcpProxy` (which understands the raw TCP protocol) rather than `WebsocketProxyOverAdb` (which creates a WebSocket-over-ADB tunnel that scrcpy can't speak). The `WebSocketServer` routing loop breaks after the first middleware match.

Conditional compilation (`#if INCLUDE_GOOG`, `#if INCLUDE_APPL`) controls which platform modules are included in the build.

### HTTP & WebSocket Servers

**HttpServer** (`src/server/services/HttpServer.ts`):
- Express.js application serving the frontend bundle and static assets
- Supports HTTP and HTTPS (with configurable SSL certificates)
- Optional basic auth middleware
- Default port: 8000

**WebSocketServer** (`src/server/services/WebSocketServer.ts`):
- Attaches to the HTTP server for WebSocket upgrades
- Routes incoming connections by `?action=` query parameter
- Iterates registered middleware factories until one handles the connection
- **Breaks** after the first match to prevent double-handling

```
Browser connects: ws://server:8000/?action=stream-scrcpy-tcp&udid=ABC123
                                          ↑ action determines the middleware
```

### Middleware System

**Base class**: `src/server/mw/Mw.ts`

Every server-side handler extends `Mw` and implements the `MwFactory` interface:

```typescript
interface MwFactory {
    processRequest(ws: WS, params: RequestParameters): Mw | undefined;
    processChannel(ws: Multiplexer, code: string, data?: ArrayBuffer): Mw | undefined;
}
```

The two methods represent two activation paths:
- `processRequest()`: Direct WebSocket connection with an `?action=` parameter
- `processChannel()`: A sub-channel opened on a multiplexed WebSocket (4-byte channel code)

| Middleware | Activation | Purpose |
|-----------|-----------|---------|
| `ScrcpyTcpProxy` | `action=stream-scrcpy-tcp` or `action=proxy-adb` | **Core**: Per-client wrapper delegating to shared session |
| `WebsocketProxy` | `action=proxy-ws` | Proxies WebSocket to remote servers |
| `WebsocketProxyOverAdb` | `action=proxy-adb` (fallback) | ADB port-forwarded WebSocket proxy (devtools, etc.) |
| `WebsocketMultiplexer` | `action=multiplex` | Wraps connection in multiplexer |
| `HostTracker` | channel code `HSTS` | Serves list of available device hosts |
| `DeviceTracker` | channel code `GTRC` | Serves live Android device list |
| `RemoteShell` | channel code `SHEL` | PTY-based ADB shell |
| `FileListing` | channel code `FSLS` | File browser operations |
| `RemoteDevtools` | `action=devtools` | Chrome DevTools protocol proxy |

### Device Discovery (ControlCenter + ADB)

**ControlCenter** (`src/server/goog-device/services/ControlCenter.ts`):

Singleton service that manages all connected Android devices:

```
1. Starts ADB device tracker (via adbkit)
2. Tracker emits changeSet events (devices added/removed/changed)
3. For each device: creates Device instance, fetches properties
4. Builds GoogDeviceDescriptor (name, model, interfaces, PID)
5. Emits 'device' events to all connected DeviceTracker middleware
6. Auto-restarts tracker with exponential backoff on failure
```

**Device** (`src/server/goog-device/Device.ts`):

Represents a single Android device:
- Fetches build info (OS version, SDK level, manufacturer, model, CPU arch) via ADB shell
- Detects network interfaces (for WiFi ADB connections)
- Manages scrcpy server lifecycle (start/stop/query PID)
- Multiple PID detection strategies (PIDOF, GREP_PS, LS_PROC) for device compatibility
- Emits 'update' events (throttled at 300ms) when state changes
- Periodically calls `startServer()` via `fetchDeviceInfo()` to keep scrcpy running

### ScrcpyServer (Launching scrcpy on Device)

**File**: `src/server/goog-device/ScrcpyServer.ts`

Deploys and launches the scrcpy-server binary on an Android device:

```
1. Push scrcpy-server.jar to /data/local/tmp/ via ADB
2. Launch via: CLASSPATH=/data/local/tmp/scrcpy-server.jar nohup app_process
              / com.genymobile.scrcpy.Server 3.1
              scid=0 log_level=error audio=true audio_codec=opus
              audio_bit_rate=128000 tunnel_forward=true max_size=1920
              control=true video_codec_options=i-frame-interval:int=2,
              repeat-previous-frame-after:long=100000 2>&1
3. Poll for the process to appear (up to 10 retries with backoff)
4. Verify via /proc/[pid]/cmdline that it's the correct version
5. Kill old/incompatible versions automatically
```

The server runs as an `app_process` with scrcpy-server.jar on its classpath. It creates an abstract Unix socket (`scrcpy_00000000` from `scid=0`) and listens for exactly 3 incoming connections (video, audio, control) via ADB port forwarding (`tunnel_forward=true`).

**Key codec options**:
- `i-frame-interval:int=2` — Forces IDR keyframes every 2 seconds so late-joining clients get a decodable frame quickly
- `repeat-previous-frame-after:long=100000` — Forces the encoder to produce frames even when the screen is static (100ms interval), preventing indefinite waits for data

### Multi-Tab Session Sharing Architecture

scrcpy-server accepts **exactly 3 TCP connections** then stops listening. This creates a fundamental problem: a second browser tab opening the same device would fail because there are no more connections available.

The solution is a **shared session architecture** where one `ScrcpyDeviceSession` per device owns the 3 TCP sockets and broadcasts to all connected WebSocket clients:

```
Tab 1 (WS) ──┐
Tab 2 (WS) ──┤── ScrcpyTcpProxy (thin per-client wrapper, ~60 lines)
Tab 3 (WS) ──┘         │ delegates to
                        ▼
               ScrcpyDeviceSession (shared per-device singleton)
                        │
              ┌─────────┼─────────┐
              video    audio    control  ← 3 TCP sockets (the only 3 scrcpy accepts)
              └─────────┴─────────┘
                   scrcpy-server
```

| Scenario | What happens |
|----------|-------------|
| First tab opens device | New session created, full init (start server, forward, connect TCP, handshake) |
| Second tab opens same device | Reuses existing session, gets cached initial + config + IDR immediately |
| One tab closes | Removed from client set, session stays alive |
| Last tab closes | 3s grace period starts; if no new client → full teardown |
| Page reload (close + open) | New tab arrives within grace period → reuses session, zero restart |
| scrcpy-server crashes | TCP socket close triggers session release, all clients notified |
| Init fails | Error cached, all pending `addClient()` calls get the error, session removed |

### ScrcpyDeviceSession (Shared Per-Device Session)

**File**: `src/server/goog-device/mw/ScrcpyDeviceSession.ts`

This is the **heart of the system** — the component that owns the TCP connections to scrcpy-server and manages all data flow. One instance exists per device.

**Static registry**:
- `sessions: Map<string, ScrcpyDeviceSession>` — keyed by device UDID
- `deviceLocks: Map<string, Promise<void>>` — prevents overlapping init/cleanup

**Initialization sequence** (`init()` with retry):

The session attempts init up to 3 times, with escalating delays between retries:

```
For each attempt (1..3):
  1. Remove stale ADB forward (by remote socket name)
  2. Kill any lingering scrcpy-server process
     - On some devices (e.g. Motorola), the old process lingers after TCP close
     - If not killed, startServer() sees it as "already running" and reuses
       the dead process whose listener socket is exhausted
  3. Start scrcpy server + query screen size (in parallel)
  4. Wait for abstract socket to appear in /proc/net/unix
     - The PID appears before the socket is ready to accept connections
     - Without this check, ADB forward connects to nothing → silent hang
  5. Create fresh ADB forward (tcp:PORT → localabstract:scrcpy_00000000)
     - Uses portfinder with base port 38000 to avoid collisions with the
       HTTP server (default port 8000)
  6. Open 3 sequential TCP connections (video → audio → control)
  7. Read video handshake: 1 byte dummy + 64 bytes device name +
     12 bytes codec metadata (codec_id + width + height)
  8. Read first video config frame (SPS/PPS for H.264)
  9. Build synthetic scrcpy_initial message for client compatibility
  10. Start audio pipeline (reads codec_id, begins streaming)
  11. Enter video streaming loop

On failure: tear down sockets, remove forward, kill server, wait, retry
```

**Late-joining client bootstrap** (`addClient()`):

When a new tab connects to an already-running session, it receives cached state so it can start rendering immediately:

```
1. Send cachedInitialMessage (device name, display info, screen info)
2. Send cachedVideoConfigFrame (SPS/PPS — needed to configure decoder)
3. Send cachedLastIDR (most recent keyframe — shows a frame instantly)
4. Send cachedVideoConfigFrame AGAIN (flush — see NaluStreamBuffer note below)
5. Send cachedAudioConfig (Opus codec-specific data)
6. Add client to waitingForIdr set (skips P-frames until live IDR)
```

**NaluStreamBuffer flush**: The h264-converter library's `NaluStreamBuffer` always holds the last NAL unit until the next one arrives. Without the extra config frame after the IDR, the decoder's buffer retains the IDR forever on a static screen, leaving the client stuck on "Connecting". The redundant config frame pushes the IDR through.

**waitingForIdr mechanism**: Late-joining clients receive the cached IDR for an instant preview, but live P-frames are skipped because they reference frames after the cached IDR that the client never saw. When the next live IDR arrives, the session sends fresh config + IDR + flush to waiting clients, then promotes them to receive all frames.

**Video streaming** (`streamFrames()`):

```
TCP data arrives → accumulate in buffer → parse 12-byte frame headers →
  ├── Config frame? → update cachedVideoConfigFrame, broadcast
  ├── IDR keyframe? → update cachedLastIDR, send config+IDR+flush to waiting clients,
  │                   broadcast to non-waiting clients, promote waiting → active
  └── P-frame?     → broadcast to non-waiting clients only (skip waiting clients)
```

**Audio streaming**:

```
TCP audio socket → read 4-byte codec_id →
  ├── 0x00000000 = disabled → skip
  ├── 0x00000001 = errored → skip
  ├── 0x6f707573 = Opus → enter streaming loop:
  │   read 12-byte header + payload → tag with "scrcpy_audio\0\0\0" magic +
  │   config flag → broadcast to all clients
  └── 0x00616163 = AAC → same as Opus
```

**Control message handling**:

```
Any client's WS message → ScrcpyTcpProxy.onSocketMessage() →
session.handleControlMessage(buf) →
  ├── Empty? → drop
  ├── Type > 17? → drop (ws-scrcpy custom types that scrcpy doesn't understand)
  └── Type 0-17? → forward to shared TCP control socket
```

**Grace period teardown**:

When the last client disconnects, the session waits 3 seconds before tearing down. This handles page reloads gracefully — the new tab arrives within the grace period and reuses the existing session with zero scrcpy restart.

```
Last client disconnects → start 3s timer
  ├── New client within 3s → cancel timer, add to session
  └── Timer expires → release():
      1. Close remaining WS clients
      2. Destroy TCP sockets (triggers scrcpy-server exit)
      3. Remove ADB forward
      4. Register cleanup lock (next session waits for this)
      5. Remove from static registry
```

**Flow control**: Slow clients (bufferedAmount > 1MB) are skipped during broadcast to prevent backpressure from blocking the event loop.

### ScrcpyTcpProxy (Thin Per-Client Wrapper)

**File**: `src/server/goog-device/mw/ScrcpyTcpProxy.ts`

A lightweight (~60 line) per-WebSocket wrapper that delegates all work to the shared `ScrcpyDeviceSession`. Each browser tab gets its own `ScrcpyTcpProxy` instance.

**Responsibilities**:
- `processRequest()`: Accepts `action=stream-scrcpy-tcp` and `action=proxy-adb` requests. The `proxy-adb` handling enables signed/protected URLs that use the generic ADB proxy action.
- `attachToSession()`: Gets or creates the shared session, adds this client. Handles race conditions where the WebSocket closes during async init.
- `onSocketMessage()`: Converts WebSocket data to Buffer, delegates to `session.handleControlMessage()`.
- `release()`: Removes this client from the session on WebSocket close.

**Race condition handling**: The session reference (`this.session`) is only set AFTER `addClient()` succeeds. This prevents premature `removeClient()` calls during init. A post-await check handles the case where the WebSocket closes while `addClient()` is in progress.

---

## Browser Side (TypeScript SPA)

### Entry Point & Action Routing

**File**: `src/app/index.ts`

The browser app is a single-page application. On load:

```
1. window.onload fires
2. Parse URL query parameters
3. Conditionally register video players (compile-time flags):
   ├── BroadwayPlayer (WebAssembly H.264)
   ├── TinyH264Player (WebWorker H.264)
   ├── WebCodecsPlayer (WebCodecs API)
   └── MsePlayer (MediaSource Extensions)
4. Route based on ?action= parameter:
   ├── "stream" + udid → StreamClientScrcpy.start()
   ├── "shell"          → ShellClient.start()
   ├── "devtools"       → DevtoolsClient.start()
   ├── "list-files"     → FileListingClient.start()
   └── (none)           → HostTracker.start() → shows device list
```

### Device List & Stream Configuration

When no `action` parameter is present, the browser shows the **device list page**:

**HostTracker** (`src/app/client/HostTracker.ts`):
- Opens a multiplexed WebSocket to the server
- Requests list of available hosts (local + remote)
- For each host, creates a **DeviceTracker** instance

**DeviceTracker** (`src/app/googDevice/client/DeviceTracker.ts`):
- Connects to a host's device tracker endpoint
- Receives live device list updates
- Renders an HTML table with device info and action buttons
- Each device row has a "Configure stream" button

**ConfigureScrcpy** (`src/app/googDevice/client/ConfigureScrcpy.ts`):
- Modal dialog that opens when clicking "Configure stream"
- Lets the user choose:
  - Video player implementation (BroadwayPlayer, WebCodecsPlayer, MsePlayer, etc.)
  - Video settings (bitrate, FPS, I-frame interval, max resolution)
  - Display selection (for multi-display devices)
  - Encoder selection (if device has multiple H.264 encoders)
  - Fit-to-screen mode
- Clicking OK navigates to `/?action=stream&udid=...&player=...`

### StreamClientScrcpy (The Orchestrator)

**File**: `src/app/googDevice/client/StreamClientScrcpy.ts`

This is the **browser-side counterpart** to the server-side session — it orchestrates all browser-side components for a streaming session.

**Construction sequence** (triggered by URL with `?action=stream`):

```
1. Create StreamReceiverScrcpy (opens WebSocket to server)
2. Set body class to 'stream' (applies stream page CSS)
3. Call startStream():

   a. Instantiate the chosen video player (e.g., WebCodecsPlayer)
   b. Create DOM structure:
      ├── device-view (main container)
      │   ├── control-buttons-list (GoogToolBox sidebar)
      │   ├── video (flex container)
      │   │   └── phone-container (transform target for zoom/rotation)
      │   │       ├── video-loading-overlay (spinner, shown until first frame)
      │   │       ├── <canvas class="video-layer"> (player renders here)
      │   │       └── <canvas class="touch-layer"> (captures input events)
      │   └── moreBox (advanced settings panel)

   c. Set up interaction handlers:
      ├── FeaturedInteractionHandler (touch/mouse/scroll on canvas)
      └── KeyInputHandler (keyboard events, global)

   d. Set up file push handler (drag-and-drop APK install)

   e. Initialize AudioPlayer (if WebCodecs AudioDecoder supported)

   f. Register event listeners on StreamReceiver:
      ├── 'video'        → push frame to player
      ├── 'audio'        → push packet to AudioPlayer
      ├── 'displayInfo'  → update screen dimensions
      ├── 'clientsStats' → update title with device name
      ├── 'deviceMessage' → forward to GoogMoreBox
      └── 'disconnected'  → cleanup everything
```

**Key responsibilities**:
- Instantiates and wires together ALL browser-side components
- Owns the `sendMessage(msg)` method that all control messages flow through
- Manages video settings negotiation with the server
- Handles fit-to-screen calculations
- Provides `setMuted(bool)` for audio mute control
- Provides `setHandleKeyboardEvents(bool)` for keyboard capture toggle

### StreamReceiver (WebSocket Packet Dispatch)

**File**: `src/app/client/StreamReceiver.ts`

Sits between the WebSocket and all consumers. Every binary message from the server arrives here and gets dispatched based on magic prefix detection:

```
WebSocket message (ArrayBuffer) arrives
  │
  ├── First 14 bytes == "scrcpy_initial"?  → handleInitialInfo()
  │   Parses: device name (64 bytes), display count, for each display:
  │     DisplayInfo (24 bytes: displayId, width, height, rotation, layerStack, flags)
  │     connectionCount, ScreenInfo (25 bytes: contentRect, videoSize, deviceRotation)
  │     VideoSettings (variable: bitrate, maxFps, bounds, crop, codec options)
  │   Then: encoder list, client ID
  │   Emits: 'clientsStats', 'displayInfo', 'encoders', 'rotated'
  │
  ├── First 14 bytes == DeviceMessage magic? → parse DeviceMessage
  │   Emits: 'deviceMessage' (clipboard content, etc.)
  │
  ├── First 15 bytes == "scrcpy_audio\0\0\0"? → extract audio payload
  │   Emits: 'audio' (Uint8Array: config flag byte + Opus data)
  │
  └── None of the above → it's a video frame
      Emits: 'video' (ArrayBuffer: raw H.264 NAL units)
```

The 15-byte audio magic is deliberately a different length from the 14-byte initial/message magics to prevent false matches.

### Player System (Video Decoding & Rendering)

**Base class**: `src/app/player/BasePlayer.ts`

Abstract player providing:
- Video settings management (bitrate, resolution, FPS) with localStorage persistence
- Screen info tracking (device dimensions, rotation)
- Zoom support: `zoomIn()`, `zoomOut()`, `resetZoom()` with CSS transforms on phone-container
- UI rotation: `rotateScreen()` cycles through 0°/90°/180°/270°
- Playback quality stats (FPS, bitrate, decode time)
- Screenshot capability
- Loading overlay management

**Player implementations** (all extend `BaseCanvasBasedPlayer` or `BasePlayer`):

| Player | Decoder | Browser Support | Performance | Notes |
|--------|---------|-----------------|-------------|-------|
| **WebCodecsPlayer** | `VideoDecoder` API | Chrome 94+, Edge 94+ | Best | Hardware-accelerated, lowest latency. Parses NAL units to detect SPS/PPS/IDR. |
| **MsePlayer** | MediaSource Extensions | Chrome, Firefox, Safari | Good | Uses h264-converter to wrap NALUs in fMP4 container, plays via `<video>` element. NaluStreamBuffer holds last NALU until next arrives. |
| **BroadwayPlayer** | Broadway.js (WASM) | All modern browsers | Moderate | Pure software H.264 decoder in WebAssembly |
| **TinyH264Player** | tinyh264 (WebWorker) | All modern browsers | Moderate | WASM decoder running in background thread |

**Frame flow** through a canvas-based player:

```
player.pushFrame(Uint8Array)
  → Queue frame for decoding (drop old frames if buffer > maxFps/10 ms)
  → Decoder produces raw YUV/RGB frame
  → requestAnimationFrame callback
  → Draw frame to <canvas> (WebGL or 2D context)
  → Hide loading overlay on first successful frame
```

### AudioPlayer (Opus Decoding & Web Audio)

**File**: `src/app/player/AudioPlayer.ts`

Decodes Opus audio from the stream and plays it through Web Audio API:

**Architecture**:
```
pushAudioData(Uint8Array)
  │
  ├── byte[0] == 0x01 (config packet)?
  │   Store as pendingDescription → configure AudioDecoder when AudioContext is running
  │
  └── byte[0] == 0x00 (data packet)?
      ├── if !playing → DROP (AudioContext still suspended)
      ├── if muted → DROP
      └── else: create EncodedAudioChunk(type='key', timestamp, data)
                → AudioDecoder.decode()
                → onDecodedFrame() callback
                → create AudioBuffer from decoded PCM (48kHz, 2ch, f32-planar)
                → create AudioBufferSourceNode
                → connect to AudioContext.destination
                → schedule playback at nextPlayTime
                → nextPlayTime += buffer.duration
```

**Key design decisions**:
- **AudioContext created eagerly** in constructor (during user click gesture) — avoids 10-15s startup delay
- **Drops packets while AudioContext suspended** — prevents 5-6s accumulated delay on resume
- **100ms latency ceiling** — if `nextPlayTime` drifts > 100ms behind `currentTime`, resets to now
- **Mute discards decoded frames** — no scheduling when muted, reset nextPlayTime on unmute

### Interaction Handlers (Touch & Scroll)

**File**: `src/app/interactionHandler/FeaturedInteractionHandler.ts`

Captures browser input events and translates them to scrcpy control messages:

**Touch/Mouse handling**:
```
Browser MouseEvent/TouchEvent on touch-layer canvas
  │
  ├── Get player's ScreenInfo (device dimensions)
  ├── Get player's UI rotation and zoom level
  ├── Transform browser (clientX, clientY) → device (x, y):
  │   1. Subtract canvas offset from browser coordinates
  │   2. Scale by (deviceWidth / canvasWidth) accounting for zoom
  │   3. Rotate coordinates based on UI rotation
  │   4. Clamp to device screen bounds
  │
  ├── Map browser event type to Android MotionEvent action:
  │   mousedown/touchstart  → ACTION_DOWN (0)
  │   mousemove/touchmove   → ACTION_MOVE (2)
  │   mouseup/touchend      → ACTION_UP (1)
  │   touchcancel           → ACTION_CANCEL
  │
  └── Create TouchControlMessage(action, pointerId, position, pressure, buttons)
      → listener.sendMessage(msg)  // StreamClientScrcpy
```

**Scroll handling**:
```
Browser WheelEvent on touch-layer canvas
  │
  ├── Throttle: max one event per 30ms (SCROLL_EVENT_THROTTLING_TIME)
  ├── Convert deltaX/deltaY to direction: -1, 0, or 1
  ├── Transform position (same as touch)
  └── Create ScrollControlMessage(position, hScroll, vScroll, buttons=0)
      → listener.sendMessage(msg)
```

**Multi-touch**: Maintains separate `storedFromMouseEvent` and `storedFromTouchEvent` Maps to track active pointers. Sends ACTION_UP for all active pointers on mouse leave.

### Control Messages (Binary Protocol)

**Base class**: `src/app/controlMessage/ControlMessage.ts`

All control messages serialize to a `Buffer` with a 1-byte type header followed by type-specific payload. All multi-byte fields use **big-endian (network byte order)**.

```
[1 byte: type] [N bytes: payload]
```

| Type | Name | Payload Size | Fields |
|------|------|-------------|--------|
| 0 | TYPE_KEYCODE | 13 bytes | action(1) + keycode(4) + repeat(4) + metaState(4) |
| 1 | TYPE_TEXT | 4 + len bytes | textLength(4) + UTF-8 text(variable) |
| 2 | TYPE_TOUCH | 31 bytes | action(1) + pointerId(8) + x(4) + y(4) + w(2) + h(2) + pressure(2) + actionButton(4) + buttons(4) |
| 3 | TYPE_SCROLL | 20 bytes | x(4) + y(4) + w(2) + h(2) + hScroll(2) + vScroll(2) + buttons(4) |
| 4 | TYPE_BACK_OR_SCREEN_ON | 0 bytes | Back button press or screen on |
| 5 | TYPE_EXPAND_NOTIFICATION_PANEL | 0 bytes | Pull down notification shade |
| 6 | TYPE_EXPAND_SETTINGS_PANEL | 0 bytes | Pull down quick settings |
| 7 | TYPE_COLLAPSE_PANELS | 0 bytes | Collapse notification/settings panels |
| 8 | TYPE_GET_CLIPBOARD | 0 bytes | Request clipboard content |
| 9 | TYPE_SET_CLIPBOARD | 1 + 4 + len | paste(1) + textLength(4) + text(variable) |
| 10 | TYPE_SET_SCREEN_POWER_MODE | 1 byte | mode (0=off, 1=on) |
| 11 | TYPE_ROTATE_DEVICE | 0 bytes | Rotate device orientation |
| 101* | CHANGE_STREAM_PARAMS | varies | VideoSettings buffer (ws-scrcpy extension, filtered by server) |
| 102* | PUSH_FILE | varies | File push protocol (ws-scrcpy extension, filtered by server) |

*Types 101 and 102 are ws-scrcpy custom extensions not part of official scrcpy. They are filtered out by `ScrcpyDeviceSession.handleControlMessage()` (type > 17 → drop) before reaching the device.

**Touch message detail** (TYPE_TOUCH = 2, total 32 bytes):
```
Offset  Length  Field
0       1       type (0x02)
1       1       action (0=DOWN, 1=UP, 2=MOVE)
2-9     8       pointerId (high 4 bytes = 0, low 4 bytes = touch ID)
10-13   4       x coordinate (big-endian int32)
14-17   4       y coordinate (big-endian int32)
18-19   2       screen width (big-endian uint16)
20-21   2       screen height (big-endian uint16)
22-23   2       pressure × 0xFFFF (big-endian uint16)
24-27   4       actionButton (which button triggered this)
28-31   4       buttons (bitmask of currently pressed buttons)
```

**Button constants** (from MotionEvent):
- `BUTTON_PRIMARY = 0x01` (left mouse)
- `BUTTON_SECONDARY = 0x02` (right mouse)
- `BUTTON_TERTIARY = 0x04` (middle mouse)

### Keyboard Input Handling

**File**: `src/app/googDevice/KeyInputHandler.ts`

Global keyboard event handler that captures `keydown`/`keyup` events on `document.body`:

```
Browser KeyboardEvent
  │
  ├── Map browser code (UIEventsCode) to Android keycode via KeyToCodeMap:
  │   KeyA → KEYCODE_A, Enter → KEYCODE_ENTER, ArrowUp → KEYCODE_DPAD_UP, etc.
  │
  ├── Determine action: keydown → ACTION_DOWN (0), keyup → ACTION_UP (1)
  │
  ├── Extract repeat count from event
  │
  ├── Collect meta state flags:
  │   event.altKey   → META_ALT_ON
  │   event.shiftKey → META_SHIFT_ON
  │   event.ctrlKey  → META_CTRL_ON
  │   event.metaKey  → META_META_ON
  │   + CapsLock, ScrollLock, NumLock detection
  │
  ├── Create KeyCodeControlMessage(action, keycode, repeat, metaState)
  │
  ├── Notify all registered KeyEventListener instances
  │
  └── event.preventDefault() (prevent browser default behavior)
```

**File**: `src/app/googDevice/KeyToCodeMap.ts`

Maps browser keyboard codes to Android keycodes. Examples:
- `'KeyA'` → `KeyEvent.KEYCODE_A` (29)
- `'Enter'` → `KeyEvent.KEYCODE_ENTER` (66)
- `'Backspace'` → `KeyEvent.KEYCODE_DEL` (67)
- `'ArrowUp'` → `KeyEvent.KEYCODE_DPAD_UP` (19)
- `'Space'` → `KeyEvent.KEYCODE_SPACE` (62)

### Toolbar UI (GoogToolBox)

**Files**: `src/app/toolbox/ToolBox.ts`, `src/app/googDevice/toolbox/GoogToolBox.ts`

The floating sidebar control panel on the stream page:

```
┌──────────┐
│   ━━━    │  ← Drag handle (grab to reposition)
│   ─      │  ← Toggle button (collapse/expand)
├──────────┤
│  ⏻ Power │  ← ToolBoxButton: sends KeyCodeControlMessage(KEYCODE_POWER)
│  🔊 Vol+  │  ← ToolBoxButton: sends KeyCodeControlMessage(KEYCODE_VOLUME_UP)
│  🔉 Vol-  │  ← ToolBoxButton: sends KeyCodeControlMessage(KEYCODE_VOLUME_DOWN)
│  ◀ Back   │  ← ToolBoxButton: sends KeyCodeControlMessage(KEYCODE_BACK)
│  ● Home   │  ← ToolBoxButton: sends KeyCodeControlMessage(KEYCODE_HOME)
│  ■ Recent │  ← ToolBoxButton: sends KeyCodeControlMessage(KEYCODE_APP_SWITCH)
│  📷 Shot  │  ← ToolBoxButton: calls player.createScreenshot()
│  🔍+ Zoom │  ← ToolBoxButton: calls player.zoomIn()
│  🔍- Zoom │  ← ToolBoxButton: calls player.zoomOut()
│  🔍⟳ Reset│  ← ToolBoxButton: calls player.resetZoom()
│  🔄 Rotate│  ← ToolBoxButton: calls player.rotateScreen()
│  🔊/🔇 Audio│ ← ToolBoxCheckbox: calls client.setMuted(bool)
│  ⌨ Keyboard│  ← ToolBoxCheckbox: calls client.setHandleKeyboardEvents(bool)
└──────────┘
```

**ToolBoxButton**: Simple press button. Sends `KeyCodeControlMessage` with `ACTION_DOWN` on mousedown and `ACTION_UP` on mouseup (mimics physical button press/release).

**ToolBoxCheckbox**: Toggle with two icons. Uses CSS `two-images` class for visual state swap. Calls a callback with the checked state on click.

**ToolBox container features**:
- Draggable (mouse and touch) with viewport boundary constraints
- Collapsible with animated transition
- Responsive (bottom bar on mobile, vertical sidebar on desktop)

---

## End-to-End Data Flows

### Video Frame: Device Screen → Browser Canvas

```
Step 1  │ Android SurfaceFlinger captures screen update
Step 2  │ scrcpy-server's ScreenEncoder records via MediaCodec (H.264 hardware encoder)
Step 3  │ Encoded NAL unit written to video TCP socket:
        │   [8 bytes: flags+PTS] [4 bytes: size] [N bytes: H.264 data]
Step 4  │ ScrcpyDeviceSession.streamFrames() reads from TCP socket:
        │   - Accumulates data in rolling buffer
        │   - Parses 12-byte headers, extracts payload
        │   - Detects config frames (SPS/PPS) → updates cache
        │   - Detects IDR keyframes → updates cache, serves waiting clients
        │   - Broadcasts raw H.264 payload over WebSocket to all clients
Step 5  │ Browser WebSocket receives ArrayBuffer
Step 6  │ StreamReceiver.onSocketMessage():
        │   - No magic prefix match → emit('video', data)
Step 7  │ StreamClientScrcpy.onVideo():
        │   - player.pushFrame(new Uint8Array(data))
Step 8  │ Player decodes H.264 NAL units:
        │   WebCodecsPlayer: VideoDecoder.decode(EncodedVideoChunk)
        │   BroadwayPlayer: Decoder.decode(nalUnit)
        │   MsePlayer: H264Converter → SourceBuffer.appendBuffer()
Step 9  │ Decoded frame rendered to <canvas> via WebGL or 2D context
```

**Latency**: Typically 50-150ms end-to-end (hardware encoding + network + decoding).

### Touch Event: Browser Click → Device Touch

```
Step 1  │ User clicks/taps on touch-layer <canvas>
Step 2  │ FeaturedInteractionHandler.onInteraction(MouseEvent):
        │   a. Get ScreenInfo from player (device dimensions)
        │   b. Get UI rotation and zoom level
        │   c. Transform (clientX, clientY) → (deviceX, deviceY)
        │   d. Map mousedown → MotionEvent.ACTION_DOWN
        │   e. Calculate pressure (1.0 for mouse, event.force for touch)
Step 3  │ Create TouchControlMessage:
        │   Buffer = [0x02] [ACTION_DOWN:1] [pointerId:8] [x:4] [y:4]
        │            [screenW:2] [screenH:2] [pressure:2] [actionBtn:4] [buttons:4]
        │   Total: 32 bytes (1 type + 31 payload)
Step 4  │ StreamClientScrcpy.sendMessage(msg)
        │   → StreamReceiver.sendEvent(msg)
        │   → ws.send(msg.toBuffer())
Step 5  │ Node.js WebSocket receives binary message
Step 6  │ ScrcpyTcpProxy.onSocketMessage():
        │   → Convert to Buffer → session.handleControlMessage(buf)
Step 7  │ ScrcpyDeviceSession.handleControlMessage():
        │   a. Read first byte: type = 2 (TYPE_TOUCH), valid (≤ 17)
        │   b. Forward raw buffer to shared TCP control socket
Step 8  │ scrcpy-server ControlMessageReader:
        │   a. Read type byte → dispatch to InjectTouchEventReader
        │   b. Parse 31 payload bytes → create android.view.MotionEvent
Step 9  │ scrcpy-server Controller:
        │   InputManager.injectInputEvent(motionEvent, INJECT_INPUT_EVENT_MODE_ASYNC)
Step 10 │ Android processes the touch event as if the user touched the screen
Step 11 │ Screen updates → next video frame captures the result → broadcast to all tabs
```

### Audio Frame: Device Microphone → Browser Speaker

```
Step 1  │ Android captures system audio via AudioRecord (REMOTE_SUBMIX source)
Step 2  │ scrcpy-server's AudioEncoder encodes PCM → Opus via MediaCodec
Step 3  │ Encoded Opus frame written to audio TCP socket:
        │   [8 bytes: flags+PTS] [4 bytes: size] [N bytes: Opus data]
        │   First frame has IS_CONFIG flag set (codec-specific data)
Step 4  │ ScrcpyDeviceSession.streamFrames(socket, isAudio=true):
        │   a. Parse 12-byte header, extract IS_CONFIG flag
        │   b. Build tagged packet:
        │      ["scrcpy_audio\0\0\0"] [0x01 or 0x00 config flag] [Opus payload]
        │   c. Cache audio config if IS_CONFIG
        │   d. Broadcast to all connected WS clients
Step 5  │ Browser WebSocket receives ArrayBuffer
Step 6  │ StreamReceiver.onSocketMessage():
        │   - First 15 bytes match MAGIC_BYTES_AUDIO
        │   - emit('audio', Uint8Array starting after magic)
Step 7  │ StreamClientScrcpy.onAudio():
        │   - audioPlayer.resume() (nudge AudioContext)
        │   - audioPlayer.pushAudioData(data)
Step 8  │ AudioPlayer.pushAudioData():
        │   a. byte[0] == 1? → initDecoder(payload) stores config, sets up AudioDecoder
        │   b. byte[0] == 0? → if playing && !muted:
        │      Create EncodedAudioChunk(type='key', timestamp, data)
        │      decoder.decode(chunk)
Step 9  │ AudioDecoder calls onDecodedFrame(AudioData):
        │   a. Create AudioBuffer from decoded PCM samples (48kHz, 2ch, f32-planar)
        │   b. Create AudioBufferSourceNode
        │   c. Connect to AudioContext.destination
        │   d. Schedule: source.start(nextPlayTime)
        │   e. Advance: nextPlayTime += buffer.duration
Step 10 │ Web Audio API plays scheduled audio through speakers
```

---

## Connection Lifecycle (Full Walkthrough)

### Phase 1: Device List Page

```
User opens http://server:8000/
  ↓
Browser loads index.html + bundle.js
  ↓
No ?action= → HostTracker.start()
  ↓
Opens multiplexed WebSocket: ws://server:8000/?action=multiplex
  ↓
Creates channel with code "HSTS" → server responds with host list
  ↓
For each host: creates DeviceTracker → opens channel "GTRC"
  ↓
Server's ControlCenter sends device descriptors
  ↓
Browser renders device table with "Configure stream" buttons
```

### Phase 2: Stream Configuration

```
User clicks "Configure stream" on a device
  ↓
ConfigureScrcpy dialog opens
  ↓
Creates temporary StreamReceiverScrcpy to fetch device capabilities:
  - Available encoders
  - Display list (for multi-display)
  - Current video settings
  ↓
User selects player, adjusts settings, clicks OK
  ↓
Browser navigates to:
  /?action=stream&udid=ABC123&player=WebCodecsPlayer&ws=...
```

### Phase 3: Stream Session Startup

```
Browser loads with ?action=stream
  ↓
StreamClientScrcpy.start(params) called
  ↓
Creates StreamReceiverScrcpy → opens WebSocket:
  ws://server:8000/?action=stream-scrcpy-tcp&udid=ABC123
  ↓
Server: WebSocketServer routes to ScrcpyTcpProxy.processRequest()
  ↓
ScrcpyTcpProxy calls ScrcpyDeviceSession.getOrCreate(udid)
  ├── Session exists? → Cancel grace period, reuse session
  └── No session? → Create new session, begin init():
      1. Remove stale ADB forward
      2. Kill lingering scrcpy-server processes
      3. Start scrcpy server + query screen size
      4. Wait for abstract socket in /proc/net/unix
      5. Create ADB forward (tcp:38000+ → localabstract:scrcpy_00000000)
      6. Open 3 TCP connections (video → audio → control)
      7. Read video handshake, cache initial message + video config
      8. Start audio pipeline, start video streaming
  ↓
session.addClient(ws):
  → Send cached: initial message → video config → IDR → flush → audio config
  → Add to waitingForIdr set
  ↓
Browser StreamReceiver receives scrcpy_initial:
  → Parses device name, display info, screen info
  → Emits 'clientsStats', 'displayInfo'
  ↓
StreamClientScrcpy.onDisplayInfo():
  → Sets screen info on player
  → Player starts: play() → enters PLAYING state
  ↓
Video frames start flowing (broadcast → all WS clients → player.pushFrame())
Audio frames start flowing (broadcast → all WS clients → AudioPlayer)
Controls ready (any browser tab → WS → session → TCP control socket → device)
```

### Phase 4: Active Streaming (Multi-Tab)

```
Concurrent streams running:

  VIDEO (60fps):  Device → TCP → ScrcpyDeviceSession → broadcast to all WS → Players
  AUDIO (50fps):  Device → TCP → ScrcpyDeviceSession → broadcast to all WS → AudioPlayers
  CONTROL:        Any Tab Canvas → TouchHandler → WS → ScrcpyTcpProxy → Session → TCP → Device

Tab 2 opens same device:
  → ScrcpyTcpProxy.getOrCreate(udid) returns EXISTING session
  → session.addClient(ws2) sends cached state → instant rendering
  → Tab 2 added to waitingForIdr → receives next live IDR → promoted to full stream
```

### Phase 5: Disconnection

```
User closes one browser tab
  ↓
WebSocket closes → ScrcpyTcpProxy.release()
  ↓
session.removeClient(ws)
  ├── Other clients remain → session continues
  └── Last client → start 3s grace period
      ├── New tab within 3s → cancel, reuse session
      └── Grace period expires → session.release():
          ├── Destroy video/audio/control TCP sockets
          ├── scrcpy-server detects disconnect → exits
          ├── Remove ADB forward
          ├── Register cleanup lock
          └── Remove from static registry
  ↓
Browser: StreamClientScrcpy.onDisconnected()
  ├── audioPlayer.stop() → closes AudioContext + AudioDecoder
  ├── touchHandler.release() → removes event listeners
  ├── filePushHandler.release()
  └── player.stop() → stops rendering
```

---

## Multiplexer System

**Files**: `src/packages/multiplexer/`

The multiplexer enables **multiple logical channels over a single WebSocket**. This is used for the device list page where the browser needs concurrent connections to HostTracker, DeviceTracker, RemoteShell, and FileListing — all over one WebSocket.

**Note**: The video stream does NOT use the multiplexer. `StreamClientScrcpy` opens a dedicated direct WebSocket for the stream because of the high bandwidth requirements and latency sensitivity.

**Binary message format**:
```
[1 byte: MessageType] [4 bytes: channelId (UInt32LE)] [N bytes: payload]
```

**Message types**:
- `CreateChannel` (4): Opens a new sub-channel
- `CloseChannel` (8): Closes a channel with code/reason
- `RawBinaryData` (16): Binary payload on a channel
- `RawStringData` (32): String payload on a channel
- `Data` (64): Typed data payload

**Channel creation flow**:
```
Browser: multiplexer.createChannel(initData)
  → Sends CreateChannel message with new channelId + initData
  → initData first 4 bytes = channel code (e.g., "GTRC")
  ↓
Server: WebsocketMultiplexer receives CreateChannel
  → Extracts 4-byte code from initData
  → Iterates mw2List factories: factory.processChannel(multiplexer, code, data)
  → Matching factory creates middleware instance for that channel
  ↓
Channel established: both sides can send/receive independently
```

---

## Key File Reference

### Server Side

| File | Purpose |
|------|---------|
| `src/server/index.ts` | Entry point: boots services, registers middleware |
| `src/server/Config.ts` | Configuration singleton (YAML/JSON), default port 8000 |
| `src/server/services/HttpServer.ts` | Express HTTP/HTTPS server |
| `src/server/services/WebSocketServer.ts` | WebSocket connection routing (breaks after first match) |
| `src/server/mw/Mw.ts` | Middleware base class and MwFactory interface |
| `src/server/mw/WebsocketMultiplexer.ts` | Multiplexer activation middleware (mw2List routing) |
| `src/server/mw/HostTracker.ts` | Serves available device hosts |
| `src/server/goog-device/services/ControlCenter.ts` | ADB device tracking, Device management, descriptor emission |
| `src/server/goog-device/Device.ts` | Single Android device: properties, PID detection, server lifecycle |
| `src/server/goog-device/AdbUtils.ts` | ADB utility functions (forward, removeForward, devtools) |
| `src/server/goog-device/ScrcpyServer.ts` | Deploys and launches scrcpy on device |
| `src/server/goog-device/mw/ScrcpyDeviceSession.ts` | **Core**: Shared per-device session, owns 3 TCP sockets, broadcasts to all clients |
| `src/server/goog-device/mw/ScrcpyTcpProxy.ts` | Thin per-client wrapper, delegates to shared session |
| `src/server/goog-device/mw/DeviceTracker.ts` | Device list WebSocket middleware |
| `src/server/goog-device/mw/RemoteShell.ts` | ADB shell via PTY |
| `src/server/goog-device/mw/FileListing.ts` | File browser operations |
| `src/common/Constants.ts` | scrcpy server arguments, socket name, codec options |
| `src/common/Action.ts` | ACTION enum for URL routing |

### Browser Side

| File | Purpose |
|------|---------|
| `src/app/index.ts` | Entry point: player registration, action routing |
| `src/app/client/ManagerClient.ts` | WebSocket base class with multiplexer support |
| `src/app/client/HostTracker.ts` | Device host discovery |
| `src/app/client/StreamReceiver.ts` | WebSocket packet dispatch (magic prefix → video/audio/initial) |
| `src/app/googDevice/client/DeviceTracker.ts` | Device list UI |
| `src/app/googDevice/client/ConfigureScrcpy.ts` | Stream configuration dialog |
| `src/app/googDevice/client/StreamClientScrcpy.ts` | **Core**: Stream session orchestrator |
| `src/app/googDevice/client/StreamReceiverScrcpy.ts` | scrcpy-specific URL/param parsing |
| `src/app/player/BasePlayer.ts` | Abstract player base (zoom, rotation, stats) |
| `src/app/player/BaseCanvasBasedPlayer.ts` | Canvas rendering, frame queue, drop logic |
| `src/app/player/WebCodecsPlayer.ts` | WebCodecs VideoDecoder player |
| `src/app/player/MsePlayer.ts` | MediaSource Extensions player |
| `src/app/player/BroadwayPlayer.ts` | Broadway.js WASM player |
| `src/app/player/TinyH264Player.ts` | tinyh264 WebWorker player |
| `src/app/player/AudioPlayer.ts` | Opus decoding + Web Audio playback |
| `src/app/interactionHandler/FeaturedInteractionHandler.ts` | Touch/mouse/scroll → control messages |
| `src/app/interactionHandler/InteractionHandler.ts` | Base interaction handler (coordinate transforms) |
| `src/app/controlMessage/ControlMessage.ts` | Control message base + type constants (0-11, 101, 102) |
| `src/app/controlMessage/TouchControlMessage.ts` | Touch event binary format (31 bytes payload) |
| `src/app/controlMessage/ScrollControlMessage.ts` | Scroll event binary format (20 bytes payload) |
| `src/app/controlMessage/KeyCodeControlMessage.ts` | Key event binary format (13 bytes payload) |
| `src/app/controlMessage/TextControlMessage.ts` | Text injection binary format |
| `src/app/controlMessage/CommandControlMessage.ts` | Clipboard, power, video settings, file push commands |
| `src/app/googDevice/KeyInputHandler.ts` | Global keyboard capture → KeyCodeControlMessage |
| `src/app/googDevice/KeyToCodeMap.ts` | Browser keyboard code → Android keycode mapping |
| `src/app/googDevice/android/KeyEvent.ts` | Android keycode and meta state constants |
| `src/app/googDevice/DragAndDropHandler.ts` | File drag-and-drop for APK push |
| `src/app/toolbox/ToolBox.ts` | Draggable/collapsible toolbar container |
| `src/app/toolbox/ToolBoxButton.ts` | Simple press button component (ACTION_DOWN/UP) |
| `src/app/toolbox/ToolBoxCheckbox.ts` | Toggle checkbox component |
| `src/app/googDevice/toolbox/GoogToolBox.ts` | Android-specific toolbar (buttons + audio mute) |
| `src/app/googDevice/toolbox/GoogMoreBox.ts` | Advanced settings panel |
| `src/app/MotionEvent.ts` | Android MotionEvent action/button constants |
| `src/app/ui/SvgImage.ts` | SVG icon registry |
| `src/style/app.css` | All application styles |

### Shared

| File | Purpose |
|------|---------|
| `src/packages/multiplexer/Multiplexer.ts` | WebSocket channel multiplexer |
| `src/packages/multiplexer/Message.ts` | Multiplexer binary message format |
| `src/app/VideoSettings.ts` | Video encoding parameters (serializable) |
| `src/app/ScreenInfo.ts` | Device screen geometry (25 bytes) |
| `src/app/DisplayInfo.ts` | Display metadata (24 bytes) |
| `src/app/Position.ts` | Screen coordinate type |
| `src/app/Point.ts` | Point with x, y |
| `src/app/Size.ts` | Size with width, height |
| `src/types/ParamsStreamScrcpy.ts` | Stream session parameters type |
| `vendor/Genymobile/scrcpy/scrcpy-server.jar` | scrcpy v3.1 server binary |
