"""FastAPI bridge exposing the simulation engine to the browser UI (HTTP + WS)."""

import asyncio
import json
from typing import List
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from simulation.config.settings import settings
from simulation.engine_singleton import engine
from simulation.systems import swarm_system
app = FastAPI(title="Rescue Simulation API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_origin_regex=".*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve UI assets (so we don't need a separate http.server)
UI_ROOT = Path(__file__).resolve().parent.parent / "ui"
if UI_ROOT.exists():
    app.mount("/ui", StaticFiles(directory=UI_ROOT, html=True), name="ui")

@app.get("/")
def root_redirect():
    return RedirectResponse("/ui/simulation.html")

@app.get("/settings")
def get_settings():
    return settings.__dict__

@app.post("/settings")
def update_settings(payload: dict):
    """Update selected runtime settings (float fields)."""
    allowed = {
        "drain_per_unit": float,
        "scan_cost": float,
        "safety_margin": float,
        "wind_speed_kmh": float,
        "wind_angle_deg": float,
    }
    changes = {}
    for key, caster in allowed.items():
        if key in payload:
            try:
                val = caster(payload[key])
                setattr(settings, key, val)
                changes[key] = val
            except Exception:
                continue

    return {"status": "ok", "updated": changes, "settings": settings.__dict__}

@app.get("/state")
def get_state():
    return engine.get_world_state()

@app.get("/drones")
def get_drones():
    return engine.get_fleet_status()

@app.post("/commands/toggle_pause")
def cmd_pause(payload: dict = None):
    paused = None if not payload else payload.get("paused")
    return engine.toggle_pause(paused)

@app.post("/commands/reset")
def cmd_reset():
    return engine.reset_mission()

@app.post("/commands/start")
def cmd_start(payload: dict):
    return engine.start_mission(payload.get("survivor_count"), payload.get("active_drones"))

@app.post("/commands/thermal_scan")
def cmd_thermal_scan(payload: dict):
    did = payload.get("drone_id")
    sid = payload.get("sector_id")
    return engine.thermal_scan(did, sid)

@app.post("/telemetry")
def report_telemetry(payload: dict):
    """Receive drone telemetry from UI/controller and forward to engine."""
    if not payload:
        return {"error": "missing payload"}
    res = engine.update_drone_telemetry(
        payload.get("drone_id"),
        payload.get("battery"),
        payload.get("x"),
        payload.get("y"),
        payload.get("z"),
        payload.get("status"),
        payload.get("clear_target", False),
    )
    try:
        hazard_hit = res.get("hazard_hit") if isinstance(res, dict) else None
        if hazard_hit and hazard_hit.get("sector_id"):
            sid = hazard_hit["sector_id"]
            reason = f"hazard underfoot ({hazard_hit.get('hazard')})"
            engine.set_drone_target(payload.get("drone_id"), sid, reason)
            try:
                engine._record_hazard_redirect(payload.get("drone_id"), sid, reason)
            except Exception:
                pass
    except Exception:
        pass
    return res

class ConnectionManager:
    def __init__(self):
        self.active: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active:
            self.active.remove(websocket)

    async def broadcast(self, message: str):
        for ws in list(self.active):
            try:
                await ws.send_text(message)
            except Exception:
                self.disconnect(ws)

manager = ConnectionManager()

@app.websocket("/stream")
async def stream_state(ws: WebSocket):
    await manager.connect(ws)
    try:
        while True:
            payload = json.dumps(engine.get_world_state())
            await manager.broadcast(payload)
            await asyncio.sleep(0.2)
    except WebSocketDisconnect:
        manager.disconnect(ws)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("simulation.api.server:app", host="0.0.0.0", port=8000, reload=False)
