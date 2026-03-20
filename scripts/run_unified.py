#!/usr/bin/env python
"""
Run API (FastAPI), MCP server, and serve the UI from one process with a shared SimulationEngine.

Ports (env):
  API_PORT (default 8000)
  MCP_PORT (default 8002)
"""

import os
import sys
import threading
import argparse
from pathlib import Path

import uvicorn

# Ensure repo root on sys.path so "simulation" imports work when run as ./scripts/run_unified.py
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
    
from simulation.api.server import app  # reuses shared engine & serves UI
from mcp_system.mcp_server import mcp
import agents.orchestrator as orchestrator


def start_mcp(port: int):
    mcp.settings.host = "0.0.0.0"
    mcp.settings.port = port
    mcp.run(transport="streamable-http")

def start_orchestrator(interval: float):
    try:
        orchestrator.orchestrate(loop=True, interval=interval)
    except Exception as exc:
        print(f"[run_unified] Orchestrator stopped: {exc}", file=sys.stderr)

if __name__ == "__main__":
    LOG_DIR = ROOT / "logs"
    LOG_DIR.mkdir(exist_ok=True)

    # Clear logs
    for name in ["orchestrator.log", "mcp_server.log", "swarm_system.log", "engine.log"]:
        try:
            (LOG_DIR / name).unlink(missing_ok=True)
        except Exception:
            pass
    try:
        for p in LOG_DIR.glob("drone_*.log"):
            p.unlink(missing_ok=True)
    except Exception:
        pass

    parser = argparse.ArgumentParser(description="Run API + UI + MCP in one process (shared engine).")
    parser.add_argument("--api-port", type=int, default=int(os.getenv("API_PORT", "8000")), help="HTTP API/UI port (default 8000)")
    parser.add_argument("--mcp-port", type=int, default=int(os.getenv("MCP_PORT", "8002")), help="MCP port (default 8002)")
    parser.add_argument("--orch-interval", type=float, default=float(os.getenv("ORCHESTRATOR_INTERVAL", "1.0")), help="Orchestrator loop interval seconds (default 1.0)")
    args = parser.parse_args()

    print("------------------------------------------------------------")
    print(f"API/UI        : http://localhost:{args.api_port}/ui/simulation.html")
    print(f"API base      : http://localhost:{args.api_port}")
    print(f"MCP endpoint  : http://localhost:{args.mcp_port}/mcp")
    print(f"Orchestrator  : interval={args.orch_interval}s log=logs/orchestrator.log")
    print("Ctrl+C to stop.")
    print("------------------------------------------------------------")

    t = threading.Thread(target=start_mcp, args=(args.mcp_port,), daemon=True)
    t.start()

    t_orch = threading.Thread(target=start_orchestrator, args=(args.orch_interval,), daemon=True)
    t_orch.start()

    uvicorn.run(app, host="0.0.0.0", port=args.api_port, reload=False)
