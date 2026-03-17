import uuid
import math

"""
Drone class. Here we contain the state logic for a single drone instance. System level logic 
will be implemented in a separate system file for clarity.
"""
class Drone:

    def __init__(self, battery=100, x=0, y=0, z=0):
        self.id = id
        self.battery = battery
        self.coordinates = (0, 0, 0)

    def get_battery(self) -> float:
        return self.battery
    
    def get_coordinates(self) -> tuple[int, int, int]:
        return self.coordinates

    def move_to(self, x, y, z):
        """
        Moves the drone to a specific coordinate using the Euclidean distance formula. 
        Note that the battery reduction logic should not be implemented here.
        """
        old_x, old_y, old_z = self.coordinates
        distance = math.sqrt((x - old_x)**2 + (y - old_y)**2 + (z - old_z)**2)
        self.coordinates = (x, y, z)

    def thermal_scan():
        """
        Uses thermal imaging technology to detect heat presence, which in turns detect survivors
        in this scenario. For realistic purposes, in future implementation, we will be using 
        a custom built machine learning model to perform this task.
        """
        pass

    def detect_surroundings(self):
        """
        Simulates vision of nearby surrounding to detect disaster signs (e.g. for wildfire, it would 
        be fire and smokes..). For realistic purposes too, we will be using a machine learning model, tuned
        for each possible natural disasters for fast and accurate detection.
        """
        pass
    
    


