"""
Survivor generation and lifecycle helpers.
"""

from __future__ import annotations
import random
from typing import List, Dict, Any

from simulation.config.settings import settings


def generate_survivors(engine, count: int | None = None) -> List[Dict[str, Any]]:
    """Randomly spawn survivors avoiding base and respecting hazards."""
    survivors = []
    num_survivors = count if count is not None else random.randint(settings.survivor_min, settings.survivor_max)
    for _ in range(num_survivors):
        for _attempt in range(20):
            x = random.uniform(5, engine.grid_size - 5)
            z = random.uniform(5, engine.grid_size - 5)
            # avoid base camp (0-40)
            if x < 40 and z < 40:
                continue
            sid = engine._get_sector_at(x, z)
            break

        true_hazard = engine._get_true_hazard_at(x, z)
        limit = 600
        if true_hazard == "fire":
            limit = 60
        elif true_hazard == "smoke":
            limit = 180
        survivors.append({"pos": (round(x, 1), 0, round(z, 1)), "limit": limit, "expired": False})
    return survivors


def mark_expired_survivors(engine, elapsed_seconds: float):
    """Expire survivors whose time limit is exceeded."""
    for s_data in engine.survivors:
        if not s_data["expired"] and elapsed_seconds >= s_data["limit"]:
            s_data["expired"] = True
            if s_data["pos"] not in engine.discovered_survivors:
                try:
                    from simulation.utils.logger import log_event
                    log_event(f"💀 SURVIVOR DIED at {s_data['pos']} - time limit exceeded!", mission_log=engine.mission_log)
                except Exception:
                    pass
