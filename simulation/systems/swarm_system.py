"""
Swarm intelligence. (Behaviour)

How do drones behave given a high level goal?
"""

def detect_neighbours():
    """
    Detect neighbours and avoid possible collisions.
    """
    pass

def exploration():
    """
    Exploration behaviour.
    """
    pass

def respond_to_hazard():
    """
    Avoid hazards such as fire and smoke.
    """
    pass

def respond_to_human():
    """
    Respond to human presence.
    """
    pass

def return_to_base():
    """
    Return to base in case of low battery.
    """
    pass

def drone_behaviour_control(drone, world):
    
    neighbours = detect_neighbours()

    # Check for battery

    # Respond to hazard if world contains hazard coordinates (maybe other drones have detected signs of hazard
    # and therefore we need to assist them, only if necessary)
        # Perform thermal scan on the hazards


    # Default: explore:

def swarm_step(drones, world):
    for drone in drones:
        drone_behaviour_control(drone, world)