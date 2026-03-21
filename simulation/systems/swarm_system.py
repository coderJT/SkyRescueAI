"""
Swarm decision helper: given world + drones + plan, return best actions.

Requirements implemented:
1) Accept inputs from orchestrator (world, plan, priorities).
2) Battery-feasible check that accounts for hazard drain and return-to-base.
3) Prevent assigning multiple drones to the same target sector.
4) Hazard-weighted sector scoring (fire > smoke > unknown).
5) Patrol spread when no hazard targets.
6) Immediate scan if currently in a hazard sector.
7) Return per-drone actions to MCP caller.
"""

from __future__ import annotations
import logging
import math
import random
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from collections import defaultdict

from simulation.config.settings import settings

Action = Dict[str, Any]
Sector = Dict[str, Any]

logger = logging.getLogger(__name__)
if not logger.handlers:
    LOG_PATH = Path(__file__).resolve().parent.parent.parent / "Logs" / "swarm_system.log"
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    fh = logging.FileHandler(LOG_PATH, encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    logger.setLevel(logging.DEBUG)
    logger.addHandler(fh)
    logger.propagate = False

_drone_loggers: Dict[str, logging.Logger] = {}


def _drone_logger(drone_id: str) -> logging.Logger:
    """Return a per-drone logger writing to Logs/drone_<id>.log."""
    if not drone_id.startswith("drone_"):
        drone_id = f"drone_{drone_id}"
    if drone_id in _drone_loggers:
        return _drone_loggers[drone_id]
    lg = logging.getLogger(f"drone.{drone_id}")
    if not lg.handlers:
        path = Path(__file__).resolve().parent.parent.parent / "logs" / f"drone_{drone_id}.log"
        path.parent.mkdir(parents=True, exist_ok=True)
        fh = logging.FileHandler(path, encoding="utf-8")
        fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
        lg.setLevel(logging.INFO)
        lg.addHandler(fh)
        lg.propagate = False
    _drone_loggers[drone_id] = lg
    return lg

# Hazard drain multipliers
FIRE_MULT = 2.0
SMOKE_MULT = getattr(settings, "smoke_multiplier", 1.4)
DEFAULT_MULT = 1.0


def _sector_at(world: Dict[str, Any], x: float, z: float) -> Tuple[Optional[str], Optional[Sector]]:
    """Map world (x,z) to sector id and data."""
    sectors = world.get("sectors", {})
    if not sectors:
        return None, None
    try:
        rows = max(s["row"] for s in sectors.values()) + 1
        cols = max(s["col"] for s in sectors.values()) + 1
        grid_size = int(world.get("grid_size", 200))
        cell_w = grid_size / cols
        cell_h = grid_size / rows
        col = min(int(x / cell_w), cols - 1)
        row = min(int(z / cell_h), rows - 1)
        sid = f"S{row}_{col}"
        return sid, sectors.get(sid)
    except Exception:
        sid, data = min(
            sectors.items(),
            key=lambda kv: math.hypot(kv[1]["center"][0] - x, kv[1]["center"][1] - z),
        )
        return sid, data


def _dist2d(a, b):
    return math.hypot(a[0] - b[0], a[2] - b[2])


def _hazard_weight(h: Optional[str]) -> int:
    if h == "fire":
        return 3
    if h == "smoke":
        return 2
    return 1


def _hazard_mult(h: Optional[str]) -> float:
    if h == "fire":
        return FIRE_MULT
    if h == "smoke":
        return SMOKE_MULT
    return DEFAULT_MULT


def _battery_feasible(drone, target: Sector, world: Dict[str, Any], constraints: Dict[str, Any]) -> bool:
    """Check if drone can reach target sector, scan, and return to base with margin."""
    hx, hz = target["center"]
    bx, bz = settings.base_x, settings.base_z
    # distance there and back
    to_target = _dist2d((hx, 0, hz), drone.coordinates)
    to_base = math.hypot(hx - bx, hz - bz)
    hazard = target.get("hazard") or target.get("true_hazard")
    mult = _hazard_mult(hazard)
    move_cost = (to_target + to_base) * settings.drain_per_unit * mult
    scan_cost = settings.scan_cost * mult
    reserve = constraints.get("battery_recall_threshold") or settings.safety_margin
    needed = move_cost + scan_cost + reserve
    feasible = drone.battery_remaining >= needed
    return feasible


def _patrol_target(
    drone_idx: int,
    total: int,
    world: Dict[str, Any],
    anchor: Optional[Tuple[float, float, float]] = None,
    avoid_sid: Optional[str] = None,
) -> Tuple[float, float, float]:
    """Spread drones radially; if anchor provided, stay near that anchor. Skip already thermal-scanned sectors."""
    grid = int(world.get("grid_size", 200))
    sectors = world.get("sectors", {})
    attempts = 0
    last = (0.0, 5.0, 0.0)
    while attempts < 6:
        if anchor:
            ax, _, az = anchor
            jitter = grid * 0.05
            x = max(0, min(grid, ax + random.uniform(-jitter, jitter)))
            z = max(0, min(grid, az + random.uniform(-jitter, jitter)))
        else:
            angle = (2 * math.pi * drone_idx / max(total, 1)) + random.uniform(-0.3, 0.3)
            center_x = grid / 2
            center_z = grid / 2
            radius = grid * 0.45 + random.uniform(-grid * 0.05, grid * 0.05)
            x = max(0, min(grid, center_x + radius * math.cos(angle)))
            z = max(0, min(grid, center_z + radius * math.sin(angle)))
        last = (x, 5, z)
        sid, _ = _sector_at(world, x, z)
        if avoid_sid and sid == avoid_sid:
            attempts += 1
            continue
        if sid and sectors.get(sid, {}).get("thermal_scanned"):
            attempts += 1
            continue
        if sid and sectors.get(sid, {}).get("assigned_to"):
            attempts += 1
            continue
        return last
    return last


def _sector_neighbors(world: Dict[str, Any], sid: str, radius: int) -> List[Tuple[str, int]]:
    """Return (sector_id, grid_distance) within radius of sid (inclusive)."""
    sectors = world.get("sectors") or {}
    if sid not in sectors:
        return []
    target = sectors[sid]
    tr, tc = target.get("row"), target.get("col")
    if tr is None or tc is None:
        return []
    res: List[Tuple[str, int]] = []
    for other_id, s in sectors.items():
        r, c = s.get("row"), s.get("col")
        if r is None or c is None:
            continue
        dist = max(abs(r - tr), abs(c - tc))
        if dist <= radius:
            res.append((other_id, dist))
    return res


def parse_priorities(priorities: Optional[List[Any]], world: Dict[str, Any], plan_mode_hint: Optional[str] = None):
    """Translate plan priorities into scoring bonuses and patrol anchors."""
    hazards = defaultdict(float)
    sectors = defaultdict(float)
    patrol_anchor: Optional[Tuple[float, float, float]] = None
    plan_mode: Optional[str] = plan_mode_hint.lower() if isinstance(plan_mode_hint, str) else None

    items = priorities or []
    total = len(items)
    sectors_map = world.get("sectors") or {}
    base_bonus = 6

    def record_anchor(candidate_sid: str, weight: float):
        nonlocal patrol_anchor
        if candidate_sid not in sectors_map:
            return
        current = sectors.get(candidate_sid, 0)
        if (not patrol_anchor) or weight >= current:
            cx, cz = sectors_map[candidate_sid].get("center", (None, None))
            if cx is not None and cz is not None:
                patrol_anchor = (cx, 5, cz)

    for idx, raw in enumerate(items):
        weight = base_bonus + 2 * (total - idx - 1)
        directive = raw.get("directive") if isinstance(raw, dict) else raw
        if directive is None:
            continue
        if not isinstance(directive, str):
            continue
        value = directive.strip()
        lower = value.lower()

        if lower.startswith("hazard:"):
            h = lower.split(":", 1)[1]
            if h in ("fire", "smoke", "unknown"):
                hazards[h] += weight
        elif lower.startswith("sector:"):
            sid = value.split(":", 1)[1]
            if sid in sectors_map:
                sectors[sid] += weight
                record_anchor(sid, weight)
        elif lower.startswith("area:"):
            payload = value.split(":", 1)[1]
            parts = [p.strip() for p in payload.split(",") if p.strip()]
            if not parts:
                continue
            sid = parts[0]
            try:
                radius = next((int(p.split("=", 1)[1]) for p in parts[1:] if p.startswith("radius")), 1)
            except Exception:
                radius = 1
            for neighbor_id, dist in _sector_neighbors(world, sid, max(radius, 0)):
                decay = dist + 1
                sectors[neighbor_id] += weight / decay
            record_anchor(sid, weight)
        elif lower.startswith("mode:"):
            mode_val = lower.split(":", 1)[1]
            if mode_val in ("coverage", "rescue"):
                plan_mode = mode_val
        # Non-prefixed shorthands (LLM may return plain tokens)
        elif lower in ("coverage",):
            plan_mode = "coverage"
        elif lower in ("rescue", "survivor", "survivors"):
            plan_mode = "rescue"
        elif lower in ("hazard", "hazards"):
            # Boost all hazard types evenly
            for h in ("fire", "smoke", "unknown"):
                hazards[h] += weight
        elif lower in ("fire", "smoke", "unknown"):
            hazards[lower] += weight

    if not patrol_anchor and sectors:
        sid = max(sectors.items(), key=lambda kv: kv[1])[0]
        cx, cz = sectors_map.get(sid, {}).get("center", (None, None))
        if cx is not None and cz is not None:
            patrol_anchor = (cx, 5, cz)

    return {
        "hazard_bonus": dict(hazards),
        "sector_bonus": dict(sectors),
        "patrol_anchor": patrol_anchor,
        "plan_mode": plan_mode,
    }


def _respond_if_on_hazard(drone, world: Dict[str, Any]) -> Optional[Action]:
    """If drone stands in a hazard sector not yet thermally scanned, scan immediately."""
    if getattr(drone, "status", None) in ("scanning", "charging", "offline"):
        return None
    if getattr(drone, "scanning_pending", False):
        return None
    sid, sector = _sector_at(world, drone.coordinates[0], drone.coordinates[2])
    if not sector:
        return None
    haz = sector.get("hazard") or sector.get("true_hazard")
    if haz in ("fire", "smoke") and not sector.get("thermal_scanned"):
        cx, cz = sector.get("center", (None, None))
        if cx is None or cz is None:
            return None
        return {
            "action": "move",
            "target": (cx, 5, cz),
            "sector": sid,
            "reason": f"On {haz} sector {sid}; pause route and scan here first",
            "force": True,
        }
    return None


def _score_sector(drone, sector: Sector, *, hazard_bias: float = 0.0, sector_bonus: float = 0.0, hazard_bonus: float = 0.0) -> float:
    """Higher is better; weight hazard first, then proximity."""
    hazard = sector.get("hazard") or sector.get("true_hazard")
    base = (_hazard_weight(hazard) + hazard_bias) * 10
    dist_penalty = _dist2d((sector["center"][0], 0, sector["center"][1]), drone.coordinates) * 0.1
    scanned_penalty = 5 if sector.get("thermal_scanned") else 0
    return base + hazard_bonus + sector_bonus - dist_penalty - scanned_penalty


def receive_inputs(world: Dict[str, Any], plan: Optional[Dict[str, Any]], priorities: Optional[Dict[str, str]]):
    """Normalize inputs from orchestrator; return hazards list and constraints."""
    sectors = world.get("sectors") or {}
    def _known_hazard(sector: Sector) -> bool:
        hazard = sector.get("hazard")
        true_hazard = sector.get("true_hazard")
        discovered = sector.get("discovered")
        # Unknown placeholder means unseen; ignore until discovery
        if hazard == "unknown":
            return False
        # Count explicit hazard flags even if discovered flag missing
        if hazard not in (None, "clear", "unknown"):
            return True
        # Hidden hazards only count after discovery
        if discovered and true_hazard not in (None, "clear", "unknown"):
            return True
        return False

    hazards = [s for s in sectors.values() if _known_hazard(s)]
    constraints = (plan or {}).get("constraints") or {}
    prios = priorities or {}
    already_assigned = {sid for sid, s in sectors.items() if s.get("assigned_to")}
    return hazards, constraints, prios, already_assigned


def swarm_step(drones: List[Any], world: Dict[str, Any], plan: Dict[str, Any] | None = None, priorities: Dict[str, str] | None = None, waiting: Optional[set[str]] = None) -> List[Action]:
    """
    Entry point used by MCP assign_targets. Returns per-drone action list.
    """
    hazards, constraints, prios, already_assigned = receive_inputs(world, plan, priorities)
    directives = parse_priorities((plan or {}).get("priorities"), world, (plan or {}).get("mode"))
    hazard_bonus_map = directives["hazard_bonus"]
    sector_bonus_map = directives["sector_bonus"]
    patrol_anchor = directives["patrol_anchor"]
    plan_mode = directives["plan_mode"]
    hazard_bias = 3 if plan_mode == "rescue" or hazard_bonus_map else 0

    hazard_pool = [
        h for h in hazards
        if not h.get("thermal_scanned")
        or not h.get("assigned_to")
    ]    

    assigned_ids = set()
    actions: List[Action] = []

    for idx, drone in enumerate(drones):
        did_raw = getattr(drone, "id", None)
        did = did_raw if did_raw else f"drone_{idx+1}"
        current_target = getattr(drone, "target_sector", None)
        allow_assign = (waiting is None) or (did in waiting)

        # 6) Immediate scan if standing on hazard
        scan_action = _respond_if_on_hazard(drone, world)
        if scan_action:
            target_sid = scan_action.get("sector")
            if current_target == target_sid:
                # Already targeting this hazard tile; avoid target churn/log spam.
                actions.append({"action": "noop", "reason": "holding hazard scan target"})
            else:
                actions.append(scan_action)
                _drone_logger(did).info(
                    "hold_scan sector=%s reason=%s",
                    target_sid or _sector_at(world, drone.coordinates[0], drone.coordinates[2])[0],
                    scan_action.get("reason"),
                )
            continue

        # 2) Battery-feasible check + return
        # If below reserve irrespective of target, recall
        reserve = constraints.get("battery_recall_threshold") or settings.safety_margin
        if drone.battery_remaining <= reserve:
            if allow_assign:
                actions.append({"action": "return", "target": (settings.base_x, 5, settings.base_z), "reason": "Battery reserve"})
                _drone_logger(did).info("return_to_base battery=%.2f reserve=%.2f", drone.battery_remaining, reserve)
            continue

        if not allow_assign:
            actions.append({})
            continue

        # 4) Hazard scoring and assignment (plan-aware)
        scored_targets = sorted(
            (
                (
                    s,
                    _score_sector(
                        drone,
                        s,
                        hazard_bias=hazard_bias,
                        sector_bonus=sector_bonus_map.get(s["id"], 0),
                        hazard_bonus=hazard_bonus_map.get((s.get("hazard") or s.get("true_hazard") or "unknown").lower(), 0),
                    ),
                )
                for s in hazard_pool
                if s["id"] not in assigned_ids
                and s["id"] not in already_assigned
                and _battery_feasible(drone, s, world, constraints)
            ),
            key=lambda t: t[1],
            reverse=True,
        )

        if scored_targets:
            best_sector, score = scored_targets[0]
            if current_target == best_sector["id"]:
                logger.info(
                    "assignment retained: drone=%s sector=%s score=%.2f (no change)",
                    did,
                    best_sector["id"],
                    score,
                )
                _drone_logger(did).info(
                    "retained target %s score=%.2f hazard_bias=%.1f hazard_bonus=%.1f sector_bonus=%.1f",
                    best_sector["id"],
                    score,
                    hazard_bias,
                    hazard_bonus_map.get((best_sector.get("hazard") or best_sector.get("true_hazard") or "unknown").lower(), 0),
                    sector_bonus_map.get(best_sector["id"], 0),
                )
                continue
            assigned_ids.add(best_sector["id"])
            cx, cz = best_sector["center"]
            reason = f"Hazard response {best_sector['id']} score={round(score,2)}"
            actions.append({"action": "move", "target": (cx, 5, cz), "reason": reason})
            logger.info(
                "assignment move hazard: drone=%s sector=%s score=%.2f hazard_bias=%.1f hazard_bonus=%.1f sector_bonus=%.1f",
                did,
                best_sector["id"],
                score,
                hazard_bias,
                hazard_bonus_map.get((best_sector.get("hazard") or best_sector.get("true_hazard") or "unknown").lower(), 0),
                sector_bonus_map.get(best_sector["id"], 0),
            )
            _drone_logger(did).info(
                "move hazard sector=%s score=%.2f reason=%s hazard_bias=%.1f hazard_bonus=%.1f sector_bonus=%.1f",
                best_sector["id"],
                score,
                reason,
                hazard_bias,
                hazard_bonus_map.get((best_sector.get("hazard") or best_sector.get("true_hazard") or "unknown").lower(), 0),
                sector_bonus_map.get(best_sector["id"], 0),
            )
            continue

        # 5) Patrol/discover spread when no hazard targets
        anchor = patrol_anchor if (plan_mode == "coverage" and patrol_anchor and not hazards) else None
        target = _patrol_target(idx, len(drones), world, anchor)
        actions.append({"action": "move", "target": target, "reason": "Patrol spread"})
        logger.info(
            "assignment move patrol: drone=%s target=%s anchor=%s plan_mode=%s",
            did,
            target,
            anchor,
            plan_mode,
        )
        _drone_logger(did).info(
            "move patrol target=%s anchor=%s plan_mode=%s hazards=%s",
            target,
            anchor,
            plan_mode,
            bool(hazards),
        )

    if (hazard_bonus_map or sector_bonus_map or plan_mode):
        logger.info(
            "plan_directives applied: mode=%s hazard_bonus=%s sector_bonus=%s anchor=%s",
            plan_mode,
            hazard_bonus_map,
            sector_bonus_map,
            patrol_anchor,
        )

    # Defensive: guarantee one action per drone (fallback patrol) so callers never receive an empty list.
    if len(actions) < len(drones):
        for idx in range(len(actions), len(drones)):
            actions.append({
                "action": "move",
                "target": _patrol_target(idx, len(drones), world),
                "reason": "Patrol spread (fallback)",
            })

    return actions
