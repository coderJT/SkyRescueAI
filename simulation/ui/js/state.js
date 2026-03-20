// Centralised UI state container
export function initState(settings) {
  const GRID = settings.grid_size ?? 200;
  const SECTORS = settings.sector_rows ?? 10;
  const CELL = GRID / SECTORS;
  // Visual scan/discovery radius: cover ~3x3 sectors (cell * 2.2). Engine scan stays 1x1.
  const SCAN_RADIUS = CELL * 2.2;

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
        metrics: {
            coverage_pct: 0,
            discovery_pct: 0,
            sectors_scanned: 0,
            sectors_discovered: 0,
            sectors_total: 0,
            thermal_scanned: 0,
            survivors_found: 0,
            total_survivors: 0,
            elapsed: 0,
        },
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
