# BlendX — Full System Workflow & Data Transfer Docs

> A deep-dive into how every component talks to every other component, from browser click to Blender scene.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Component Map](#2-component-map)
3. [Startup Sequence](#3-startup-sequence)
4. [The Full Import Flow (Step by Step)](#4-the-full-import-flow-step-by-step)
5. [Data Transfer Details](#5-data-transfer-details)
6. [Progress Tracking System](#6-progress-tracking-system)
7. [Format Selection Logic](#7-format-selection-logic)
8. [File Lifecycle](#8-file-lifecycle)
9. [Error Handling](#9-error-handling)
10. [Threading Model](#10-threading-model)
11. [SPA Navigation Handling](#11-spa-navigation-handling)
12. [Security Boundaries](#12-security-boundaries)

---

## 1. Architecture Overview

```
┌─────────────────────────────────┐        ┌──────────────────────────────────┐
│         BROWSER                 │        │            BLENDER               │
│                                 │        │                                  │
│  ┌─────────────┐                │        │  ┌────────────────────────────┐  │
│  │ popup.html  │  (user saves   │        │  │   sketchfab_bridge.py      │  │
│  │ popup.js    │   API token)   │        │  │   (__init__.py addon)      │  │
│  └─────────────┘                │        │  │                            │  │
│         │                       │        │  │  ┌──────────────────────┐  │  │
│         │ chrome.storage.sync   │        │  │  │  HTTPServer          │  │  │
│         ▼                       │        │  │  │  localhost:7432      │  │  │
│  ┌─────────────┐  POST /import  │        │  │  │                      │  │  │
│  │ content.js  │ ─────────────────────►  │  │  │  BridgeHandler       │  │  │
│  │             │ ◄─────────────────────  │  │  └──────────────────────┘  │  │
│  │  (injected  │  GET /progress │        │  │         │                  │  │
│  │   into      │  GET /status   │        │  │         │ threading        │  │
│  │  sketchfab) │                │        │  │         ▼                  │  │
│  └─────────────┘                │        │  │  ┌──────────────────────┐  │  │
│                                 │        │  │  │  Download Thread     │  │  │
│                                 │        │  │  │  (urllib.request)    │  │  │
│                                 │        │  │  └──────────────────────┘  │  │
│                                 │        │  │         │                  │  │
│                                 │        │  │         ▼                  │  │
│                                 │        │  │  ┌──────────────────────┐  │  │
│                                 │        │  │  │   model_queue        │  │  │
│                                 │        │  │  │   (Queue object)     │  │  │
│                                 │        │  │  └──────────────────────┘  │  │
│                                 │        │  │         │                  │  │
│                                 │        │  │         ▼                  │  │
│                                 │        │  │  ┌──────────────────────┐  │  │
│                                 │        │  │  │  _poll_timer()       │  │  │
│                                 │        │  │  │  (bpy.app.timers)    │  │  │
│                                 │        │  │  │  runs every 1.5s     │  │  │
│                                 │        │  │  └──────────────────────┘  │  │
│                                 │        │  │         │                  │  │
│                                 │        │  │         ▼                  │  │
│                                 │        │  │  ┌──────────────────────┐  │  │
│                                 │        │  │  │   bpy.ops.import_*   │  │  │
│                                 │        │  │  │   (scene import)     │  │  │
│                                 │        │  │  └──────────────────────┘  │  │
│                                 │        └──────────────────────────────────┘
└─────────────────────────────────┘

       External: Sketchfab API (api.sketchfab.com/v3)
```

---

## 2. Component Map

| File | Where it runs | Role |
|---|---|---|
| `__init__.py` (addon) | Blender Python runtime | HTTP server, download engine, Blender importer |
| `content.js` | Browser (injected into sketchfab.com) | UI injection, triggers import, polls progress |
| `popup.html` / `popup.js` | Browser extension popup | Token management, server status check |
| `manifest.json` | Browser extension loader | Declares permissions, scripts, icons |

---

## 3. Startup Sequence

### Blender Side

```
Blender launches
      │
      ▼
register() called by Blender
      │
      ├─► register all bpy classes (Panel, Operators, PropertyGroup)
      │
      ├─► attach sfab_bridge property to bpy.types.Scene
      │
      ├─► start_server()
      │       └─► HTTPServer('localhost', 7432)
      │       └─► serve_forever() in daemon thread
      │
      └─► bpy.app.timers.register(_poll_timer, first_interval=2.0, persistent=True)
              └─► fires every 1.5s forever (persistent = survives file open/close)
```

### Browser Side

```
User navigates to sketchfab.com
      │
      ▼
content.js injected at document_idle
      │
      ▼
maybeRebuild() called immediately
+ again at +1.5s and +3.5s (handles slow SPA loads)
      │
      ▼
MutationObserver watching document.documentElement
      └─► calls maybeRebuild() on any DOM change
```

---

## 4. The Full Import Flow (Step by Step)

```
STEP 1 — User opens a Sketchfab model page
─────────────────────────────────────────────────────
content.js → getUID()
  Tries 3 strategies to extract the 32-char hex model UID:
  1. Regex on window.location.pathname  → /-([a-f0-9]{32})/
  2. iframe[src] inside overlay modals
  3. Anchor tag href inside overlay/modal containers

  If UID found → buildUI() is called


STEP 2 — UI is injected into the page
─────────────────────────────────────────────────────
buildUI() creates a Shadow DOM host element
  (Shadow DOM prevents Sketchfab's CSS from bleeding in)

  Elements created:
  ├── Format chip buttons (GLB / FBX / OBJ / Source)
  └── "Import to Blender" orange button
        ├── Top row: Blender logo SVG + label
        ├── Subtitle: format name + file size
        └── Progress bar (hidden initially)

  loadFormats(uid) is called immediately to pre-fetch available formats


STEP 3 — Format pre-loading
─────────────────────────────────────────────────────
content.js → GET https://api.sketchfab.com/v3/models/{uid}/download
  Headers: { Authorization: "Token {userToken}" }

  Response shape:
  {
    "gltf":   { "url": "https://...", "size": 1234567 },
    "fbx":    { "url": "https://...", "size": 2345678 },
    "obj":    { "url": null },          ← null = not available
    "source": { "url": "https://..." }
  }

  availableFmts is populated with only keys that have a url.
  Format chips rendered with file sizes shown (e.g. "GLB 12MB").
  First available format is auto-selected.


STEP 4 — User clicks "Import to Blender"
─────────────────────────────────────────────────────
handleClick() fires
  ├── Guard: if busy → return (prevents double-import)
  ├── Check: uid exists?
  ├── Check: token in chrome.storage.sync?
  └── Check: selectedFmt set?

  Retry loop: GET http://localhost:7432/status  (up to 3 attempts, 900ms apart)
    → If all fail: toast "❌ Blender is not open!"
    → If ok: proceed


STEP 5 — Import request sent to Blender
─────────────────────────────────────────────────────
content.js → POST http://localhost:7432/import
  Body (JSON):
  {
    "model_uid": "a1b2c3...32chars",
    "api_token": "user's sketchfab token",
    "format":    "gltf"              ← user-selected
  }

  BridgeHandler.do_POST() receives this.
  Validates: uid and token must be present.
  Calls set_progress(uid, "starting", 1, "Getting model info…")
  Spawns daemon thread: threading.Thread(target=self._download, ...)
  Returns immediately: { "success": true }


STEP 6 — Download thread runs in Blender
─────────────────────────────────────────────────────
BridgeHandler._download(uid, token, fmt_pref):

  6a. Fetch download URLs from Sketchfab API
      GET https://api.sketchfab.com/v3/models/{uid}/download
      Headers: { Authorization: "Token {token}" }

  6b. Format priority resolution:
      [fmt_pref, ...remaining in order: gltf, fbx, obj, source]
      First format with a valid url wins → chosen_fmt, chosen_url

  6c. Download file to temp path
      urllib.request.urlretrieve(chosen_url, tmp.name, hook)
      Progress hook updates _progress[uid] every block

  6d. Extract ZIP
      ZipFile(tmp.name).extractall(extract_dir)
      Walk extracted files for .glb / .gltf / .fbx / .obj
      If BadZipFile → file was already raw format, rename it

  6e. Push to queue
      model_queue.put({ "path": model_file, "ext": ext, "uid": uid })


STEP 7 — Progress polling (browser side)
─────────────────────────────────────────────────────
After step 5 succeeds, content.js starts:
  setInterval(() => pollProgress(uid), 700ms)

  Each poll: GET http://localhost:7432/progress/{uid}
  Response: { "status": "downloading", "pct": 42, "label": "Downloading… 8.3 / 19.7 MB" }

  UI updates:
  ├── Button label → progress label
  ├── Progress bar width → pct%
  └── On status "done" → green button, toast, reset after 5s
      On status "error" → toast error message


STEP 8 — Blender timer picks up the file
─────────────────────────────────────────────────────
_poll_timer() runs every 1.5s (bpy.app.timers, main thread)

  model_queue.get_nowait()
    → Empty → return 1.5 (reschedule)
    → Got item:
        ├── "error" key → set props.status = "❌ ..."
        └── valid item:
              _do_import(filepath, ext)
                ├── .glb/.gltf → bpy.ops.import_scene.gltf()
                ├── .fbx       → bpy.ops.import_scene.fbx()
                └── .obj       → bpy.ops.wm.obj_import()  (fallback to import_scene.obj)

              set_progress(uid, "done", 100, "Imported into Blender!")
              props.status = "✅ Done — {filename}"

              Cleanup: os.remove(filepath), shutil.rmtree(extract_dir)
```

---

## 5. Data Transfer Details

### Browser → Blender (POST /import)

```json
{
  "model_uid": "a1b2c3d4e5f6...",   // 32-char hex, extracted from page URL
  "api_token": "abc123...",          // from chrome.storage.sync
  "format":    "gltf"                // user-selected chip
}
```

Response:
```json
{ "success": true }
// or
{ "error": "model_uid and api_token required" }
```

### Browser → Blender (GET /progress/{uid})

Response:
```json
{
  "status": "downloading",           // idle | starting | downloading | extracting | importing | done | error
  "pct":    57,                      // 0–100
  "label":  "Downloading… 11.2 / 19.7 MB"
}
```

### Blender → Sketchfab API

```
GET https://api.sketchfab.com/v3/models/{uid}/download
Authorization: Token {token}

→ Returns signed S3 download URLs per format, valid for a limited time
```

### All HTTP responses include CORS headers:
```
Access-Control-Allow-Origin:  *
Access-Control-Allow-Headers: Content-Type
Access-Control-Allow-Methods: GET, POST, OPTIONS
```
This is required because the browser extension's fetch calls are cross-origin to `localhost:7432`.

---

## 6. Progress Tracking System

Progress is stored in a shared dict protected by a `threading.Lock`:

```python
_progress = {}           # { uid: { status, pct, label } }
_progress_lock = threading.Lock()
```

**Why a lock?**
The download runs in a daemon thread, but `GET /progress/{uid}` is served by the HTTP handler (also a thread). Without the lock, reads and writes could race.

**Progress stages:**

| Stage | pct | Who sets it |
|---|---|---|
| `starting` | 1 | do_POST (before thread spawns) |
| `downloading` | 5 → 93 | hook() inside urlretrieve |
| `extracting` | 95 | _download, after urlretrieve |
| `importing` | 99 | _download, before queue.put |
| `done` | 100 | _poll_timer, after bpy.ops |
| `error` | 0 | any failure point |

**Progress bar math (downloading):**
```python
pct = min(93, int(bytes_done / total_bytes * 88) + 5)
# Maps 0%→5% baseline, 100%→93%
# Leaves 93–99% for extract, 99–100% for import
```

---

## 7. Format Selection Logic

### Browser side (pre-fetch)
```
Sketchfab API returns available formats for this model.
content.js tries keys in order: gltf → fbx → obj → source
Chips are shown only for formats with a non-null URL.
User can click chips to change selection before importing.
```

### Blender side (fallback)
```python
priority = [fmt_pref] + [f for f in ['gltf','fbx','obj','source'] if f != fmt_pref]
# If user chose 'fbx' → tries ['fbx', 'gltf', 'obj', 'source']
# Falls back down the list if chosen format has no URL
```

This double-check exists because the download URL can expire between the pre-fetch and the actual import request.

---

## 8. File Lifecycle

```
[Sketchfab S3] ──download──► [tmp .zip file]
                                    │
                              ZipFile.extractall()
                                    │
                              [tempdir sfab_XXXXX/]
                                    │
                              walk for .glb/.gltf/.fbx/.obj
                                    │
                              model_queue.put(path)
                                    │
                              _poll_timer reads queue
                                    │
                              bpy.ops.import_scene.*
                                    │
                              os.remove(model_file)
                              shutil.rmtree(sfab_XXXXX/)
```

- Temp files go to the OS temp directory (`tempfile.gettempdir()`)
- All temp files are cleaned up whether import succeeds or fails (inside `finally` block)
- If the downloaded file is not a ZIP (e.g. raw `.glb`), it's renamed to the correct extension and imported directly

---

## 9. Error Handling

| Where | What can fail | Response |
|---|---|---|
| `do_POST` | Bad JSON body | HTTP 400 `{"error": "Bad request"}` |
| `do_POST` | Missing uid/token | HTTP 400 |
| `_download` | HTTP 401 from Sketchfab | status `error`, label `"Bad API token"` |
| `_download` | HTTP 403 from Sketchfab | status `error`, label `"No download permission"` |
| `_download` | No downloadable format | status `error`, label `"No downloadable format found"` |
| `_download` | Bad ZIP | Falls back to direct rename, tries to import as raw |
| `_download` | No model file found after extract | status `error`, label `"Extraction failed"` |
| `_poll_timer` | File missing on disk | `props.status = "❌ File missing"` |
| `_poll_timer` | bpy.ops throws | `props.status = "❌ {exception}"` |
| `content.js` | Blender not running | Toast: "❌ Blender is not open!" |
| `content.js` | Token not set | Toast: "Add your API token…" |
| `content.js` | Model not downloadable | Subtitle: "🔒 Not downloadable" |

---

## 10. Threading Model

Blender's Python runs on the **main thread**. You cannot call `bpy.ops.*` from a background thread — it will crash or silently fail.

BlendX solves this with a **queue-based handoff**:

```
Background Thread          Queue              Main Thread (timer)
──────────────────        ───────            ───────────────────
_download() runs    ──►  model_queue  ──►   _poll_timer() reads
(download, extract)       .put(item)         .get_nowait()
Can't touch bpy                              Calls bpy.ops.*  ✅
```

`bpy.app.timers.register(_poll_timer, persistent=True)` ensures the timer:
- Runs on the main thread ✅
- Persists across file open/close ✅
- Re-schedules itself by returning `1.5` (seconds until next call)

---

## 11. SPA Navigation Handling

Sketchfab is a React SPA. URLs change without full page reloads, and models can open in overlay modals without changing the URL at all.

BlendX handles this with three layers:

```javascript
// Layer 1: MutationObserver — fires on ANY DOM change
new MutationObserver(maybeRebuild)
  .observe(document.documentElement, { childList: true, subtree: true });

// Layer 2: Interval fallback — catches URL changes MutationObserver misses
setInterval(() => {
  if (location.pathname !== lastPath) maybeRebuild();
}, 500);

// Layer 3: Delayed retries — handles slow initial renders
setTimeout(maybeRebuild, 1500);
setTimeout(maybeRebuild, 3500);
```

`maybeRebuild()` logic:
```
1. Extract current UID from page
2. If pathname changed → reset state, clear poll timer
3. If UID changed → rebuild entire UI for new model
4. If no UID but UI exists → remove UI (user left model page)
```

Shadow DOM is reused across rebuilds (host element persists), only `#sfab-root` is removed and recreated.

---

## 12. Security Boundaries

| Concern | How it's handled |
|---|---|
| API token storage | `chrome.storage.sync` — not localStorage, synced across user's Chrome instances |
| API token in transit | Sent over `localhost` HTTP only — never leaves the machine via BlendX |
| Token never logged | `BridgeHandler.log_message()` is a no-op — nothing is printed |
| CORS wildcard | `Access-Control-Allow-Origin: *` is intentional — server only binds to `localhost`, not exposed to network |
| Temp file cleanup | `finally` block ensures cleanup even on import failure |
| No persistent token in Blender | Token is passed per-request, never stored by the addon |
| Shadow DOM isolation | Extension UI cannot be styled or accessed by Sketchfab's page scripts |

---

## Quick Reference: API Endpoints

| Method | Path | Body / Params | Returns |
|---|---|---|---|
| `GET` | `/status` | — | `{"status": "running"}` |
| `GET` | `/progress/{uid}` | uid in path | `{"status", "pct", "label"}` |
| `GET` | `/poll` | — | `{"path": ...}` or `{"path": null}` |
| `POST` | `/import` | `{model_uid, api_token, format}` | `{"success": true}` or `{"error": "..."}` |
| `OPTIONS` | `*` | — | `200 {}` (CORS preflight) |

---

*BlendX by Eleeter — v3.0.0*