"""
Simulation Engine - Forest Wildfire Search & Rescue
Implements a singleton pattern so all MCP tool calls share the same state.
Manages a sector grid, no-fly zones, fire zones, smoke, and wind.
"""
import math
import random
import time
import traceback

from simulation.config.settings import settings
from simulation.entities.drone import Drone
from simulation.systems import drone_system, hazard_system

class SimulationEngine:
    """
    Singleton simulation engine that manages drones, survivors, sectors,
    and environmental hazards (fire, smoke, wind).
    """
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self._initialized = True
        self.start_time = time.time()
        self.last_drain_time = time.time()
        self.mission_log = []
        
        # Pause mechanism
        self.paused = False
        self.pause_start_time = 0
        self.total_paused_duration = 0

        # Fleet starts empty; drones are added on start/reset via add_drone
        self.drones = {}

        # Initialize the world grid
        self.grid_size = settings.grid_size
        self.sector_cols = settings.sector_cols
        self.sector_rows = settings.sector_rows
        self.sector_width = self.grid_size / self.sector_cols
        self.sector_height = self.grid_size / self.sector_rows
        self.sectors = {}
        self.mission_status = "waiting" # waiting | active | success | failure
        self.fire_sector_ids = set() # True fire
        self.smoke_sector_ids = set() # True smoke
        self.fire_multipliers = {}

        # Swarm knowledge
        self.discovered_sector_ids = set() 
        
        # Initialize sectors
        for row in range(self.sector_rows):
            for col in range(self.sector_cols):
                sector_id = f"S{row}_{col}"
                cx = col * self.sector_width + self.sector_width / 2
                cy = row * self.sector_height + self.sector_height / 2
                
                self.sectors[sector_id] = {
                    "id": sector_id,
                    "row": row,
                    "col": col,
                    "center": (cx, cy),
                    "true_hazard": "clear", # The ground truth
                    "hazard": "clear",      # What the drones have discovered
                    "discovered": False,
                    "scanned": False,
                    "assigned_to": None,
                    "status": "unscanned",
                    "survivors_found": [],
                }

        # Generate Random Fire (Remove Northern/Eastern hardcoding)
        hazard_system.generate_random_hazards(self)
        
        # survivors randomized separately
        self._generate_random_survivors()

        # --- Discovered survivors (found during scans) ---
        self.discovered_survivors = []

        

        self.smoke_multiplier = settings.smoke_multiplier
        # Discover initial base area (11x11 block)

        # --- Environment: Wind ---
        self.wind = {
            "angle_deg": settings.wind_angle_deg,  # 45 deg = NE (Wind blowing FROM SW TO NE)
            "speed_kmh": settings.wind_speed_kmh,
            "description": settings.wind_desc,
            "battery_multiplier_against": 1.3,
        }


    def log(self, message):
        print(f"📡 {message}")
        self.mission_log.append(message)

    def _generate_random_survivors(self, count=None):
        """Randomly spawn survivors avoiding base camp."""
        self.survivors = []
        num_survivors = count if count is not None else random.randint(settings.survivor_min, settings.survivor_max)
        for _ in range(num_survivors):
            # Try to pick a spot not in base camp (0,0) to (40,40) AND not in No-Fly Zone
            for _attempt in range(20):  # Increased attempts
                x = random.uniform(5, 195)
                z = random.uniform(5, 195)
                # Base camp safety
                if x < 40 and z < 40:
                    continue
                # No-Fly Zone check
                sid = self._get_sector_at(x, z)
                break
            
            true_hazard = self._get_true_hazard_at(x, z)
            limit = 600
            if true_hazard == "fire":
                limit = 60
            elif true_hazard == "smoke":
                limit = 180
            self.survivors.append({"pos": (round(x,1), 0, round(z,1)), "limit": limit, "expired": False})

    def _get_true_hazard_at(self, x, z):
        sid = self._get_sector_at(x, z)
        return self.sectors[sid]["true_hazard"]

    def reset_mission(self):
        """Reset mission timer, survivors, and sector states for a new run."""
        self.start_time = time.time()
        self.discovered_survivors = []
        self.mission_log = []
        
        # Reset survivors
        for s in self.survivors:
            s["expired"] = False
            
        # Reset sectors (except no-fly zones)
        for sid, sector in self.sectors.items():
            sector["assigned_to"] = None
            sector["survivors_found"] = []
                
        self.log("Mission Reset: Hazards and survivors re-randomized.")
        hazard_system.generate_random_hazards(self)
        self._generate_random_survivors()
        self.mission_status = "waiting"
        self.paused = False
        self.pause_start_time = 0
        self.total_paused_duration = 0
        return {"status": "success", "message": "Mission state fully reset and waiting for start."}

    def start_mission(self, survivor_count: int = None, active_drones: int = None):
        """Called when the user clicks explicitly to start the simulation."""
        self.mission_status = "active"
        self.start_time = time.time()
        self.paused = False
        self.pause_start_time = 0
        self.total_paused_duration = 0

        # Reset sector discovery/scans before regenerating hazards
        for sid, s in self.sectors.items():
            s["hazard"] = "clear"
            s["discovered"] = False
            s["scanned"] = False
            s["assigned_to"] = None
            s["status"] = "unscanned"
            s["survivors_found"] = []
        
        # 1. Re-randomize hazards and survivors if requested
        hazard_system.generate_random_hazards(self)
        self._generate_random_survivors(count=survivor_count)

        # Reset discovered survivors for new mission
        self.discovered_survivors = []
        self.mission_log.clear()
        
        # 2. Initialize fleet: if none present, add requested number (default 5)
        if not self.drones:
            count = active_drones if active_drones is not None else 5
            for i in range(count):
                did = f"drone_{i+1}"
                self.add_drone(did)
        elif active_drones is not None:
            # Ensure exactly active_drones exist (add if fewer, ignore if more)
            existing = list(self.drones.keys())
            if len(existing) < active_drones:
                for i in range(len(existing), active_drones):
                    did = f"drone_{i+1}"
                    self.add_drone(did)

        self.log(f"Mission Started with {len(self.survivors)} survivors!")
        return {"status": "success", "message": "Mission started.", "survivor_count": len(self.survivors)}

    def _get_sector_at(self, x, z):
        """Return the sector ID for a given coordinate."""
        col = min(int(x / self.sector_width), self.sector_cols - 1)
        row = min(int(z / self.sector_height), self.sector_rows - 1)
        return f"S{row}_{col}"

    def _battery_multiplier_at(self, x, z):
        """Return the battery drain multiplier at a given position based on TRUE hazard."""
        sid = self._get_sector_at(x, z)
        if sid in self.fire_multipliers:
            return self.fire_multipliers[sid]
        if sid in self.smoke_sector_ids:
            return self.smoke_multiplier
        return 1.0

    # ─── Drone Operations ───
    def update_drone_telemetry(self, drone_id: str, battery: float, x: float, y: float, z: float, status: str, clear_target: bool = False) -> dict:
        """Update a drone's telemetry coming from the UI or an external controller."""
        if drone_id not in self.drones:
            return {"error": f"Drone {drone_id} not found"}

        drone = self.drones[drone_id]
        drone.battery_remaining = battery
        drone.coordinates = (x, y, z)
        drone.status = status

        # Passive hazard discovery: mark the sector the drone is currently in as discovered
        try:
            sid = self._get_sector_at(x, z)
            sector = self.sectors.get(sid)
            if sector:
                sector["discovered"] = True
                sector["hazard"] = sector["true_hazard"]
        except Exception:
            pass

        if clear_target:
            if drone.target_sector and drone.target_sector in self.sectors:
                s = self.sectors[drone.target_sector]
                if s["assigned_to"] == drone_id:
                    s["assigned_to"] = None
                    if s["status"] == "assigned":
                        s["status"] = "unscanned"
            drone.target_sector = None

        return {"status": "success"}

    def list_drones(self):
        return list(self.drones.keys())

    def add_drone(self, drone_id: str = None, x: float = None, z: float = None) -> dict:
        """
        Add a new drone to the rescue fleet.
        If drone_id is not provided, generates one automatically.
        If position is not provided, places drone at base camp.
        """

        # Generate drone ID if not provided
        if not drone_id:
            existing_nums = [int(d.split('_')[1]) for d in self.drones.keys() if d.startswith('drone_') and d.split('_')[1].isdigit()]
            next_num = max(existing_nums, default=0) + 1
            drone_id = f"drone_{next_num}"

        if drone_id in self.drones:
            return {"error": f"Drone {drone_id} already exists"}

        # Determine spawn position
        if x is None:
            x = settings.base_x
        if z is None:
            z = settings.base_z

        # Slightly offset if multiple drones at base
        offset = len([d for d in self.drones.values() if d.status == "active" and abs(d.coordinates[0] - x) < 5 and abs(d.coordinates[2] - z) < 5])
        x = x + offset * 2

        # Create new drone at base position (y=5 for flying height)
        new_drone = Drone(drone_id, 100, "active", (x, 5, z))
        self.drones[drone_id] = new_drone

        self.log(f"🚁 NEW DRONE ADDED: {drone_id} at ({x:.1f}, 5, {z:.1f}) with 100% battery")
        return {
            "status": "success",
            "drone_id": drone_id,
            "battery": 100,
            "position": [x, 5, z],
            "fleet_size": len(self.drones)
        }

    def get_fleet_status(self):
        return {did: d.to_dict() for did, d in self.drones.items()}

    def get_drone_status(self, drone_id):
        if drone_id not in self.drones:
            return {"error": f"Drone {drone_id} not found"}
        return self.drones[drone_id].to_dict()

    def set_drone_target(self, drone_id, sector_id, reason=None):
        """Pure state update: Assign a drone to a sector with specific reasoning."""
        if drone_id not in self.drones:
            return {"error": f"Drone {drone_id} not found"}
        
        drone = self.drones[drone_id]
        
        # 1. Clear OLD assignment if it exists
        if drone.target_sector and drone.target_sector in self.sectors:
            old_s = self.sectors[drone.target_sector]
            if old_s["assigned_to"] == drone_id:
                old_s["assigned_to"] = None
                if old_s["status"] == "assigned":
                    old_s["status"] = "unscanned"
        
        # 2. Set NEW assignment
        drone.target_sector = sector_id
        drone.current_reason = reason

        if sector_id == "__RECALL__":
            self.log(f"STATE: {drone_id} target set to __RECALL__")
            return {"status": "success", "drone_id": drone_id, "target": "__RECALL__"}

        if sector_id not in self.sectors:
            # Revert if sector invalid
            drone.target_sector = None
            return {"error": f"Sector {sector_id} not found"}

        # Battery feasibility: ensure round-trip + scan + safety margin is possible
        center = self.sectors[sector_id]["center"]
        dist = math.hypot(center[0] - drone.coordinates[0], center[1] - drone.coordinates[2])
        round_trip_cost = dist * 2 * settings.drain_per_unit + settings.scan_cost + settings.safety_margin
        if drone.battery_remaining < round_trip_cost:
            drone.target_sector = None
            return {"error": f"Insufficient battery for {sector_id}: need ~{round_trip_cost:.1f}% but have {drone.battery_remaining:.1f}%"}
        
        # Update sector status - Note: Multiple drones COULD be assigned to one sector
        # but the sector only tracks the LAST one assigned for status purposes.
        # This is fine as long as the drones THEMSELVES know their target.
        self.sectors[sector_id]["assigned_to"] = drone_id
        self.sectors[sector_id]["status"] = "assigned"
        
        log_msg = f"STATE: {drone_id} target set to {sector_id}"
        if reason:
            log_msg += f" | REASON: {reason}"
        self.log(log_msg)
        return {"status": "success", "drone_id": drone_id, "target": sector_id}

    def get_world_state(self):
        """Returns the complete ground truth of the simulation."""
        try:
            hazard_system.update_wind(self)
            now = time.time()
            
            if self.paused:
                elapsed = self.pause_start_time - self.start_time - self.total_paused_duration
            else:
                elapsed = now - self.start_time - self.total_paused_duration
            
            # --- IDLE DRAIN (Realism) ---
            # Apply small drain to all non-offline drones based on time delta
            if self.paused:
                self.last_drain_time = now # Freeze drain
                delta = 0
            else:
                delta = now - getattr(self, 'last_drain_time', now)
            if delta > 0.5: # Only apply if > 0.5s passed to avoid floating point noise
                drone_system.idle_drain(self.drones, delta)
                self.last_drain_time = now
            
            # Calculate statistics
            scannable = sum(1 for sid, s in self.sectors.items())
            scanned = sum(1 for sid, s in self.sectors.items() if s["scanned"])
            found = len(self.discovered_survivors)
            total_needed = len(self.survivors)
            discovered = sum(1 for sid, s in self.sectors.items() if s.get("discovered"))

            # Update survivor expired status
            # Only mark survivors as expired if they haven't been found yet
            for s_data in self.survivors:
                if not s_data["expired"] and elapsed >= s_data["limit"]:
                    # Check if this survivor has been discovered/found
                    survivor_pos = s_data["pos"]
                    is_found = survivor_pos in self.discovered_survivors
                    
                    # Only mark as expired if not yet found
                    if not is_found:
                        s_data["expired"] = True
                        self.log(f"💀 SURVIVOR DIED at {s_data['pos']} - time limit exceeded!")

            # Update mission status
            if self.mission_status == "active":
                # Success: All scannable sectors are scanned
                # (Optionally: or all survivors found)
                if scannable > 0 and scanned >= scannable:
                    self.mission_status = "success"
                    self.log(f"Mission Complete: All {scannable} scannable sectors cleared.")

            drones_state = {}
            for did in self.drones:
                drones_state[did] = self.get_drone_status(did)
                
            return {
                "mission_status": self.mission_status,
                "mission_complete": self.mission_status in ["success", "failure"],
                "paused": self.paused,
                "elapsed_seconds": round(elapsed, 1),
                "found_survivors": found,
                "total_survivors": total_needed,
                "sectors_scanned": scanned,
                "total_scannable_sectors": scannable,
                "sectors_discovered": discovered,
                "discovery_pct": int((discovered / scannable) * 100) if scannable > 0 else 0,
                "coverage_pct": int((scanned / scannable) * 100) if scannable > 0 else 0,
                "drones": drones_state,
                "sectors": self.sectors,
                "discovered_survivors": self.discovered_survivors,
                "all_survivors": [{"pos": s["pos"], "expired": s["expired"]} for s in self.survivors],
                "wind": self.wind,
                "mission_log": self.mission_log[-20:], # Send last 20 events for sync
            }
        except Exception as e:
            with open("/tmp/engine_error.log", "a") as f:
                f.write(f"\n--- ERROR IN get_world_state ({time.ctime()}) ---\n")
                traceback.print_exc(file=f)
            raise e

    def move_to(self, drone_id, x, y, z):
        if drone_id not in self.drones:
            return {"error": f"Drone {drone_id} not found"}
        drone = self.drones[drone_id]
        if drone.status not in ["active", "moving", "scanning", "waiting_orders"]:
            return {"error": f"Drone {drone_id} is {drone.status}, cannot move"}

        # Check if destination is in a no-fly zone
        dest_sector = self._get_sector_at(x, z)

        old_coords = drone.coordinates
        hazard_mult = self._battery_multiplier_at(old_coords[0], old_coords[2])
        wind_mult = hazard_system.wind_multiplier(old_coords, (x, y, z), self.wind)
        total_mult = hazard_mult * wind_mult

        # Apply move; drone.move_to drains base distance*drain_per_unit already
        drone.move_to(x, y, z)
        full_cost = drone_system.move_drain(old_coords, (x, y, z), settings, total_mult)
        base_cost = drone_system.move_drain(old_coords, (x, y, z), settings, 1.0)
        extra = max(0.0, full_cost - base_cost)
        if extra:
            drone.drain_battery(extra)

        hazard_label = ""
        if dest_sector in self.fire_sector_ids:
            hazard_label = " [🔥 FIRE ZONE]"
        elif dest_sector in self.smoke_sector_ids:
            hazard_label = " [💨 SMOKE]"

        self.log(f"{drone_id} moved to ({x}, {y}, {z}){hazard_label}, battery: {drone.battery_remaining:.1f}%")
        return drone.to_dict()

    def thermal_scan(self, drone_id, sector_id=None):
        if drone_id not in self.drones:
            return {"error": f"Drone {drone_id} not found"}
        drone = self.drones[drone_id]
        if drone.status not in ["active", "moving", "scanning"]:
            return {"error": f"Drone {drone_id} is {drone.status}, cannot scan"}

        # Extra scan cost in fire zones
        multiplier = self._battery_multiplier_at(drone.coordinates[0], drone.coordinates[2])
        
        # Check survival limits
        now = time.time()
        if self.paused:
            elapsed = self.pause_start_time - self.start_time - self.total_paused_duration
        else:
            elapsed = now - self.start_time - self.total_paused_duration

        # Use the explicitly provided sector_id if given (fly-over scans); otherwise
        # derive from the drone's current backend coordinates.
        if sector_id and sector_id in self.sectors:
            current_sid = sector_id
        else:
            drone_x, _, drone_z = drone.coordinates
            current_sid = self._get_sector_at(drone_x, drone_z)

        # ── PROXIMITY GUARD ──────────────────────────────────────────────────
        # The drone must be physically within SCAN_RADIUS of the sector centre.
        # This prevents remote / ghost scans from marking survivors as found.
        SCAN_RADIUS = settings.passive_survivor_radius  # same radius used by the frontend
        sector_center = self.sectors[current_sid]["center"]
        drone_x, _, drone_z = drone.coordinates
        dist_to_center = math.hypot(drone_x - sector_center[0], drone_z - sector_center[1])
        if dist_to_center > SCAN_RADIUS:
            return {
                "error": f"Drone {drone_id} is too far from sector {current_sid} centre "
                         f"({dist_to_center:.1f}u > {SCAN_RADIUS}u). Move closer before scanning.",
                "drone_position": list(drone.coordinates),
                "sector_center": list(sector_center),
                "distance": round(dist_to_center, 1),
                "required_radius": SCAN_RADIUS,
            }
        # ─────────────────────────────────────────────────────────────────────
        
        # Sector-based detection: find all active survivors in the target sector
        detected = []
        for s_data in self.survivors:
            if s_data["expired"] or elapsed >= s_data["limit"]:
                continue
            sx, sy, sz = s_data["pos"]
            if self._get_sector_at(sx, sz) == current_sid:
                detected.append(s_data["pos"])
        
        # Battery drain for scan
        scan_cost = drone_system.scan_drain(settings, multiplier)
        drone.drain_battery(scan_cost)
            
        for s in detected:
            if s not in self.discovered_survivors:
                self.discovered_survivors.append(s)
                self.log(f"🔥 NEW SURVIVOR FOUND by {drone_id} in {current_sid} at {s}!")
                
        return {
            "drone": drone_id,
            "position": list(drone.coordinates),
            "sector": current_sid,
            "detected_count": len(detected),
            "detected": [list(s) for s in detected],
            "battery_after": round(drone.battery_remaining, 1),
        }

    def get_battery_status(self, drone_id):
        if drone_id not in self.drones:
            return {"error": f"Drone {drone_id} not found"}
        return {
            "drone": drone_id,
            "battery": round(self.drones[drone_id].battery_remaining, 1),
            "status": self.drones[drone_id].status,
        }

    def recall_for_charging(self, drone_id):
        if drone_id not in self.drones:
            return {"error": f"Drone {drone_id} not found"}
        drone = self.drones[drone_id]
        for s in self.sectors.values():
            if s["assigned_to"] == drone_id:
                s["assigned_to"] = None
        drone.move_to(*drone.base_coordinates)
        drone.set_status("charging")
        drone.charge()
        self.log(f"{drone_id} recalled for charging. Battery restored to 100%.")
        return drone.to_dict()

    # ─── Environment ───

    def get_environment(self):
        """Return discovered environmental hazard data."""
        discovered_fire = []
        # Group discovered fire sectors into "Known Zones" for the agent
        # (This keeps the MCP tool output familiar but dynamic)
        discovered_fire_ids = [sid for sid, s in self.sectors.items() if s["discovered"] and s["hazard"] == "fire"]
        if discovered_fire_ids:
            discovered_fire.append({
                "name": "Discovered Fire Front",
                "sectors": discovered_fire_ids,
                "intensity": "high",
                "battery_multiplier": 3.0
            })

        return {
            "discovered_fire_zones": discovered_fire,
            "smoke_sectors": sorted([sid for sid, s in self.sectors.items() if s["discovered"] and s["hazard"] == "smoke"]),
            "wind": self.wind,
            "grid_size": self.grid_size,
            "sector_layout": "10x10 grid, 20x20 units each",
        }

    def get_hazard_map(self):
        """Return a per-sector hazard map."""
        hazard_map = {}
        for sid, sector in self.sectors.items():
            hazard_map[sid] = {
                "center": list(sector["center"]),
                "hazard": sector["hazard"],
                "scanned": sector["scanned"],
            }
        return hazard_map

    # ─── Sector Operations ───

    def get_sectors(self):
        return self.sectors

    def get_unscanned_sectors(self):
        return {sid: s for sid, s in self.sectors.items() if not s["scanned"]}

    def get_scannable_sectors(self):
        """Sectors that are unscanned AND not no-fly zones."""
        return {
            sid: s for sid, s in self.sectors.items()
            if not s["scanned"]
        }

    def scan_sector(self, drone_id, sector_id):
        if drone_id not in self.drones:
            return {"error": f"Drone {drone_id} not found"}
        if sector_id not in self.sectors:
            return {"error": f"Sector {sector_id} not found"}

        drone = self.drones[drone_id]
        sector = self.sectors[sector_id]

        if drone.status not in ["active", "moving", "scanning", "waiting_orders"]:
            return {"error": f"Drone {drone_id} is {drone.status}, cannot scan sector"}

        cx, cz = sector["center"]

        # ── PROXIMITY GUARD ──────────────────────────────────────────────────
        # The drone must already be near the sector centre before we allow the
        # scan to proceed.  This prevents the engine from teleporting a drone
        # that is on the other side of the map and instantly finding survivors.
        SCAN_RADIUS = settings.passive_survivor_radius
        drone_x, _, drone_z = drone.coordinates
        dist_to_center = math.hypot(drone_x - cx, drone_z - cz)
        if dist_to_center > SCAN_RADIUS:
            return {
                "error": f"Drone {drone_id} is too far from sector {sector_id} centre "
                         f"({dist_to_center:.1f}u > {SCAN_RADIUS}u). Fly to the sector first.",
                "drone_position": list(drone.coordinates),
                "sector_center": [cx, cz],
                "distance": round(dist_to_center, 1),
                "required_radius": SCAN_RADIUS,
            }
        # ─────────────────────────────────────────────────────────────────────

        move_result = self.move_to(drone_id, cx, 5, cz) # elevation 5, horizontal cz
        if "error" in move_result:
            return move_result

        scan_result = self.thermal_scan(drone_id)
        if "error" in scan_result:
            return scan_result

        # Reveal the truth upon dedicated scan
        sector["scanned"] = True
        sector["discovered"] = True # Scan implies discovery
        sector["hazard"] = sector["true_hazard"]
        sector["assigned_to"] = drone_id
        sector["survivors_found"] = scan_result["detected"]

        hazard = sector["hazard"]
        hazard_label = f" [{hazard.upper()}]" if hazard != "clear" else ""
        self.log(f"{drone_id} scanned sector {sector_id}{hazard_label} at ({cx},{cz}). Found {scan_result['detected_count']} survivors.")

        # Success: Clear drone target
        drone.target_sector = None
        drone.set_status("waiting_orders")
        
        return {
            "drone": drone_id,
            "sector": sector_id,
            "sector_center": [cx, cz],
            "hazard": hazard,
            "survivors_found": scan_result["detected"],
            "battery_after": scan_result["battery_after"],
        }

    def get_mission_summary(self):
        """
        Get a summary of the current mission state.
        """
        total_scannable = len(self.sectors)
        scanned = sum(1 for s in self.sectors.values() if s["scanned"])
        return {
            "sectors_scanned": scanned,
            "sectors_total": total_scannable,
            "coverage_pct": round(scanned / total_scannable * 100, 1) if total_scannable > 0 else 0,
            "survivors_found": len(self.discovered_survivors),
            "survivor_locations": [list(s) for s in self.discovered_survivors],
            "fleet_status": self.get_fleet_status(),
            "log": self.mission_log[-20:],
        }

    def toggle_pause(self, paused: bool = None):
        """
        Toggle simulation pause.
        """
        now = time.time()

        if paused is not None:
            if paused == self.paused:
                return {"status": "no_change", "paused": self.paused}
            self.paused = paused
        else:
            self.paused = not self.paused

        if self.paused:
            self.pause_start_time = now
            self.log("⏸ Simulation Paused")
        else:
            if self.pause_start_time > 0:
                self.total_paused_duration += (now - self.pause_start_time)
            self.log("▶ Simulation Resumed")
        
        return {"status": "success", "paused": self.paused}
