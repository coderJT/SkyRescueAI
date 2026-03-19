// Centralised UI state container
export function initState(settings) {
  const GRID = settings.grid_size ?? 200;
  const SECTORS = settings.sector_rows ?? 10;
  const CELL = GRID / SECTORS;
  const SCAN_RADIUS = settings.passive_survivor_radius ?? 18.0;

    return {
        SETTINGS: settings,
        GRID,
        SECTORS,
        CELL,
        SCAN_RADIUS,
        time: 0,
        hazards: [],
        humans: [],
        wind: null,
        strategy: null,
        constraints: {},
        metrics: { coverage_pct: 0, survivors_found: 0 },
        explored_sectors: new Set(),
        MOVE_SPEED: 0.2,
        isPaused: false,
        pauseStartTime: 0,
        totalPausedTime: 0,
        showScannedSectors: false,
    logFilter: 'all',
    showMCP: false,
    thoughtIdCounter: 0,
    isBatchThinking: false,
    missionComplete: false,
    activeDrone: -1,
    // Collections
    DRONE_COLORS: [],
    DRONE_NAMES: ['drone_1', 'drone_2', 'drone_3', 'drone_4', 'drone_5'],
    SURVIVORS: [],
    BASE: { x: 5, z: 5 },
    drones: [],
    scanSpheres: [],
    thoughtLogs: [[], [], [], [], []],
    NO_FLY_MACRO: [],
    NO_FLY: new Set(),
    FIRE: new Set(),
    SMOKE: new Set(),
    obstacles: [],
    sectorMeshes: {},
    survivorMeshes: [],
    fireParticles: [],
    smokePlanes: [],
  };
}
