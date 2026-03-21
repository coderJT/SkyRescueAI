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
from simulation.systems import drone_system, hazard_system, survivor_system, swarm_system
from simulation.utils.logger import log_event

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
        
        self.paused = False
        self.pause_start_time = 0
        self.total_paused_duration = 0

        self.drones = {}
        self.drone_last_sector = {}

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

        self.discovered_sector_ids = set() 


        # Initialize the world grid
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
                    "true_hazard": "clear", 
                    "hazard": "clear",    
                    "discovered": False,
                    "scanned": False,
                    "thermal_scanned": False,
                    "assigned_to": None,
                    "status": "unscanned",
                    "survivors_found": [],
                }

        self.survivors = survivor_system.generate_survivors(self)
        self.discovered_survivors = []

        self.smoke_multiplier = settings.smoke_multiplier

        self.wind = {
            "angle_deg": settings.wind_angle_deg,
            "speed_kmh": settings.wind_speed_kmh,
            "description": settings.wind_desc,
            "battery_multiplier_against": 1.3,
        }

        # Hazard redirect events for UI (short-lived, dedup via event_id)
        self.hazard_redirects = []
        self.hazard_redirect_counter = 0

    def _get_true_hazard_at(self, x, z):
        """
        Checks whether a provided coordinate is a hazard.
        """
        sid = self._get_sector_at(x, z)
        return self.sectors[sid]["true_hazard"]

    def reset_mission(self):
        """
        Reset mission timer, survivors, and sector states for a new run.
        """
        self.start_time = time.time()
        self.discovered_survivors = []
        self.mission_log = []
        
        # Reset survivors
        for s in self.survivors:
            s["expired"] = False
            
        # Reset sectors
        for sid, sector in self.sectors.items():
            sector["assigned_to"] = None
            sector["survivors_found"] = []
            sector["thermal_scanned"] = False
                
        log_event("Mission Reset: Hazards and survivors re-randomized.", mission_log=self.mission_log)

        # Regenerate hazards and survivors
        hazard_system.generate_hazards(self)
        self.survivors = survivor_system.generate_survivors(self)

        # Reset mission status
        self.mission_status = "waiting"
        self.paused = False
        self.pause_start_time = 0
        self.total_paused_duration = 0

        return {"status": "success", "message": "Mission state fully reset and waiting for start."}

    def start_mission(self, survivor_count: int = None, active_drones: int = None):
        """
        Starts a new mission.
        """

        self.mission_status = "active"
        self.start_time = time.time()
        self.paused = False
        self.pause_start_time = 0
        self.total_paused_duration = 0
        self.drone_last_sector = {}

        # Reset sectors information
        for sid, s in self.sectors.items():
            s["hazard"] = "clear"
            s["discovered"] = False
            s["scanned"] = False
            s["thermal_scanned"] = False
            s["assigned_to"] = None
            s["status"] = "unscanned"
            s["survivors_found"] = []
        
        # Generate survivors and hazards
        hazard_system.generate_hazards(self)
        self.survivors = survivor_system.generate_survivors(self, survivor_count)

        # Reset discovered survivors for new mission
        self.discovered_survivors = []
        self.mission_log.clear()
        
        # Initialize drones
        if not self.drones:
            count = active_drones if active_drones is not None else 5
            for i in range(count):
                did = f"drone_{i+1}"
                self.add_drone(did)
        elif active_drones is not None:
            existing = list(self.drones.keys())
            if len(existing) < active_drones:
                for i in range(len(existing), active_drones):
                    did = f"drone_{i+1}"
                    self.add_drone(did)

        for did in self.drones:
            self.drone_last_sector[did] = None

        log_event(f"Mission Started with {len(self.survivors)} survivors!", mission_log=self.mission_log)

        return {"status": "success", "message": "Mission started.", "survivor_count": len(self.survivors)}

    def _get_sector_at(self, x, z):
        """
        Return the sector ID for a given coordinate.
        """
        col = min(int(x / self.sector_width), self.sector_cols - 1)
        row = min(int(z / self.sector_height), self.sector_rows - 1)
        return f"S{row}_{col}"

    def _sector_line(self, a_sid: str | None, b_sid: str) -> list[str]:
        """Return ordered unique sector ids between a_sid and b_sid inclusive."""
        if not b_sid:
            return []
        if not a_sid or a_sid not in self.sectors:
            return [b_sid]
        a = self.sectors[a_sid]
        b = self.sectors[b_sid]
        ar, ac = a.get("row"), a.get("col")
        br, bc = b.get("row"), b.get("col")
        if None in (ar, ac, br, bc):
            return [b_sid]
        dr = br - ar
        dc = bc - ac
        steps = max(abs(dr), abs(dc)) or 1
        path = []
        for i in range(steps + 1):
            t = i / steps
            r = round(ar + dr * t)
            c = round(ac + dc * t)
            sid = f"S{r}_{c}"
            if sid not in path:
                path.append(sid)
        return path

    def get_sector_at(self, x, z):
        """
        Public helper for mapping coordinates to sector id.
        """
        return self._get_sector_at(x, z)


    def _battery_multiplier_at(self, x, z):
        """
        Return the battery drain multiplier at a given position based on the actual hazard.
        """
        sid = self._get_sector_at(x, z)
        return drone_system.hazard_multiplier_for_sector(
            sid,
            fire_multipliers=self.fire_multipliers,
            smoke_sectors=self.smoke_sector_ids,
            smoke_multiplier=self.smoke_multiplier,
        )

    def _detect_survivors_in_sector(self, sector_id: str):
        detected = []
        for s_data in self.survivors:
            if s_data.get("expired"):
                continue
            sx, sy, sz = s_data["pos"]
            if self._get_sector_at(sx, sz) == sector_id:
                detected.append(s_data["pos"])
        for pos in detected:
            if pos not in self.discovered_survivors:
                self.discovered_survivors.append(pos)
                log_event(f"🔥 NEW SURVIVOR FOUND in {sector_id} at {pos}!", mission_log=self.mission_log)
        return detected

    def _swarm_on_arrival(self, drone: Drone, sector_id: str | None):
        """Notify swarm to decide next action for this arrived drone."""
        try:
            world = {
                "sectors": self.sectors,
                "drones": {did: d.to_dict() for did, d in self.drones.items()},
                "grid_size": self.grid_size,
            }
            actions = swarm_system.swarm_step(
                list(self.drones.values()),
                world,
                None,
                None,
                waiting={drone.id},
            )
            if not actions:
                return
            act = actions[0] if len(actions) == 1 else actions[[d.id for d in self.drones.values()].index(drone.id)]
            if not act:
                return
            if act.get("action") == "move":
                tx, _, tz = act.get("target", (None, None, None))
                if tx is not None and tz is not None:
                    sid = act.get("sector") or self._get_sector_at(tx, tz)
                    self.set_drone_target(drone.id, sid, act.get("reason", "swarm_step"))
            elif act.get("action") == "return":
                self.set_drone_target(drone.id, "__RECALL__", act.get("reason", "swarm_return"))
        except Exception:
            pass

    def _auto_step_drone(self, drone: Drone, dt: float):
        """Advance drone toward its target using server-side autopilot."""
        if dt <= 0:
            return
        if drone.status in ["scanning", "charging", "offline"]:
            return
        target = drone.target_sector
        if not target:
            return

        # Destination
        if target == "__RECALL__":
            dest_x, dest_y, dest_z = drone.base_coordinates
        elif target in self.sectors:
            cx, cz = self.sectors[target]["center"]
            dest_x, dest_y, dest_z = cx, drone.coordinates[1], cz
        else:
            drone.target_sector = None
            return

        # Battery safety: divert to base
        reserve = settings.safety_margin
        if drone.battery_remaining <= reserve and target != "__RECALL__":
            dest_x, dest_y, dest_z = drone.base_coordinates
            target = "__RECALL__"
            drone.target_sector = "__RECALL__"

        ox, oy, oz = drone.coordinates
        dx, dy, dz = dest_x - ox, dest_y - oy, dest_z - oz
        dist = math.sqrt(dx * dx + dy * dy + dz * dz)
        if dist < 1e-6:
            return

        max_step = settings.autopilot_speed * dt
        if dist <= max_step:
            nx, ny, nz = dest_x, dest_y, dest_z
            arrived = True
        else:
            scale = max_step / dist
            nx = ox + dx * scale
            ny = oy + dy * scale
            nz = oz + dz * scale
            arrived = False

        # Drain battery for this move
        hazard_mult = self._battery_multiplier_at(ox, oz)
        wind_mult = hazard_system.wind_multiplier((ox, oy, oz), (nx, ny, nz), self.wind)
        cost = drone_system.move_drain((ox, oy, oz), (nx, ny, nz), settings, hazard_mult * wind_mult)

        # Move and drain
        drone.move_to(nx, ny, nz)
        drone.drain_battery(cost)

        # Auto scan along path
        last_sid = self.drone_last_sector.get(drone.id)
        current_sid = self._get_sector_at(nx, nz)
        self.drone_last_sector[drone.id] = current_sid
        for sid in self._sector_line(last_sid, current_sid):
            sector = self.sectors.get(sid)
            if not sector:
                continue
            scan_res = self.scan_sector(drone.id, sid, auto=True)
            if isinstance(scan_res, dict) and scan_res.get("error"):
                continue

        # Arrival handling
        if arrived:
            if target == "__RECALL__":
                for s in self.sectors.values():
                    if s.get("assigned_to") == drone.id:
                        s["assigned_to"] = None
                drone.move_to(*drone.base_coordinates)
                drone.set_status("charging")
                drone.charge()
                drone.target_sector = None
                drone.current_reason = None
                log_event(f"{drone.id} returned to base for charging.", drone_id=drone.id, mission_log=self.mission_log)
            else:
                drone.target_sector = None
                drone.current_reason = None
                log_event(f"🛰️ ARRIVED {drone.id} sector={current_sid}", drone_id=drone.id, mission_log=self.mission_log)
                try:
                    # drone.set_status("scanning")
                    self.thermal_scan(drone.id, current_sid)
                except Exception:
                    drone.set_status("idle")
        else:
            drone.set_status("moving")

    def log(self, message: str, level: str = "info", drone_id: str | None = None):
        """Convenience logger that also appends to mission_log for UI."""
        try:
            log_event(message, level=level, drone_id=drone_id, mission_log=self.mission_log)
        except Exception:
            pass

    def _record_hazard_redirect(self, drone_id: str, sector_id: str, reason: str | None = None):
        try:
            if sector_id not in self.sectors:
                return
            self.hazard_redirect_counter += 1
            cx, cz = self.sectors[sector_id].get("center", (None, None))
            evt = {
                "event_id": self.hazard_redirect_counter,
                "drone_id": drone_id,
                "sector_id": sector_id,
                "reason": reason or "hazard_redirect",
                "center": (cx, 5, cz),
                "ts": time.time(),
            }
            # keep recent only
            self.hazard_redirects.append(evt)
            # prune older than 5 seconds or keep last 50
            now = time.time()
            self.hazard_redirects = [e for e in self.hazard_redirects if now - e.get("ts", now) <= 5][-50:]
        except Exception:
            pass

    def update_drone_telemetry(self, drone_id: str, battery: float, x: float, y: float, z: float, status: str, clear_target: bool = False) -> dict:
        """Update a drone's telemetry coming from the UI or an external controller."""
        if drone_id not in self.drones:
            return {"error": f"Drone {drone_id} not found"}

        drone = self.drones[drone_id]
        drone.battery_remaining = battery
        drone.coordinates = (x, y, z)
        drone.status = status

        # Passive hazard discovery + fly-over scans (coarse telemetry safe)
        try:
            center_sid = self._get_sector_at(x, z)
            last_sid = self.drone_last_sector.get(drone_id)
            self.drone_last_sector[drone_id] = center_sid
            center = self.sectors.get(center_sid)
            try:
                if last_sid != center_sid:
                    log_event(
                        "telemetry sector_change from=%s to=%s pos=(%.1f,%.1f,%.1f) battery=%.2f"
                        % (last_sid, center_sid, x, y, z, battery),
                        drone_id=drone_id,
                        mission_log=self.mission_log,
                    )
            except Exception:
                pass

            # First telemetry tick: record position but skip discovery/auto-scan to avoid stamping base as scanned
            if last_sid is None:
                return {"status": "success"}

            def _sector_line(a_sid: str | None, b_sid: str) -> list[str]:
                """Return ordered unique sector ids between a_sid and b_sid inclusive."""
                if not a_sid or a_sid not in self.sectors:
                    return [b_sid]
                a = self.sectors[a_sid]
                b = self.sectors[b_sid]
                ar, ac = a.get("row"), a.get("col")
                br, bc = b.get("row"), b.get("col")
                if None in (ar, ac, br, bc):
                    return [b_sid]
                dr = br - ar
                dc = bc - ac
                steps = max(abs(dr), abs(dc)) or 1
                path = []
                for i in range(steps + 1):
                    t = i / steps
                    r = round(ar + dr * t)
                    c = round(ac + dc * t)
                    sid = f"S{r}_{c}"
                    if sid not in path:
                        path.append(sid)
                return path

            # 3x3 neighbor discovery for current tile
            if center and center_sid != last_sid:
                c_row, c_col = center.get("row"), center.get("col")
                neighbor_ids = []
                for dr in (-1, 0, 1):
                    for dc in (-1, 0, 1):
                        nr, nc = c_row + dr, c_col + dc
                        if 0 <= nr < self.sector_rows and 0 <= nc < self.sector_cols:
                            neighbor_ids.append(f"S{nr}_{nc}")

                for sid in neighbor_ids:
                    sector = self.sectors.get(sid)
                    if not sector:
                        continue
                    old_hazard = sector.get("hazard")
                    sector["discovered"] = True
                    sector["hazard"] = sector["true_hazard"]
                    new_hazard = sector.get("hazard")
                    if new_hazard not in (None, "clear", "unknown") and new_hazard != old_hazard:
                        log_event(
                            "detected hazard passively sector=%s hazard=%s position=(%.1f,%.1f,%.1f)"
                            % (sid, new_hazard, x, y, z),
                            drone_id=drone_id,
                            mission_log=self.mission_log,
                        )

            # Fly-over scans across every crossed sector
            hazard_hit = None
            scan_failures = set()
            if center_sid != last_sid:
                for sid in _sector_line(last_sid, center_sid):
                    sector = self.sectors.get(sid)
                    if not sector:
                        continue
                    scan_res = self.scan_sector(drone_id, sid, auto=True)
                    log_event(
                        "auto_scan_attempt sector=%s hazard=%s error=%s scanned=%s discovered=%s"
                        % (
                            sid,
                            scan_res.get("hazard") if isinstance(scan_res, dict) else None,
                            scan_res.get("error") if isinstance(scan_res, dict) else None,
                            sector.get("scanned"),
                            sector.get("discovered"),
                        ),
                        drone_id=drone_id,
                        mission_log=self.mission_log,
                    )
                    if isinstance(scan_res, dict) and scan_res.get("error"):
                        if sid not in scan_failures:
                            scan_failures.add(sid)
                            log_event(
                                "auto_scan_failed sector=%s error=%s distance=%.2f"
                                % (sid, scan_res.get("error"), scan_res.get("distance", -1)),
                                drone_id=drone_id,
                                mission_log=self.mission_log,
                            )
                        continue
                    if isinstance(scan_res, dict) and scan_res.get("hazard_detected") and not hazard_hit:
                        hazard_hit = {
                            "sector_id": sid,
                            "center": sector.get("center"),
                            "hazard": scan_res.get("hazard"),
                        }

            if hazard_hit:
                try:
                    # Drop lower-priority redirects when already pursuing fire, to prevent oscillation
                    current_target = getattr(drone, "target_sector", None)
                    current_hazard = self.sectors.get(current_target, {}).get("hazard") if current_target else None
                    hit_hazard = (hazard_hit.get("hazard") or "").lower()

                    if (current_hazard or "").lower() == "fire" and hit_hazard != "fire":
                        hazard_hit = None  # ignore smoke/unknown if already on fire target
                    elif (current_hazard or "").lower() == "fire" and hit_hazard == "fire":
                        cur_center = self.sectors.get(current_target, {}).get("center") if current_target else None
                        new_center = hazard_hit.get("center")
                        pos = getattr(drone, "coordinates", None)
                        if cur_center and new_center and pos:
                            cur_dist = math.hypot(cur_center[0] - pos[0], cur_center[1] - pos[2])
                            new_dist = math.hypot(new_center[0] - pos[0], new_center[1] - pos[2])
                            if new_dist >= cur_dist:
                                hazard_hit = None  # keep current fire target if it's nearer

                    if hazard_hit:
                        self._record_hazard_redirect(drone_id, hazard_hit.get("sector_id"), hazard_hit.get("hazard"))
                        return {"status": "success", "hazard_hit": hazard_hit}
                except Exception:
                    pass
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
        """
        Returns list of drones.
        """
        return list(self.drones.keys())

    def add_drone(self, drone_id: str = None, x: float = None, z: float = None) -> dict:
        """
        Add a new drone to the rescue fleet.
        If drone_id is not provided, generates one automatically.
        If position is not provided, places drone at base camp.
        """

        if not drone_id:
            existing_nums = [int(d.split('_')[1]) for d in self.drones.keys() if d.startswith('drone_') and d.split('_')[1].isdigit()]
            next_num = max(existing_nums, default=0) + 1
            drone_id = f"drone_{next_num}"

        if drone_id in self.drones:
            return {"error": f"Drone {drone_id} already exists"}

        if x is None:
            x = settings.base_x
        if z is None:
            z = settings.base_z

        offset = len([d for d in self.drones.values() if d.status == "active" and abs(d.coordinates[0] - x) < 5 and abs(d.coordinates[2] - z) < 5])
        x = x + offset * 2

        new_drone = Drone(drone_id, 100, "active", (x, 5, z))
        self.drones[drone_id] = new_drone
        self.drone_last_sector[drone_id] = None

        log_event(f"🚁 NEW DRONE ADDED: {drone_id} at ({x:.1f}, 5, {z:.1f}) with 100% battery", mission_log=self.mission_log)

        return {
            "status": "success",
            "drone_id": drone_id,
            "battery": 100,
            "position": [x, 5, z],
            "fleet_size": len(self.drones)
        }

    def get_fleet_status(self):
        """
        Get all drone's status.
        """
        return {did: d.to_dict() for did, d in self.drones.items()}

    def get_drone_status(self, drone_id):
        """
        Obtain latest drone status.
        """
        if drone_id not in self.drones:
            return {"error": f"Drone {drone_id} not found"}
        return self.drones[drone_id].to_dict()

    def set_drone_target(self, drone_id, sector_id, reason=None):
        """
        Assign a drone to a sector with specific reasoning. Note that it does not handle the actual movement,
        it only helps to check whether this action is valid.
        """

        # Check whether drone is valid
        if drone_id not in self.drones:
            return {"error": f"Drone {drone_id} not found"}
        
        drone = self.drones[drone_id]

        # Do not change targets while the drone is performing a thermal scan
        # if drone.status == "scanning" or getattr(drone, "scanning_pending", False):
        #     return {"error": f"Drone {drone_id} is scanning; target change deferred"}

        # Check sector status
        if sector_id not in self.sectors:
            drone.target_sector = None
            return {"error": f"Sector {sector_id} not found"}
        
        # Clear upcoming assignment if it exists and not scanned
        if drone.target_sector and drone.target_sector in self.sectors:
            old_s = self.sectors[drone.target_sector]
            if old_s["assigned_to"] == drone_id:
                if not old_s.get("scanned"):
                    old_s["assigned_to"] = None
                    if old_s["status"] == "assigned":
                        old_s["status"] = "unscanned"
        
        # Handle recall command
        if sector_id == "__RECALL__":
            log_event(f"STATE: {drone_id} target set to __RECALL__", drone_id=drone_id, mission_log=self.mission_log)
            return {"status": "success", "drone_id": drone_id, "target": "__RECALL__"}

        # Estimate battery usage for round trip (aligned with move_drain/scan_drain)
        center = self.sectors[sector_id]["center"]
        hazard_mult = drone_system.hazard_multiplier_for_sector(
            sector_id,
            fire_multipliers=self.fire_multipliers,
            smoke_sectors=self.smoke_sector_ids,
            smoke_multiplier=self.smoke_multiplier,
        )
        to_target = math.hypot(center[0] - drone.coordinates[0], center[1] - drone.coordinates[2])
        to_base = math.hypot(center[0] - settings.base_x, center[1] - settings.base_z)
        move_cost = (to_target + to_base) * settings.drain_per_unit
        scan_cost = drone_system.scan_drain(settings, hazard_mult)
        round_trip_cost = move_cost + scan_cost + settings.safety_margin
        if drone.battery_remaining < round_trip_cost:
            # auto-divert to base instead of leaving drone idle
            drone.target_sector = "__RECALL__"
            log_event(
                "insufficient battery=%.2f need~=%.2f sector=%s -> recall"
                % (drone.battery_remaining, round_trip_cost, sector_id),
                drone_id=drone_id,
                mission_log=self.mission_log,
            )
            return {
                "status": "recall",
                "drone_id": drone_id,
                "target": "__RECALL__",
                "reason": "battery_recall",
            }

        # Update sector status
        self.sectors[sector_id]["assigned_to"] = drone_id
        self.sectors[sector_id]["status"] = "assigned"

        # Apply target lock to reduce oscillation; shorter lock for smoke
        try:
            lock_secs = 4.0
            if reason and isinstance(reason, str) and "smoke" in reason.lower():
                lock_secs = 2.0
            drone.target_lock_until = time.time() + lock_secs
        except Exception:
            pass

        # Update drone's target sector and reason
        drone.target_sector = sector_id
        drone.current_reason = reason

        try:
            if reason and "hazard" in reason.lower():
                self._record_hazard_redirect(drone_id, sector_id, reason)
        except Exception:
            pass

        log_event(
            "target set sector=%s reason=%s battery=%.2f" % (sector_id, reason, drone.battery_remaining),
            drone_id=drone_id,
            mission_log=self.mission_log,
        )

        return {"status": "success", "drone_id": drone_id, "target": sector_id}

    def get_world_state(self):
        """
        Returns the complete ground truth of the simulation.
        """

        try:
            if not hasattr(self, "survivors"):
                self.survivors = survivor_system.generate_survivors(self)
            hazard_system.update_wind(self)
            now = time.time()
            
            # Server-side autopilot disabled (UI drives movement). Keep clock in sync.
            self.last_move_time = now
            
            # Reduce drone battery in idle mode
            if self.paused:
                self.last_drain_time = now
                delta = 0
            else:
                delta = now - getattr(self, 'last_drain_time', now)
            if delta > 0.5:
                drone_system.idle_drain(self.drones, delta)
                self.last_drain_time = now
            
            # Update environment statistics
            scannable = sum(1 for sid, s in self.sectors.items())
            scanned = sum(1 for sid, s in self.sectors.items() if s["scanned"])
            found = len(self.discovered_survivors)
            total_needed = len(self.survivors)
            discovered = sum(1 for sid, s in self.sectors.items() if s.get("discovered"))

            # Check survivor expiry based on time limits (no instant death)
            elapsed = now - self.start_time - self.total_paused_duration
            survivor_system.mark_expired_survivors(self, elapsed_seconds=elapsed)

            # Check if mission is complete (coverage 100%)
            if self.mission_status == "active":
                if scannable > 0 and scanned >= scannable:
                    self.mission_status = "success"
                    log_event(f"Mission Complete: All {scannable} scannable sectors cleared.", mission_log=self.mission_log)

            # Prepare drone states for response
            drones_state = {}
            for did in self.drones:
                drones_state[did] = self.get_drone_status(did)
            thermal_scanned_count = sum(1 for s in self.sectors.values() if s.get("thermal_scanned", False))
                
            ground_truth_hazards = {sid: "fire" for sid in self.fire_sector_ids}
            ground_truth_hazards.update({sid: "smoke" for sid in self.smoke_sector_ids if sid not in ground_truth_hazards})

            # Short-lived hazard redirect events (last 5s)
            now = time.time()
            redirects = [e for e in self.hazard_redirects if now - e.get("ts", now) <= 5]
            self.hazard_redirects = redirects  # prune

            return {
                "mission_status": self.mission_status,
                "mission_complete": self.mission_status in ["success", "failure"],
                "paused": self.paused,
                "found_survivors": found,
                "total_survivors": total_needed,
                "sectors_scanned": scanned,
                "total_scannable_sectors": scannable,
                "sectors_discovered": discovered,
                "discovery_pct": int((discovered / scannable) * 100) if scannable > 0 else 0,
                "coverage_pct": int((thermal_scanned_count / scannable) * 100) if scannable > 0 else 0,
                "thermal_scanned": thermal_scanned_count,
                "drones": drones_state,
                "sectors": self.sectors,
                "discovered_survivors": self.discovered_survivors,
                "all_survivors": [{"pos": s["pos"], "expired": s["expired"]} for s in self.survivors],
                "wind": self.wind,
                "ground_truth_hazards": ground_truth_hazards,
                "hazard_redirects": redirects,
                "mission_log": self.mission_log[-20:],
                "elapsed_seconds": int(elapsed),
            }
        except Exception as e:
            with open("/tmp/engine_error.log", "a") as f:
                f.write(f"\n--- ERROR IN get_world_state ({time.ctime()}) ---\n")
                traceback.print_exc(file=f)
            raise e

    def move_to(self, drone_id, x, y, z):
        """
        Handles the actual drone movement logic, also considers battery drain logic due to hazards.
        """
        # Drone checks
        if drone_id not in self.drones:
            return {"error": f"Drone {drone_id} not found"}
        drone = self.drones[drone_id]

        # Ensure drone is in a state where it can move
        # scanning: cannot change as it is currently scanning
        # if drone.status in ["scanning"]:
        #     return {"error": f"Drone {drone_id} is {drone.status}, cannot move"}

        # Check if destination sector is valid
        dest_sector = self._get_sector_at(x, z)
        if dest_sector not in self.sectors:
            return {"error": f"Destination sector {dest_sector} not found"}

        # Calculate hazard constraints
        old_coords = drone.coordinates
        hazard_mult = self._battery_multiplier_at(old_coords[0], old_coords[2])
        wind_mult = hazard_system.wind_multiplier(old_coords, (x, y, z), self.wind)
        total_mult = hazard_mult * wind_mult

        # Move the drone
        drone.move_to(x, y, z)

        # Decrease battery
        cost = drone_system.move_drain(old_coords, (x, y, z), settings, total_mult)
        drone.drain_battery(cost)

        # Labelling for logs
        hazard_label = ""
        if dest_sector in self.fire_sector_ids:
            hazard_label = " [🔥 FIRE ZONE]"
        elif dest_sector in self.smoke_sector_ids:
            hazard_label = " [💨 SMOKE]"

        log_event(
            "move to=(%.1f,%.1f,%.1f) from=%s hazard_label=%s battery=%.2f mult=%.2f"
            % (x, y, z, old_coords, hazard_label, drone.battery_remaining, total_mult),
            drone_id=drone_id,
            mission_log=self.mission_log,
        )

        # Return drone condition
        return drone.to_dict()

    def thermal_scan(self, drone_id, sector_id=None):
        """
        Perform thermal scan to detect for survivors, takes 3 seconds (default) for each action.
        """

        # Ensure drone is valid
        if drone_id not in self.drones:
            return {"error": f"Drone {drone_id} not found"}
        drone = self.drones[drone_id]

        # Ensure drone is in a state where it can scan
        # if getattr(drone, "scanning_pending", False):
        #     return {"error": f"Drone {drone_id} already has a scan pending"}
        # if drone.status in ["scanning"]:
        #     return {"error": f"Drone {drone_id} is {drone.status}, cannot scan"}

        # Mark scan as pending to prevent retarget during preflight checks
        drone.scanning_pending = True

        drone.status = "scanning"

        # Determine the sector to scan
        if sector_id and sector_id in self.sectors:
            current_sid = sector_id
        else:
            drone_x, _, drone_z = drone.coordinates
            current_sid = self._get_sector_at(drone_x, drone_z)

        SCAN_RADIUS = settings.thermal_scan_radius

        sector_center = self.sectors[current_sid]["center"]
        drone_x, _, drone_z = drone.coordinates

        # Ensure distance is within range
        dist_to_center = math.hypot(drone_x - sector_center[0], drone_z - sector_center[1])
        if dist_to_center > SCAN_RADIUS:
            drone.scanning_pending = False
            return {
                "error": f"Drone {drone_id} is too far from sector {current_sid} centre "
                         f"({dist_to_center:.1f}u > {SCAN_RADIUS}u). Move closer before scanning.",
                "drone_position": list(drone.coordinates),
                "sector_center": list(sector_center),
                "distance": round(dist_to_center, 1),
                "required_radius": SCAN_RADIUS,
            }

        # # Set status to scanning for the duration
        # drone.set_status("scanning")

        # Simulate 3 seconds scan
        time.sleep(3)

        try:
            log_event(f"thermal_scan start drone={drone_id} sector={current_sid}", drone_id=drone_id, mission_log=self.mission_log)
        except Exception:
            pass

        # Detect survivor here
        detected = []
        for s_data in self.survivors:
            if s_data["expired"]:
                continue
            sx, sy, sz = s_data["pos"]
            if self._get_sector_at(sx, sz) == current_sid:
                detected.append(s_data["pos"])

        # Calculate battery usage
        multiplier = self._battery_multiplier_at(drone.coordinates[0], drone.coordinates[2])
        scan_cost = drone_system.scan_drain(settings, multiplier)
        drone.drain_battery(scan_cost)

        # Mark sector so we don't re-request thermal scans on every assign loop
        if current_sid in self.sectors:
            self.sectors[current_sid]["thermal_scanned"] = True

        # Reset status to idle after scan completes (unless battery killed it)
        if drone.status != "offline":
            drone.set_status("idle")
            try:
                # Trigger swarm to pick next action after scan completes
                self._swarm_on_arrival(drone, current_sid)
            except Exception:
                pass
        drone.scanning_pending = False

        # Report new survivor found
        for s in detected:
            if s not in self.discovered_survivors:
                self.discovered_survivors.append(s)
                log_event(f"🔥 NEW SURVIVOR FOUND by {drone_id} in {current_sid} at {s}!", drone_id=drone_id, mission_log=self.mission_log)
        
        drone.scanning_pending = False

        return {
            "drone": drone_id,
            "position": list(drone.coordinates),
            "sector": current_sid,
            "detected_count": len(detected),
            "detected": [list(s) for s in detected],
            "battery_after": round(drone.battery_remaining, 1),
        }

    def recall_for_charging(self, drone_id):
        """
        Recall a drone for charging. Does not decide whether to recall or not.
        """
        if drone_id not in self.drones:
            return {"error": f"Drone {drone_id} not found"}

        drone = self.drones[drone_id]

        # Release assigned sectors
        for s in self.sectors.values():
            if s["assigned_to"] == drone_id:
                s["assigned_to"] = None

        # Prepare for charging
        drone.move_to(*drone.base_coordinates)
        drone.set_status("charging")
        drone.charge()

        log_event(f"{drone_id} recalled for charging. Battery restored to 100%.", drone_id=drone_id, mission_log=self.mission_log)
        return drone.to_dict()

    def scan_sector(self, drone_id, sector_id, *, auto: bool = False):
        """
        Hazard-only scan. Does not intentionally stop to scan.
        """
        
        # Drone and sector check
        if drone_id not in self.drones:
            return {"error": f"Drone {drone_id} not found"}
        if sector_id not in self.sectors:
            return {"error": f"Sector {sector_id} not found"}

        drone = self.drones[drone_id]
        sector = self.sectors[sector_id]
        cx, cz = sector["center"]

        SCAN_RADIUS = settings.sector_scan_radius

        # Check if drone is within range to scan
        dist = math.hypot(drone.coordinates[0] - cx, drone.coordinates[2] - cz)
        if not auto and dist > SCAN_RADIUS:
            return {"error": f"too_far", "distance": dist, "required": SCAN_RADIUS}

        # Skip redundant auto-scans of already scanned sectors to reduce oscillation/noise
        if auto and sector.get("scanned"):
            return {
                "status": "skipped",
                "already_scanned": True,
                "sector": sector_id,
                "hazard": sector.get("hazard"),
                "hazard_detected": False,  # avoid re-triggering redirects on known scans
                "distance": dist,
                "auto": True,
            }

        # Update sector state  
        sector["scanned"] = True
        sector["discovered"] = True
        sector["hazard"] = sector.get("true_hazard")
        sector["assigned_to"] = None
        hazard = sector["hazard"]

        log_event(
            "scan_sector sector=%s hazard=%s auto=%s dist=%.2f"
            % (sector_id, hazard, auto, dist),
            drone_id=drone_id,
            mission_log=self.mission_log,
        )

        return {
            "drone": drone_id,
            "sector": sector_id,
            "hazard": hazard,
            "hazard_detected": hazard in ("fire", "smoke"),
            "distance": dist,
            "auto": auto,
        }

    def toggle_pause(self, paused: bool = None):
        """
        Toggle between simulation pause and resume.
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
            log_event("⏸ Simulation Paused", mission_log=self.mission_log)
        else:
            if self.pause_start_time > 0:
                self.total_paused_duration += (now - self.pause_start_time)
            log_event("▶ Simulation Resumed", mission_log=self.mission_log)
        
        return {"status": "success", "paused": self.paused}
