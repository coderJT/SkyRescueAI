"""
Our MCP server lives here. It exposes the simulation environment in the form of tools to be used by the MCP server.
Note that the biggest purpose of this class is not just a bare MCP tool, but a bridge between our simulation environment 
(regardless of 2D/3D) and our key decision makers - LLM itself. In other words, we should expose our simulation as 
controllable tools with maximum observability to ensure rescue and implementation efficiency.
"""

import logging
import math
from pathlib import Path

from mcp.server.fastmcp import FastMCP
from simulation.engine_singleton import engine
from simulation.systems import swarm_system
from simulation.systems.swarm_system import _drone_logger
import time


LOG_PATH = Path(__file__).resolve().parent.parent / "logs" / "mcp_server.log"
LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
logger = logging.getLogger("mcp_server")
if not logger.handlers:
    logger.setLevel(logging.DEBUG)
    fh = logging.FileHandler(LOG_PATH, encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    logger.addHandler(fh)
    logger.propagate = False


def _hz_weight(h: str | None):
    """Priority weight for hazards (fire > smoke > unknown/none)."""
    if not h:
        return 0
    lower = h.lower()
    if lower == "fire":
        return 3
    if lower == "smoke":
        return 2
    return 1

def _log_tool(name, args, result=None):
    """
    Logger tool.
    """
    logger.info("tool=%s args=%s", name, args)
    if result is not None:
        logger.debug("tool=%s result=%s", name, result)
    try:
        engine.log(f"🛠 MCP {name} args={args} result={(result or {}).get('status') if isinstance(result, dict) else 'ok'}")
    except Exception:
        pass

mcp = FastMCP("Rescue Drone Server")
latest_plan: dict | None = None
latest_assignments: dict[str, dict] = {}
drone_priorities: dict[str, str] = {}
_hazard_redirect_cooldown: dict[str, dict] = {}
_hazard_target_prio: dict[str, int] = {}


def _record_target_prio(drone_id: str, sector_id: str | None):
    """Store the hazard priority of the current target for downgrade checks."""
    try:
        if not sector_id or sector_id == "__RECALL__":
            _hazard_target_prio.pop(drone_id, None)
            return
        sector = engine.sectors.get(sector_id, {})
        hz = sector.get("hazard") or sector.get("true_hazard")
        _hazard_target_prio[drone_id] = _hz_weight(hz)
    except Exception:
        pass

@mcp.tool()
def set_plan(plan: dict):
    """
    Store the latest LLM/strategy plan so swarm assignments can use it.
    """
    global latest_plan
    latest_plan = plan or {}
    _log_tool("set_plan", {}, {"stored": True, "has_priorities": bool(plan.get("priorities") if plan else False)})
    try:
        strategy = plan.get("strategy") if plan else None
        llm_model = plan.get("llm_model") if plan else None
        engine.log(f"🧠 STRATEGY: {strategy or 'n/a'} | model={llm_model or 'heuristic'} | priorities={plan.get('priorities') if plan else []}")
    except Exception:
        pass
    return {"status": "ok"}

@mcp.tool()
def recall_drone(drone_id: str):
    """
    Recall a specific drone.
    """
    res = engine.recall_for_charging(drone_id)
    _log_tool("recall_drone", {"drone_id": drone_id}, res)
    return res

@mcp.tool()
def get_all_drones():
    """
    Get all fleet of drones.
    """
    res = engine.list_drones()
    _log_tool("get_all_drones", {}, res)
    return res

@mcp.tool()
def get_drone_status(id):
    """
    Get individual drone status.
    """
    res = engine.get_drone_status(id)
    _log_tool("get_drone_status", {"id": id}, res)
    return res

@mcp.tool()
def move_drone_to(id, x, y, z):
    """
    Move a drone to a specific coordinate.
    """
    res = engine.move_to(id, x, y, z)
    _log_tool("move_drone_to", {"id": id, "x": x, "y": y, "z": z}, res)
    return res

@mcp.tool()
def thermal_scan_of_drone(id, sector_id=None):
    """
    Perform thermal detection for a specific coordinate.
    """
    res = engine.thermal_scan(id, sector_id)
    _log_tool("thermal_scan_of_drone", {"id": id, "sector_id": sector_id}, res)
    return res

@mcp.tool()
def scan_sector(id, sector_id):
    """
    Scan a sector a detect for signs of hazard.
    """
    res = engine.scan_sector(id, sector_id)
    _log_tool("scan_sector", {"id": id, "sector_id": sector_id}, res)
    return res

@mcp.tool()
def get_known_hazard_coordinates():
    """
    Get known hazard coordinates. Note that current computation is expensive at O(N), since we need to go through
    every single coordinate per hazard type. Ideally, we should split sector into truth sector and discovered sector.
    """
    world = engine.get_world_state()
    hazards = {
        "fire": [sid for sid, s in world.get("sectors", {}).items() if s.get("hazard") == "fire"],
        "smoke": [sid for sid, s in world.get("sectors", {}).items() if s.get("hazard") == "smoke"],
    }
    res = {"hazards": hazards, "wind": world.get("wind"), "grid_size": world.get("grid_size")}
    _log_tool("get_known_hazard_coordinates", {}, res)
    return res

@mcp.tool()
def toggle_pause(paused: bool = None):
    """
    Toggle pause of simulation.
    """
    res = engine.toggle_pause(paused)
    _log_tool("toggle_pause", {"paused": paused}, res)
    return res

@mcp.tool()
def get_mission_summary():
    """
    Get mission summary.
    """
    res = engine.get_mission_summary()
    _log_tool("get_mission_summary", {}, res)
    return res

@mcp.tool()
def get_world_state():
    """
    Return the full simulation snapshot.
    """
    res = engine.get_world_state()
    _log_tool("get_world_state", {}, {"sectors": len(res.get("sectors", {})), "drones": len(res.get("drones", {}))})
    return res

@mcp.tool()
def start_mission(survivor_count: int = None, active_drones: int = None):
    """
    Reset hazards/survivors and start the mission.
    """
    res = engine.start_mission(survivor_count, active_drones)
    _log_tool("start_mission", {"survivor_count": survivor_count, "active_drones": active_drones}, res)
    return res

@mcp.tool()
def add_drone(drone_id: str, x: float = None, z: float = None):
    """
    Add a new drone to the simulation.
    """
    res = engine.add_drone(drone_id, x, z)
    _log_tool("add_drone", {"drone_id": drone_id, "x": x, "z": z}, res)
    return res

@mcp.tool()
def assign_target(drone_id: str, sector_id: str, reason: str = None):
    """
    Assign a single drone to a sector.
    """
    sector_meta = engine.sectors.get(sector_id, {})
    if sector_meta.get("assigned_to") and sector_meta.get("assigned_to") != drone_id:
        return {"error": f"Sector {sector_id} already assigned to {sector_meta.get('assigned_to')}"}
    res = engine.set_drone_target(drone_id, sector_id, reason)
    _log_tool("assign_target", {"drone_id": drone_id, "sector_id": sector_id, "reason": reason}, res)
    return res

@mcp.tool()
def assign_targets(waiting: list[str] = None):
    """
    Auto-assign waiting drones using the swarm heuristic.
    """
    waiting = waiting or []
    logger.debug("assign_targets received waiting=%s", waiting)

    world = engine.get_world_state()
    
    # Assign to waiting drones only
    assignments = []
    explicit = {}
    for did in waiting:
        if did in latest_assignments:
            explicit[did] = latest_assignments.pop(did)

    # Get a list of actions from the swarm intelligence component
    actions = swarm_system.swarm_step(
        list(engine.drones.values()),
        world,
        latest_plan,
        drone_priorities,
        waiting=set(waiting),
    )
    logger.debug("assign_targets swarm_actions count=%s sample=%s", len(actions), actions[:3] if actions else actions)

    assignments = []

    # Loop through each drone
    for idx, did in enumerate(engine.drones.keys()):
        act = actions[idx] if idx < len(actions) else None
        is_waiting = did in waiting

        # Explicit assignments override swarm for that drone
        if did in explicit:
            sector_id = explicit[did]["sector_id"]
            reason = explicit[did].get("reason", "LLM assignment")
            sector_meta = engine.sectors.get(sector_id, {})
            if sector_meta.get("thermal_scanned"):
                logger.debug("explicit assignment skipped (scanned) drone=%s sector=%s", did, sector_id)
                continue
            if sector_meta.get("assigned_to") and sector_meta.get("assigned_to") != did:
                logger.debug("explicit assignment skipped (already_assigned) drone=%s sector=%s owner=%s", did, sector_id, sector_meta.get("assigned_to"))
                continue
            res = engine.set_drone_target(did, sector_id, reason)
            if isinstance(res, dict) and res.get("status") == "recall":
                assignments.append({"drone_id": did, "sector_id": "__RECALL__", "reason": "battery_recall"})
                continue
            if isinstance(res, dict) and res.get("error"):
                logger.debug("explicit assignment failed drone=%s sector=%s error=%s", did, sector_id, res.get("error"))
                continue
            _record_target_prio(did, sector_id)
            assignments.append({"drone_id": did, "sector_id": sector_id, "reason": reason})
            try:
                _drone_logger(did).info("explicit assignment sector=%s reason=%s", sector_id, reason)
            except Exception:
                pass
            continue

        # Skip non-waiting drones to avoid churn
        if not is_waiting:
            continue

        if not act:
            # Fallback when swarm returns no action for this drone
            target = swarm_system._patrol_target(idx, len(engine.drones), world)
            sid = engine._get_sector_at(target[0], target[2])
            sector_meta = engine.sectors.get(sid, {})
            if sector_meta.get("assigned_to") and sector_meta.get("assigned_to") != did:
                continue
            res = engine.set_drone_target(did, sid, "fallback_patrol")
            if isinstance(res, dict) and res.get("status") == "recall":
                assignments.append({"drone_id": did, "sector_id": "__RECALL__", "reason": "battery_recall"})
                continue
            if isinstance(res, dict) and res.get("error"):
                logger.debug("fallback patrol skipped: drone=%s sector=%s error=%s", did, sid, res.get("error"))
                try:
                    _drone_logger(did).info("fallback patrol skipped sector=%s error=%s", sid, res.get("error"))
                except Exception:
                    pass
                continue
            _record_target_prio(did, sid)
            assignments.append({"drone_id": did, "sector_id": sid, "reason": "fallback_patrol"})
            try:
                _drone_logger(did).info("fallback patrol sector=%s target=%s", sid, target)
            except Exception:
                pass
            continue

        # Handle scan request
        if act.get("action") == "scan":
            sector_id = act.get("sector")
            res = engine.scan_sector(did, sector_id) if sector_id else {"error": "missing sector"}
            assignments.append({"drone_id": did, "sector_id": sector_id, "reason": act.get("reason", "swarm_scan"), "result": res})
            try:
                # Per-drone log of scan outcomes
                _drone_logger(did).info(
                    "scan sector=%s hazard=%s survivors_found=%s error=%s",
                    sector_id,
                    res.get("hazard") if isinstance(res, dict) else None,
                    res.get("survivors_found") if isinstance(res, dict) else None,
                    res.get("error") if isinstance(res, dict) else None,
                )
            except Exception:
                pass
            continue

        # Handle return request
        if act.get("action") == "return":
            engine.set_drone_target(did, "__RECALL__", act.get("reason", "swarm_return"))
            _record_target_prio(did, "__RECALL__")
            assignments.append({"drone_id": did, "sector_id": "__RECALL__", "reason": act.get("reason", "swarm_return")})
            try:
                _drone_logger(did).info("return assigned reason=%s", act.get("reason", "swarm_return"))
            except Exception:
                pass
            continue

        if act.get("action") != "move":
            continue

        # Handle move request
        tx, _, tz = act.get("target", (None, None, None))

        # Ensure coordinate is valid
        if tx is None or tz is None:
            continue

        # Obtain sector information
        sector_id = act.get("sector") or engine._get_sector_at(tx, tz)
        if not sector_id:
            continue
        sector_meta = engine.sectors.get(sector_id, {})
        if sector_meta.get("thermal_scanned"):
            logger.debug("move assignment skipped (scanned) drone=%s sector=%s", did, sector_id)
            try:
                _drone_logger(did).info("assignment_skipped_scanned sector=%s", sector_id)
            except Exception:
                pass
            continue
        if sector_meta.get("assigned_to") and sector_meta.get("assigned_to") != did:
            logger.debug("move assignment skipped (already_assigned) drone=%s sector=%s owner=%s", did, sector_id, sector_meta.get("assigned_to"))
            continue
        reason = act.get("reason", "swarm_step")

        # Avoid re-applying the same target every tick.
        drone_obj = engine.drones.get(did)
        if drone_obj and getattr(drone_obj, "target_sector", None) == sector_id:
            continue

        # Set drone target (doesn't move the drone)
        res = engine.set_drone_target(did, sector_id, reason)
        if isinstance(res, dict) and res.get("status") == "recall":
            assignments.append({"drone_id": did, "sector_id": "__RECALL__", "reason": "battery_recall"})
            continue
        if isinstance(res, dict) and res.get("error"):
            logger.debug("move assignment failed drone=%s sector=%s error=%s", did, sector_id, res.get("error"))
            try:
                _drone_logger(did).info("assignment_failed sector=%s error=%s", sector_id, res.get("error"))
            except Exception:
                pass
            continue
        _record_target_prio(did, sector_id)

        try:
            _drone_logger(did).info("move assigned sector=%s reason=%s", sector_id, reason)
        except Exception:
            pass

        # Add to assignments list
        assignments.append({"drone_id": did, "sector_id": sector_id, "reason": reason})

    res = {"assignments": assignments}
    if not assignments:
        logger.warning("assign_targets produced ZERO assignments after fallback; waiting=%s", waiting)
    logger.debug("assign_targets produced assignments=%s", assignments)
    _log_tool("assign_targets", {"waiting": waiting}, res)
    return res

@mcp.tool()
def report_telemetry(drone_id: str, battery: float, x: float, y: float, z: float, status: str, clear_target: bool = False):
    """
    Update drone telemetry from UI/agent.
    """
    res = engine.update_drone_telemetry(drone_id, battery, x, y, z, status, clear_target)
    try:
        hazard_hit = res.get("hazard_hit") if isinstance(res, dict) else None
        if hazard_hit and hazard_hit.get("sector_id"):
            sector_id = hazard_hit["sector_id"]
            reason = f"hazard underfoot ({hazard_hit.get('hazard')})"
            def _hz_weight(h):
                return {"fire": 3, "smoke": 2, "unknown": 1, None: 0}.get((h or "").lower() if isinstance(h, str) else h, 0)

            drone = engine.drones.get(drone_id)
            current_target = getattr(drone, "target_sector", None) if drone else None
            current_hazard = engine.sectors.get(current_target, {}).get("hazard") if current_target else None
            hit_hazard = hazard_hit.get("hazard")
            lock_until = getattr(drone, "target_lock_until", 0) if drone else 0
            now = time.time()

            # Ensure sector state reflects discovery immediately for UI sync
            try:
                if sector_id in engine.sectors:
                    s = engine.sectors[sector_id]
                    s["discovered"] = True
                    s["scanned"] = True
                    if hazard_hit.get("hazard"):
                        s["hazard"] = hazard_hit.get("hazard")
            except Exception:
                pass

            # Skip if already heading there with an active lock
            if current_target == sector_id and lock_until and now < lock_until:
                logger.debug("hazard_hit ignored (same target, locked) drone=%s sector=%s", drone_id, sector_id)
                return res
            if current_target == sector_id:
                logger.debug("hazard_hit ignored (same target) drone=%s sector=%s", drone_id, sector_id)
                return res
            if current_target == "__RECALL__":
                logger.debug("hazard_hit ignored (recall in progress) drone=%s sector=%s", drone_id, sector_id)
                return res

            # Skip downgrades; allow upgrades even if locked (fire should preempt smoke)
            if current_target and _hz_weight(current_hazard) > _hz_weight(hit_hazard):
                logger.debug("hazard_hit ignored (lower priority) drone=%s hit=%s current=%s", drone_id, sector_id, current_target)
                return res

            # If already heading to a fire, only retarget to another fire that is closer to the drone
            try:
                if (current_hazard or "").lower() == "fire" and (hit_hazard or "").lower() == "fire":
                    cur_center = engine.sectors.get(current_target, {}).get("center") if current_target else None
                    new_center = engine.sectors.get(sector_id, {}).get("center")
                    drone_pos = getattr(drone, "coordinates", None)
                    if cur_center and new_center and drone_pos:
                        cur_dist = math.hypot(cur_center[0] - drone_pos[0], cur_center[1] - drone_pos[2])
                        new_dist = math.hypot(new_center[0] - drone_pos[0], new_center[1] - drone_pos[2])
                        if new_dist >= cur_dist:
                            logger.debug("hazard_hit ignored (fire target nearer) drone=%s current=%s new=%s cur_dist=%.2f new_dist=%.2f", drone_id, current_target, sector_id, cur_dist, new_dist)
                            return res
            except Exception:
                pass

            # Cooldown to avoid ping-pong
            cd = _hazard_redirect_cooldown.get(drone_id)
            # reset cooldown if higher priority than previous
            if cd and cd.get("sector") == sector_id and (now - cd.get("ts", 0)) < 3.0 and _hz_weight(hit_hazard) <= _hz_weight(current_hazard):
                logger.debug("hazard_hit ignored (cooldown) drone=%s sector=%s", drone_id, sector_id)
                return res
            
            # Check if sector is already assigned to a different drone
            if engine.sectors.get(sector_id, {}).get("assigned_to") and engine.sectors.get(sector_id, {}).get("assigned_to") != drone_id:
                logger.debug("hazard_hit ignored (already assigned) drone=%s sector=%s owner=%s", drone_id, sector_id, engine.sectors.get(sector_id, {}).get("assigned_to"))
                return res
            
            _hazard_redirect_cooldown[drone_id] = {"sector": sector_id, "ts": now}

            # Clear previous assignment for this drone
            try:
                if drone:
                    drone.target_sector = None
                    for s in engine.sectors.values():
                        if s.get("assigned_to") == drone_id:
                            s["assigned_to"] = None
            except Exception:
                pass

            # Retarget to hazard and dispatch assignment immediately
            engine.set_drone_target(drone_id, sector_id, reason)
            latest_assignments[drone_id] = {"sector_id": sector_id, "reason": reason}
            logger.debug("report_telemetry hazard_hit retarget drone=%s sector=%s reason=%s", drone_id, sector_id, reason)
            try:
                assign_targets([drone_id])
            except Exception:
                logger.exception("report_telemetry hazard_hit immediate assign failed for %s", drone_id)
    except Exception:
        pass
    _log_tool("report_telemetry", {"drone_id": drone_id, "battery": battery, "x": x, "y": y, "z": z, "status": status, "clear_target": clear_target}, res)
    return res


if __name__ == "__main__":
    mcp.run()
