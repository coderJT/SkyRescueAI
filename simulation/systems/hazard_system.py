"""Hazard generation and wind update helpers for the simulation engine."""

import math
import random


def generate_hazards(engine):
    """Seed fire, derive smoke, and reset sector hazard state."""
    engine.fire_sector_ids = set()
    engine.smoke_sector_ids = set()
    engine.fire_multipliers = {}
    engine.discovered_sector_ids = set()
    for sid in engine.sectors:
        s = engine.sectors[sid]
        s["true_hazard"] = "clear"
        s["hazard"] = "unknown"  # unknown to drones until discovered/visited
        s["discovered"] = False
        s["scanned"] = False
        s["thermal_scanned"] = False
        s["assigned_to"] = None
        s["survivors_found"] = []

    valid_seeds = []
    for r in range(engine.sector_rows):
        for c in range(engine.sector_cols):
            if r <= 2 and c <= 2:
                continue
            valid_seeds.append((r, c))

    num_seeds = random.randint(8, 12)
    seeds = random.sample(valid_seeds, min(num_seeds, len(valid_seeds)))

    for r, c in seeds:
        patch_size_r = random.randint(1, 3)
        patch_size_c = random.randint(1, 3)
        for dr in range(patch_size_r):
            for dc in range(patch_size_c):
                nr, nc = r + dr, c + dc
                if 0 <= nr < engine.sector_rows and 0 <= nc < engine.sector_cols:
                    sid = f"S{nr}_{nc}"
                    engine.fire_sector_ids.add(sid)
                    engine.fire_multipliers[sid] = 3.0
                    engine.sectors[sid]["true_hazard"] = "fire"

    # Smoke around fire
    for sid in list(engine.fire_sector_ids):
        row, col = map(int, sid[1:].split("_"))
        for dr, dc in [(-1,0),(1,0),(0,-1),(0,1)]:
            nr, nc = row + dr, col + dc
            if 0 <= nr < engine.sector_rows and 0 <= nc < engine.sector_cols:
                adj_id = f"S{nr}_{nc}"
                if adj_id not in engine.fire_sector_ids:
                    engine.smoke_sector_ids.add(adj_id)
                    engine.sectors[adj_id]["true_hazard"] = "smoke"


def update_wind(engine):
    """Small jitter to wind direction/speed and description refresh."""
    engine.wind["angle_deg"] = (engine.wind["angle_deg"] + random.uniform(-2, 2)) % 360
    engine.wind["speed_kmh"] = max(20, min(50, engine.wind["speed_kmh"] + random.uniform(-1, 1)))

    angle = engine.wind["angle_deg"]
    dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    dir_idx = int((angle + 22.5) / 45) % 8
    engine.wind["description"] = f"Wind blowing {engine.wind['speed_kmh']:.1f} km/h towards {dirs[dir_idx]} ({angle:.1f}°)"


def wind_vector(angle_deg: float):
    rad = math.radians(angle_deg)
    return math.sin(rad), -math.cos(rad)


def wind_multiplier(old_pos, new_pos, wind):
    dx = new_pos[0] - old_pos[0]
    dz = new_pos[2] - old_pos[2]
    dist = math.sqrt(dx*dx + dz*dz)
    if dist < 0.1:
        return 1.0
    mx, mz = dx/dist, dz/dist
    wx, wz = wind_vector(wind["angle_deg"])
    dot = mx*wx + mz*wz
    multiplier = 1.15 - 0.15 * dot
    return max(1.0, multiplier)
