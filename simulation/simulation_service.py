"""
Simululation Service class. This will act as the bridge between connecting the mcp server and the simulation
environment. Here, we will be implementing the actual logic to modify the simulation environment.
"""
class SimulationService:

    def __init__(self, world):
        self.world = world

    def get_all_drones(self):
        pass

    def get_drone_status(self, id):
        pass

    def move_drone_to(self, id, x, y, z):
        pass

    def discover_surroundings_of_drone(self, id):
        pass

    def thermal_scan_of_drone(self, id):
        pass

    def get_known_hazard_coordinates(self):
        pass

    def get_unknown_hazard_coordinates(self):
        pass


        

