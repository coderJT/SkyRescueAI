from simulation.config.settings import settings


class Drone:
    """Lightweight drone state container used by the simulation engine."""

    def __init__(self, drone_id: str, battery: float = 100.0, status: str = "active", coordinates=(0, 5, 0)):
        self.id = drone_id
        self.battery_remaining = battery
        self.status = status
        self.coordinates = coordinates
        self.base_coordinates = (settings.base_x, 5, settings.base_z)
        self.target_sector = None
        self.current_reason = None
        self.nav = None
        self.scanning_pending = False
        self.force_recall_requested = False

    def move_to(self, x: float, y: float, z: float):
        self.coordinates = (x, y, z)

    def drain_battery(self, amount: float):
        """Reduce battery by amount, clamped to [0, 100]."""
        try:
            amt = float(amount)
        except Exception:
            amt = 0.0
        self.battery_remaining = max(0.0, self.battery_remaining - max(0.0, amt))
        if self.battery_remaining <= 0:
            self.status = "offline"

    def charge(self, amount: float = 100.0):
        """Charge battery by amount (default to full top-up)."""
        try:
            amt = float(amount)
        except Exception:
            amt = 0.0
        self.battery_remaining = min(100.0, self.battery_remaining + max(0.0, amt))
        if self.battery_remaining > 0 and self.status == "offline":
            self.status = "active"

    def set_status(self, status: str):
        self.status = status

    def to_dict(self):
        return {
            "id": self.id,
            "battery": round(self.battery_remaining, 1),
            "status": self.status,
            "coordinates": list(self.coordinates),
            "target_sector": self.target_sector,
            "reason": self.current_reason,
        }
