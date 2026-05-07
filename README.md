# Sketchfab → Blender
## Setup (2 steps only!)

---

### Step 1 — Install the Blender Add-on

1. Open Blender
2. Go to **Edit → Preferences → Add-ons → Install…**
3. Select `blender-addon/sketchfab_bridge.py`
4. Tick the checkbox to enable it

✅ That's it for Blender. The server starts automatically inside Blender.

---

### Step 2 — Install the Browser Extension

**Chrome / Edge / Brave:**
1. Go to `chrome://extensions/`
2. Enable **Developer Mode** (top right)
3. Click **Load unpacked**
4. Select the `browser-extension/` folder

**Firefox:**
1. Go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `browser-extension/manifest.json`

---

### Step 3 — Add Your Sketchfab API Token (one time)

1. Go to **sketchfab.com/settings/password** → scroll to "API Token" → copy it
2. Click the extension icon in your browser → paste token → Save

---

### Done! How to use:

1. Open Blender (add-on starts the server automatically)
2. Go to any Sketchfab model page
3. Click the orange **"Import to Blender"** button
4. Model appears in Blender! 🎉

---

*Only works on models you have download rights to (free models, your own uploads, or purchased ones).*
