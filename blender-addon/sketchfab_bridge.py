bl_info = {
    "name": "BlendX",
    "author": "Eleeter",
    "version": (3, 0, 0),
    "blender": (3, 0, 0),
    "location": "View3D › Sidebar (N) › Sketchfab",
    "description": "Import Sketchfab models in one click from your browser",
    "category": "Import-Export",
}

import bpy
import threading
import json
import os
import zipfile
import tempfile
import queue
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = 7432
model_queue = queue.Queue()
_server = None
_server_thread = None
_progress = {}
_progress_lock = threading.Lock()


def set_progress(uid, status, pct, label=''):
    with _progress_lock:
        _progress[uid] = {"status": status, "pct": pct, "label": label}

def get_progress(uid):
    with _progress_lock:
        return dict(_progress.get(uid, {"status": "idle", "pct": 0, "label": ""}))


class BridgeHandler(BaseHTTPRequestHandler):

    def log_message(self, *args):
        pass

    def send_json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header('Content-Type',   'application/json')
        self.send_header('Content-Length',  str(len(body)))
        self.send_header('Access-Control-Allow-Origin',  '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_json(200, {})

    def do_GET(self):
        if self.path == '/status':
            self.send_json(200, {"status": "running"})
        elif self.path.startswith('/progress/'):
            uid = self.path.split('/')[-1]
            self.send_json(200, get_progress(uid))
        elif self.path == '/poll':
            try:
                self.send_json(200, model_queue.get_nowait())
            except queue.Empty:
                self.send_json(200, {"path": None})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != '/import':
            self.send_json(404, {"error": "not found"})
            return
        length = int(self.headers.get('Content-Length', 0))
        try:
            data = json.loads(self.rfile.read(length))
            uid = data.get('model_uid')
            token = data.get('api_token')
            fmt_pref = data.get('format', 'gltf')
        except Exception:
            self.send_json(400, {"error": "Bad request"})
            return

        if not uid or not token:
            self.send_json(400, {"error": "model_uid and api_token required"})
            return

        set_progress(uid, "starting", 1, "Getting model info…")
        threading.Thread(target=self._download, args=(uid, token, fmt_pref), daemon=True).start()
        self.send_json(200, {"success": True})

    def _download(self, uid, token, fmt_pref):
        try:

            req = urllib.request.Request(
                f"https://api.sketchfab.com/v3/models/{uid}/download",
                headers={"Authorization": f"Token {token}"}
            )
            with urllib.request.urlopen(req, timeout=15) as r:
                dl = json.loads(r.read())


            chosen_url  = None
            chosen_fmt  = None
            priority = [fmt_pref] + [f for f in ['gltf','fbx','obj','source'] if f != fmt_pref]
            for fmt in priority:
                if fmt in dl and dl[fmt].get('url'):
                    chosen_url = dl[fmt]['url']
                    chosen_fmt = fmt
                    break

            if not chosen_url:
                set_progress(uid, "error", 0, "No downloadable format found")
                model_queue.put({"error": "No downloadable format found"})
                return

            ext_map = {'gltf': '.glb', 'fbx': '.fbx', 'obj': '.obj', 'source': '.zip'}
            dl_ext  = ext_map.get(chosen_fmt, '.zip')
            size = dl[chosen_fmt].get('size', 0)
            size_mb = f"{size/1024/1024:.1f} MB" if size else ""

            set_progress(uid, "downloading", 5,
                         f"Downloading {chosen_fmt.upper()} {size_mb}…")


            tmp = tempfile.NamedTemporaryFile(suffix='.zip', delete=False)
            tmp.close()
            done = [0]

            def hook(blocks, block_size, total):
                done[0] += block_size
                if total > 0:
                    pct = min(93, int(done[0] / total * 88) + 5)
                    mb_done = done[0] / 1024 / 1024
                    mb_tot  = total  / 1024 / 1024
                    lbl = f"Downloading… {mb_done:.1f} / {mb_tot:.1f} MB"
                else:
                    pct = min(90, 5 + int(done[0] / 1024 / 1024 * 2))
                    lbl = f"Downloading… {done[0]/1024/1024:.1f} MB"
                set_progress(uid, "downloading", pct, lbl)

            urllib.request.urlretrieve(chosen_url, tmp.name, hook)
            set_progress(uid, "extracting", 95, "Extracting…")

            # 4. Extract
            model_file = None
            try:
                extract_dir = tempfile.mkdtemp(prefix='sfab_')
                with zipfile.ZipFile(tmp.name, 'r') as zf:
                    zf.extractall(extract_dir)
                os.remove(tmp.name)
                for root, _, files in os.walk(extract_dir):
                    for f in files:
                        if f.endswith(('.glb', '.gltf', '.fbx', '.obj')):
                            model_file = os.path.join(root, f)
                            break
                    if model_file:
                        break
            except zipfile.BadZipFile:
                model_file = tmp.name.replace('.zip', dl_ext)
                try:
                    os.rename(tmp.name, model_file)
                except Exception:
                    model_file = tmp.name

            if not model_file or not os.path.exists(model_file):
                set_progress(uid, "error", 0, "Extraction failed")
                model_queue.put({"error": "Extraction failed"})
                return

            ext = os.path.splitext(model_file)[1]
            set_progress(uid, "importing", 99, "Sending to Blender…")
            model_queue.put({"path": model_file, "ext": ext, "uid": uid})

        except urllib.error.HTTPError as e:
            msg = ("Bad API token" if e.code == 401
                   else "No download permission" if e.code == 403
                   else f"HTTP {e.code}")
            set_progress(uid, "error", 0, msg)
            model_queue.put({"error": msg})
        except Exception as e:
            set_progress(uid, "error", 0, str(e))
            model_queue.put({"error": str(e)})



def start_server():
    global _server, _server_thread
    if _server:
        return
    try:
        _server = HTTPServer(('localhost', PORT), BridgeHandler)
        _server_thread = threading.Thread(target=_server.serve_forever, daemon=True)
        _server_thread.start()
        print(f"[Sketchfab Bridge] Running on localhost:{PORT}")
    except OSError as e:
        print(f"[Sketchfab Bridge] Could not start: {e}")

def stop_server():
    global _server, _server_thread
    if _server:
        _server.shutdown()
        _server = None
        _server_thread = None



def _poll_timer():
    try:
        props = bpy.context.scene.sfab_bridge
    except AttributeError:
        return 1.5

    try:
        item = model_queue.get_nowait()
    except queue.Empty:
        return 1.5

    if "error" in item:
        props.status = f"❌ {item['error']}"
        return 1.5

    filepath = item.get("path")
    ext = item.get("ext", ".glb")
    uid = item.get("uid", "")

    if not filepath or not os.path.exists(filepath):
        props.status = "❌ File missing"
        return 1.5

    props.status = f"⏳ Importing…"
    try:
        _do_import(filepath, ext)
        fname = os.path.splitext(os.path.basename(filepath))[0][:30]
        props.status = f"✅ Done — {fname}"
        if uid: set_progress(uid, "done", 100, "Imported into Blender!")
    except Exception as e:
        props.status = f"❌ {e}"
        if uid: set_progress(uid, "error", 0, str(e))
    finally:
        try:
            os.remove(filepath)
            parent = os.path.dirname(filepath)
            if 'sfab_' in os.path.basename(parent):
                import shutil; shutil.rmtree(parent, ignore_errors=True)
        except Exception:
            pass

    return 1.5


def _do_import(filepath, ext):
    ext = ext.lower()
    if ext in ('.glb', '.gltf'):
        bpy.ops.import_scene.gltf(filepath=filepath)
    elif ext == '.fbx':
        bpy.ops.import_scene.fbx(filepath=filepath)
    elif ext == '.obj':
        try:
            bpy.ops.wm.obj_import(filepath=filepath)
        except AttributeError:
            bpy.ops.import_scene.obj(filepath=filepath)
    else:
        raise ValueError(f"Unsupported format: {ext}")



class SFAB_PT_Panel(bpy.types.Panel):
    bl_label = "BlendX"; bl_idname = "VIEW3D_PT_sfab"
    bl_space_type = 'VIEW_3D'; bl_region_type = 'UI'; bl_category = 'BlendX'

    def draw(self, context):
        l = self.layout
        l.box().label(text="Server running ✅" if _server else "Server offline ❌",
                      icon='CHECKMARK' if _server else 'X')
        l.operator("sfab.stop_server" if _server else "sfab.start_server")
        l.separator()
        l.box().label(text=context.scene.sfab_bridge.status, icon='INFO')

class SFAB_OT_Start(bpy.types.Operator):
    bl_idname = "sfab.start_server"; bl_label = "Start Server"
    def execute(self, context):
        start_server(); context.scene.sfab_bridge.status = "Ready"; return {'FINISHED'}

class SFAB_OT_Stop(bpy.types.Operator):
    bl_idname = "sfab.stop_server"; bl_label = "Stop Server"
    def execute(self, context):
        stop_server(); context.scene.sfab_bridge.status = "Stopped"; return {'FINISHED'}

class SFAB_Props(bpy.types.PropertyGroup):
    status: bpy.props.StringProperty(default="Ready — waiting for models…")

CLASSES = [SFAB_Props, SFAB_OT_Start, SFAB_OT_Stop, SFAB_PT_Panel]

def register():
    for c in CLASSES: bpy.utils.register_class(c)
    bpy.types.Scene.sfab_bridge = bpy.props.PointerProperty(type=SFAB_Props)
    start_server()
    if not bpy.app.timers.is_registered(_poll_timer):
        bpy.app.timers.register(_poll_timer, first_interval=2.0, persistent=True)

def unregister():
    if bpy.app.timers.is_registered(_poll_timer): bpy.app.timers.unregister(_poll_timer)
    stop_server()
    del bpy.types.Scene.sfab_bridge
    for c in reversed(CLASSES): bpy.utils.unregister_class(c)

if __name__ == "__main__": register()
