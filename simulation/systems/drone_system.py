"""Drone-related energy and movement helpers."""

import math


def idle_drain(drones, delta_seconds, rate_per_sec=0.020):
    """Apply idle drain to all active drones for elapsed seconds."""
    if delta_seconds <= 0:
        return
    for d in drones.values():
        if d.status not in ["offline", "charging", "landed"]:
            d.drain_battery(rate_per_sec * delta_seconds)


def move_drain(old_pos, new_pos, settings, multiplier=1.0):
    """Compute extra drain for a move given multipliers (hazard * wind)."""
    ox, oy, oz = old_pos
    nx, ny, nz = new_pos
    distance = math.sqrt((nx - ox)**2 + (ny - oy)**2 + (nz - oz)**2)
    base = distance * settings.drain_per_unit
    if multiplier <= 1.0:
        return base
    return base * multiplier


def scan_drain(settings, multiplier=1.0):
    """Battery cost for thermal/sector scan with hazard multiplier."""
    base = settings.scan_cost
    if multiplier <= 1.0:
        return base
    return base * multiplier


def hazard_multiplier_for_sector(sector_id, fire_multipliers=None, smoke_sectors=None, smoke_multiplier=1.4):
    """Return multiplier based on sector hazard classification."""
    fire_multipliers = fire_multipliers or {}
    smoke_sectors = smoke_sectors or set()
    if sector_id in fire_multipliers:
        return fire_multipliers[sector_id]
    if sector_id in smoke_sectors:
        return smoke_multiplier
    return 1.0
