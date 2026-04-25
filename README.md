## Rescue Swarm Simulation

Autonomous multi‑drone search‑and‑rescue simulator with a shared Python core, MCP tools, and a browser-based 3D UI.

### System Overview

- **Simulation Engine** (`simulation/systems/simulation_engine.py`): Source of truth for sectors, hazards, survivors, drones; enforces battery drain, scan/thermal state, and mission metrics.
- **API Bridge** (`simulation/api/server.py`): FastAPI HTTP/WS surface to expose engine state/commands to the browser UI and external controllers.
- **MCP Server** (`mcp_system/mcp_server.py`): Exposes the engine as MCP tools; handles hazard redirects and assignment dispatch.
- **Swarm / Orchestrator** (`simulation/systems/swarm_system.py`, `agents/orchestrator.py`): Scores hazards, enforces battery feasibility and duplicate suppression; orchestrator triggers plans (LLM via Groq when available, heuristic fallback otherwise).
- **UI / 3D Client** (`simulation/ui/`): Three.js visualizer, HUD, minimap; drives client-side movement, thermal scans on arrival, overlays.
- **Logs** (`logs/`): MCP/Orchestrator logs; UI mission log shown in the HUD.

### Setup

```bash
pip install -r requirements.txt
```

Env you’ll want set before running:

```bash
export ANTHROPIC_API_KEY=apikey
```

### One-command local run

```
./scripts/run_unified.sh
```

Starts API on :8000 and serves the UI on :8001 (http://localhost:8001/simulation.html).

### Main Drone Loop (UI-driven movement)

1) MCP assigns a target; UI moves the drone toward `targetPos` at `MOVE_SPEED`.
2) On arrival, UI calls `thermal_scan`; server marks `thermal_scanned`, applies scan battery cost, and logs arrival.
3) While scanning, assignments/redirects are ignored; status stays `scanning`.
4) After scan completes, swarm may retarget; UI resumes movement. Battery drains per move (UI) and per scan (engine).
5) Telemetry (`report_telemetry`) keeps server state/battery in sync every `TELEMETRY_INTERVAL`.

### Swarm assignment behavior

- Hazard-weighted scoring (fire > smoke > unknown) with sector bonuses; battery feasibility (round-trip + scan + safety margin).
- One drone per target; duplicate suppression and cooldowns for hazard redirects; target locks to reduce oscillation.
- Immediate scan when a drone stands on a hazard; patrol spread when no hazards exist.

### Coverage vs Discovery

- **Coverage** = sectors with `thermal_scanned == true` (thermal scan completed). HUD coverage and `H` overlay use this.
- **Discovery** = sectors first seen (passive or scan) even if not thermal scanned.
- UI tinting: thermal-scanned sectors are high-contrast lime/amber; discovered-only sectors are muted; base tiles stay dark.

### Orchestrator & Swarm (current behavior)

- Orchestrator polls MCP world state every ~1s (`ORCHESTRATOR_INTERVAL`); calls LLM only on crucial changes. Falls back to heuristic if no `GROQ_API_KEY`.
- Plans are pushed via `set_plan`; swarm pulls `latest_plan` for assignments.
- Logs: `logs/` for orchestrator + MCP; `Logs/` for swarm.
- LLM: Groq chat completions when `GROQ_API_KEY` is set (model `llama-3.1-8b-instant` by default, override via `GROQ_MODEL`). Without the key, orchestrator runs heuristic-only.

### API quick reference

- `GET /settings` — simulation constants shared with UI.
- `GET /state` — full world snapshot.
- `GET /drones` — fleet status.
- `POST /commands/move` `{id,x,y,z}`
- `POST /commands/scan` `{id,sector_id}`
- `POST /commands/set_target` `{id,sector_id,reason}`
- `POST /commands/add_drone` `{id?,x?,z?}`
- `POST /commands/toggle_pause` `{paused?}`
- `POST /commands/reset`
- `POST /commands/start` `{survivor_count?,active_drones?}`
- `WS /stream` — push state at ~5 Hz.

### MCP tools (shared engine)

- `get_all_drones`, `get_drone_status`
- `move_drone_to`, `scan_sector`, `thermal_scan_of_drone`
- `get_known_hazard_coordinates`
- `toggle_pause`, `get_mission_summary`

### Code map (UI)

- `js/main.js` — orchestrator wiring.
- `js/state.js` — UI state factory (includes world defaults).
- `js/utils.js` — helpers/constants.
- `js/api.js` — MCP client wrapper.
- `js/hud.js` — top-bar & controls wiring.
- `js/minimap.js` — 2D map rendering.
- `js/logs.js` — thought/MCP log rendering.

### Dev tips

- All runtime state flows from `SimulationEngine`; avoid duplicating sources.
- Use MCP or API, not ad-hoc mocks, when driving drones from new agents.
- Tick rate and battery semantics live in `SimulationEngine`; keep UI in “read-only” mode except for user commands.

### Testing (manual)

- Start mission; confirm drones move and battery decreases over time and per move.
- Arrival triggers thermal scan; status remains `scanning` during the 3s scan, then returns to `idle`.
- While scanning, hazard redirects are ignored; after scan, swarm may retarget.
- Coverage metrics reflect thermal scans (not just discovered); HUD and 2D map show thermal overlay when `H` is toggled.
- Invoke MCP tools (`move_drone_to`, `thermal_scan_of_drone`) and confirm UI reflects changes.
- Resize browser; renderer should adapt without errors.
