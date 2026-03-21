"""Centralised simulation configuration shared by API, MCP, and UI."""

from dataclasses import dataclass


@dataclass
class Settings:
    
    # World
    grid_size: int = 200
    sector_rows: int = 10
    sector_cols: int = 10

    # Survivors
    survivor_min: int = 4
    survivor_max: int = 10

    # Drone energy model
    drain_per_unit: float = 0.12   # lowered to reduce move drain
    scan_cost: float = 0.7         # slightly cheaper scans
    safety_margin: float = 6.0     # allow deeper excursions before recall
    recharge_rate_per_sec: float = 12.0  # recharge speed while docked at base
    smoke_multiplier: float = 1.4
    sector_scan_radius: float = 30.0   # ~3x3 footprint (cell width ~20)
    thermal_scan_radius: float = 12.0  # ~1x1 footprint

    # Autopilot defaults
    autopilot_speed: float = 12.0

    # Base coordinates
    base_x: float = 5.0
    base_y: float = 5.0
    base_z: float = 5.0

    # Wind 
    wind_angle_deg: float = 45.0
    wind_speed_kmh: float = 32.0
    wind_desc: str = "NE steady"
    

settings = Settings()
