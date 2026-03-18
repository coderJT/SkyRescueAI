"""
This is our world file. It always contains the full knowledge of both environment and our drone system.
"""

def init_world():

    return {
        # Environment variables
        "time": 0,
        "drones": [],
        "hazards": [],
        "humans": [],          
        "grid_size": (100, 100),
        "wind": None,

        # Knowledge by drone system
        "known_fires": [],
        "detected_humans": [],
        "explored_sectors": set(),

        # Orchestrator
        "strategy": None,
        "constraints": {},

        # Metrics of success
        "metrics": {
            "coverage_pct": 0,
            "survivors_found": 0
        }
    }