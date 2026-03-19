import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mcpClient, connectMcp } from './api.js';
import { initState } from './state.js';
import { registerHud } from './hud.js';
import { initMinimap } from './minimap.js';
import { DRONE_FLY_HEIGHT, OBSTACLE_RADIUS, AVOIDANCE_LOOKAHEAD, AVOIDANCE_STRENGTH, getRandomDroneColor, hslWithAlpha, hazardOf as hazardOfFn } from './utils.js';
import { initLogs } from './logs.js';

// Safe placeholder before async init completes
window.startMission = window.startMission || (() => console.warn('Simulation initializing...'));
let initReady = false;

(async function init() {
const SETTINGS = await (window.fetchSettings ? window.fetchSettings().catch(() => ({})) : Promise.resolve({}));
const state = initState(SETTINGS);
const {
    GRID, SECTORS, CELL, SCAN_RADIUS,
    DRONE_COLORS, DRONE_NAMES, SURVIVORS, BASE, drones, scanSpheres,
    thoughtLogs, NO_FLY_MACRO, NO_FLY, FIRE, SMOKE, obstacles, sectorMeshes,
    survivorMeshes, fireParticles, smokePlanes
} = state;
const DRAIN_PER_UNIT = SETTINGS.drain_per_unit ?? 0.2;

let isPaused = false;
let pauseStartTime = 0;
let totalPausedTime = 0;
let showScannedSectors = false;
let MOVE_SPEED = 0.2;
let activeDrone = -1;

// Kick off MCP connection early; do not abort UI if MCP is down
try {
  await connectMcp();
} catch (e) {
  console.error('MCP/API connection failed:', e);
}
registerHud({
    getIsPaused: () => isPaused,
    setIsPaused: (v) => { isPaused = v; },
    markPauseStart: (t) => { pauseStartTime = t; },
    addPausedDuration: (now) => { totalPausedTime += (now - pauseStartTime); },
    setShowScanned: (fn) => { showScannedSectors = typeof fn === 'function' ? fn(showScannedSectors) : !!fn; return showScannedSectors; },
    setMoveSpeed: (v) => { MOVE_SPEED = v; },
}, mcpClient);

// Only enable LLM/coordination mode when a real MCP backend is present
const useLLM = mcpClient && mcpClient.connected;

const utils = { getRandomDroneColor, hslWithAlpha, hazardOf: (r, c) => hazardOfFn(state, r, c) };
const hazardOf = utils.hazardOf;
const { drawMinimap } = initMinimap(state, utils);
const { addThought, addMCP, renderThoughts, setLogFilter, updateFilterButtons } = initLogs(state, utils, mcpClient);

function finishScan(droneIdx) {
    const d = drones[droneIdx];
    if (!d || !d.target || !d.target.sector) {
        if (d) { d.state = "idle"; d.target = null; d.scanTimer = 0; }
        return;
    }
    const sectorId = d.target.sector;
    // Optimistically mark scanned locally to prevent re-assignment loops
    const sm = sectorMeshes[sectorId];
    if (sm) { sm.scanned = true; sm.discovered = true; }

    d.state = "waiting_scan_result";
    d.scanTimer = 0;
    const call = mcpClient && mcpClient.connected
        ? mcpClient.callTool('scan_sector', { id: `drone_${droneIdx + 1}`, sector_id: sectorId })
        : Promise.reject(new Error('MCP not connected'));

    call.then((resp) => {
        d.scanCooldown = 2.0;
        d.state = "idle";
        d.target = null;
        addThought(droneIdx, 'info', `✅ Finished scanning ${sectorId}.`);
    }).catch((e) => {
        d.scanCooldown = 2.0;
        d.state = "idle";
        d.target = null;
        addThought(droneIdx, 'warning', `Scan failed for ${sectorId}: ${e?.message || e}`);
    });
}

// --- Settings panel wiring ---
const settingsToggle = document.getElementById('settings-toggle');
const settingsPanel = document.getElementById('settings-panel');
const settingsForm = document.getElementById('settings-form');
const settingsSave = document.getElementById('settings-save');
const settingsStatus = document.getElementById('settings-status');

if (settingsForm) {
    const apiBase = window.API_BASE || localStorage.getItem('API_BASE') || 'http://localhost:8000';
    settingsForm.innerHTML = `
        <div class="settings-row"><label>API Base</label><input id="settings-api-base" type="text" value="${apiBase}"></div>
        <div class="settings-row"><label>Drain / unit</label><input id="settings-drain" type="number" step="0.01" value="${SETTINGS.drain_per_unit ?? 0.12}"></div>
        <div class="settings-row"><label>Scan cost</label><input id="settings-scan" type="number" step="0.1" value="${SETTINGS.scan_cost ?? 0.7}"></div>
        <div class="settings-row"><label>Safety margin</label><input id="settings-safety" type="number" step="0.1" value="${SETTINGS.safety_margin ?? 6.0}"></div>
        <div class="settings-row"><label>Wind speed km/h</label><input id="settings-wind-speed" type="number" step="0.1" value="${SETTINGS.wind_speed_kmh ?? 32}"></div>
        <div class="settings-row"><label>Wind angle deg</label><input id="settings-wind-angle" type="number" step="1" value="${SETTINGS.wind_angle_deg ?? 45}"></div>
    `;
}

settingsToggle?.addEventListener('click', () => {
    settingsPanel?.classList.toggle('open');
});

settingsSave?.addEventListener('click', () => {
    const apiInput = document.getElementById('settings-api-base');
    const drain = document.getElementById('settings-drain');
    const scan = document.getElementById('settings-scan');
    const safety = document.getElementById('settings-safety');
    const windSpeed = document.getElementById('settings-wind-speed');
    const windAngle = document.getElementById('settings-wind-angle');

    if (apiInput && apiInput.value) {
        localStorage.setItem('API_BASE', apiInput.value.trim());
        window.API_BASE = apiInput.value.trim();
    }
    const payload = {
        drain_per_unit: drain ? parseFloat(drain.value) : undefined,
        scan_cost: scan ? parseFloat(scan.value) : undefined,
        safety_margin: safety ? parseFloat(safety.value) : undefined,
        wind_speed_kmh: windSpeed ? parseFloat(windSpeed.value) : undefined,
        wind_angle_deg: windAngle ? parseFloat(windAngle.value) : undefined,
    };
    const base = window.API_BASE || localStorage.getItem('API_BASE') || 'http://localhost:8000';
    fetch(`${base}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    }).then(() => {
        if (settingsStatus) settingsStatus.textContent = 'Saved. Reloading...';
        setTimeout(() => window.location.reload(), 300);
    }).catch(() => {
        if (settingsStatus) settingsStatus.textContent = 'Save failed (API offline?)';
    });
});

// --- Hazard helpers (API fallback when MCP shim is in use) ---
async function fetchWorldHazards() {
    const base = window.API_BASE || 'http://localhost:8000';
    try {
        const res = await fetch(`${base}/state`, { method: 'GET' });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        console.warn('Failed to fetch world state via API fallback:', e.message || e);
        return null;
    }
}

function applyHazardsFromWorld(world) {
    if (!world || !world.sectors) return;
    FIRE.clear();
    SMOKE.clear();
    Object.values(sectorMeshes).forEach(s => {
        s.hazard = 'clear';
        s.mesh.material.color.setHex(0x0f2f0f);
        s.mesh.material.opacity = 0.6;
    });
    Object.values(world.sectors).forEach(sec => {
        const sid = sec.id || sec.sector_id || `S${sec.row}_${sec.col}`;
        const h = sec.true_hazard || sec.hazard || 'clear';
        if (h === 'fire') {
            FIRE.add(sid);
            const sm = sectorMeshes[sid];
            if (sm) { sm.hazard = 'fire'; sm.mesh.material.color.setHex(0x2a0800); spawnFireAt(sid); }
        } else if (h === 'smoke') {
            SMOKE.add(sid);
            const sm = sectorMeshes[sid];
            if (sm) { sm.hazard = 'smoke'; sm.mesh.material.color.setHex(0x1a1508); spawnSmokeAt(sid); }
        }
    });
}

function registerObstacle(x, z, r, h) {
    obstacles.push({ x, z, radius: r || OBSTACLE_RADIUS, height: h || 20 });
}



// ─── THREE.JS SCENE ───
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x060810);
scene.fog = new THREE.FogExp2(0x060810, 0.003);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.shadowMap.enabled = false;
document.body.appendChild(renderer.domElement);

const cam = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 1000);
cam.position.set(100, 140, -30);
const controls = new OrbitControls(cam, renderer.domElement);
controls.target.set(100, 0, 100);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.maxPolarAngle = Math.PI / 2.1;

// Lights
const ambientLight = new THREE.AmbientLight(0x223344, 0.4);
scene.add(ambientLight);
const sun = new THREE.DirectionalLight(0xffddaa, 0.6);
sun.position.set(60, 120, 40);
scene.add(sun);
const hemiLight = new THREE.HemisphereLight(0x112233, 0x221100, 0.25);
scene.add(hemiLight);

// Sun & Moon meshes with lighting effects (glow & emitted light)
const sunGlow = new THREE.PointLight(0xffaa00, 2, 300);
const sunMesh = new THREE.Mesh(
    new THREE.SphereGeometry(15, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0xffffee, transparent: true, opacity: 0.9 })
);
// Outer halo for sun
const sunHalo = new THREE.Mesh(
    new THREE.SphereGeometry(18, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending })
);
sunMesh.add(sunHalo);
sunMesh.add(sunGlow);
sunMesh.position.set(120, 100, -80);
sunMesh.visible = false;
scene.add(sunMesh);

// Sync directional light with sun position
sun.position.copy(sunMesh.position);

const moonGlow = new THREE.PointLight(0x88aaff, 1.5, 200);
const moonMesh = new THREE.Mesh(
    new THREE.SphereGeometry(12, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0xccddff })
);
// Outer halo for moon
const moonHalo = new THREE.Mesh(
    new THREE.SphereGeometry(14, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0x6688ff, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending })
);
moonMesh.add(moonHalo);
moonMesh.add(moonGlow);
moonMesh.position.set(80, 100, -60);
moonMesh.visible = true;
scene.add(moonMesh);

let isNight = true;
window.toggleDayNight = function () {
    isNight = !isNight;
    const btn = document.getElementById('daynight-btn');
    if (isNight) {
        scene.background.setHex(0x060810);
        scene.fog.color.setHex(0x060810);
        ambientLight.intensity = 0.4;
        sun.intensity = 0.6;
        hemiLight.intensity = 0.25;
        sunMesh.visible = false;
        moonMesh.visible = true;
        if (btn) btn.textContent = '🌙 Night [N]';
    } else {
        scene.background.setHex(0x87CEEB);
        scene.fog.color.setHex(0x87CEEB);
        ambientLight.intensity = 1.2;
        sun.intensity = 1.4;
        hemiLight.intensity = 0.8;
        sunMesh.visible = true;
        moonMesh.visible = false;
        if (btn) btn.textContent = '☀️ Day [N]';
    }
};

// Ground
const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(GRID + 20, GRID + 20),
    new THREE.MeshStandardMaterial({ color: 0x0f1f0f, roughness: 0.95 })
);
ground.rotation.x = -Math.PI / 2; ground.position.set(GRID / 2, -0.01, GRID / 2);
ground.receiveShadow = false; scene.add(ground);

// ─── BASE STRUCTURE ───
// Charging Tower
const towerG = new THREE.Group();
const towerBaseGeo = new THREE.CylinderGeometry(4, 5, 2, 8);
const towerBase = new THREE.Mesh(towerBaseGeo, new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.8, roughness: 0.2 }));
towerG.add(towerBase);

const towerSpireGeo = new THREE.CylinderGeometry(0.5, 2.5, 25, 8);
const towerSpire = new THREE.Mesh(towerSpireGeo, new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.9, roughness: 0.1 }));
towerSpire.position.y = 12.5;
towerG.add(towerSpire);

// Emissive Core
const coreGeo = new THREE.SphereGeometry(1.5, 16, 16);
const coreMat = new THREE.MeshStandardMaterial({ color: 0x00ffff, emissive: 0x00ffff, emissiveIntensity: 2 });
const core = new THREE.Mesh(coreGeo, coreMat);
core.position.y = 23;
towerG.add(core);

// Lattice Rings
for (let i = 0; i < 3; i++) {
    const ringGeo = new THREE.TorusGeometry(3.5 - i * 0.8, 0.2, 8, 24);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshStandardMaterial({ color: 0x555555, metalness: 0.8 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 18 + i * 3;
    towerG.add(ring);
}

towerG.position.set(BASE.x, 0, BASE.z);
scene.add(towerG);

// Sector tiles
for (let r = 0; r < SECTORS; r++) for (let c = 0; c < SECTORS; c++) {
    const h = hazardOf(r, c);
    let color = 0x0f2f0f;
    if (h === "fire") color = 0x2a0800;
    else if (h === "smoke") color = 0x1a1508;
    const geo = new THREE.PlaneGeometry(CELL - 0.5, CELL - 0.5);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9, transparent: true, opacity: 0.6 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2; mesh.position.set(c * CELL + CELL / 2, 0.02, r * CELL + CELL / 2);
    mesh.receiveShadow = true; scene.add(mesh);
    const k = `S${r}_${c}`;
    sectorMeshes[k] = { mesh, hazard: h, scanned: false, discovered: false, r, c, k };
    const edges = new THREE.EdgesGeometry(geo);
    const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x223322, transparent: true, opacity: 0.2 }));
    line.rotation.x = -Math.PI / 2; line.position.copy(mesh.position); line.position.y = 0.03; scene.add(line);
}

// ─── TREE GENERATION ───
// Trees across ALL sectors with density varying by hazard type
const treeMaterials = {
    trunk: new THREE.MeshStandardMaterial({ color: 0x3a2515, roughness: 0.9 }),
    trunkBurned: new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.95 }),
    canopyDark: new THREE.MeshStandardMaterial({ color: 0x0a3a0a, roughness: 0.7 }),
    canopyMed: new THREE.MeshStandardMaterial({ color: 0x154a15, roughness: 0.75 }),
    canopyLight: new THREE.MeshStandardMaterial({ color: 0x1a5a1a, roughness: 0.8 }),
    canopySmoke: new THREE.MeshStandardMaterial({ color: 0x2a3a1a, roughness: 0.8 }),
    canopyBurned: new THREE.MeshStandardMaterial({ color: 0x222200, roughness: 0.9, transparent: true, opacity: 0.4 }),
    stone: new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.9 }),
    water: new THREE.MeshStandardMaterial({ color: 0x0044ff, transparent: true, opacity: 0.75, roughness: 0.1, metalness: 0.3 }),
};

function spawnTree(cx, cz, tall, burned) {
    const trunkH = tall ? 10 + Math.random() * 8 : 6 + Math.random() * 5;
    const trunkR = 0.25 + Math.random() * 0.25;
    const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(trunkR * 0.7, trunkR, trunkH, 6),
        burned ? treeMaterials.trunkBurned : treeMaterials.trunk
    );
    trunk.position.set(cx, trunkH / 2, cz);

    scene.add(trunk);
    registerObstacle(cx, cz, 1.2, trunkH + (burned ? 0 : 6)); // include canopy height buffer

    if (!burned) {
        const canopyR = 2 + Math.random() * 2.5;
        const mats = [treeMaterials.canopyDark, treeMaterials.canopyMed, treeMaterials.canopyLight];
        const canopy = new THREE.Mesh(
            new THREE.SphereGeometry(canopyR, 7, 7),
            mats[Math.floor(Math.random() * mats.length)]
        );
        canopy.position.set(cx + (Math.random() - 0.5) * 1.5, trunkH + canopyR * 0.4, cz + (Math.random() - 0.5) * 1.5);

        scene.add(canopy);
        // Second smaller canopy cluster for density
        if (Math.random() > 0.4) {
            const c2 = new THREE.Mesh(
                new THREE.SphereGeometry(canopyR * 0.65, 6, 6),
                mats[Math.floor(Math.random() * mats.length)]
            );
            c2.position.set(cx + (Math.random() - 0.5) * 3, trunkH - 1 + Math.random() * 2, cz + (Math.random() - 0.5) * 3);

            scene.add(c2);
        }
    } else {
        // Burned tree — sparse dead canopy
        if (Math.random() > 0.5) {
            const canopy = new THREE.Mesh(
                new THREE.SphereGeometry(1.5 + Math.random(), 5, 5),
                treeMaterials.canopyBurned
            );
            canopy.position.set(cx, trunkH + 0.5, cz);
            scene.add(canopy);
        }
    }
}

for (let r = 0; r < SECTORS; r++) for (let c = 0; c < SECTORS; c++) {
    const h = hazardOf(r, c);
    const cx0 = c * CELL, cz0 = r * CELL;
    let treeCount;
    if (h === 'smoke') treeCount = 1 + Math.floor(Math.random() * 2);
    else if (h === 'fire') treeCount = 1 + Math.floor(Math.random() * 1);
    else treeCount = 1 + Math.floor(Math.random() * 2);

    for (let t = 0; t < treeCount; t++) {
        const tx = cx0 + 2 + Math.random() * (CELL - 4);
        const tz = cz0 + 2 + Math.random() * (CELL - 4);
        const tall = (h === 'clear') ? true : false;
        const burned = (h === 'fire');
        spawnTree(tx, tz, tall, burned);
    }

    // Add stones and ponds in appropriate sectors
    if (h === 'clear' || h === 'smoke') {
        // Randomly spawn stones
        if (Math.random() > 0.7) {
            const sx = cx0 + 2 + Math.random() * (CELL - 4);
            const sz = cz0 + 2 + Math.random() * (CELL - 4);
            spawnStone(sx, sz);
        }
        // Randomly spawn ponds (less frequent, only in clear areas)
        if (h === 'clear' && Math.random() > 0.92) {
            const px = cx0 + CELL / 2 + (Math.random() - 0.5) * 4;
            const pz = cz0 + CELL / 2 + (Math.random() - 0.5) * 4;
            spawnPond(px, pz);
        }
    }
}

function spawnStone(cx, cz, scale = 1) {
    const size = (0.5 + Math.random() * 1.5) * scale;
    const geo = new THREE.IcosahedronGeometry(size, 0);
    const mesh = new THREE.Mesh(geo, treeMaterials.stone);
    mesh.position.set(cx, size * 0.6, cz);
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    mesh.scale.set(1, 0.4 + Math.random() * 0.6, 1);
    scene.add(mesh);
    if (size > 1.2) {
        registerObstacle(cx, cz, size * 0.8, size);
    }
}

function spawnPond(cx, cz) {
    const radius = 2 + Math.random() * 3;
    const geo = new THREE.CircleGeometry(radius, 16);
    const mesh = new THREE.Mesh(geo, treeMaterials.water);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(cx, 0.03, cz);
    scene.add(mesh);
}



function spawnHouse(cx, cz, isSurvivorShed = false) {
    const houseG = new THREE.Group();
    const houseBase = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 8), new THREE.MeshStandardMaterial({ color: isSurvivorShed ? 0x5c4033 : 0x7a5b4a, roughness: 0.9 }));
    houseG.add(houseBase);

    const roofGeometry = new THREE.CylinderGeometry(0, 5, 3, 4, 1);
    roofGeometry.rotateY(Math.PI / 4);
    const houseRoof = new THREE.Mesh(roofGeometry, new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.8 }));
    houseRoof.position.y = 3.5;
    houseG.add(houseRoof);

    const chimney = new THREE.Mesh(new THREE.BoxGeometry(1, 4, 1), new THREE.MeshStandardMaterial({ color: 0x442222 }));
    chimney.position.set(-1.5, 4, -2);
    houseG.add(chimney);

    houseG.position.set(cx, 2, cz);
    scene.add(houseG);
    registerObstacle(cx, cz, 4, 7);
}

// ─── CENTER CABIN (SURVIVOR SHELTER) ───
spawnHouse(GRID / 2, GRID / 2, true);

// ─── ADDITIONAL HOUSES ───
for (let i = 0; i < 10; i++) {
    let hx, hz, distToBase, distToVolcano;
    // Keep picking positions until safe distance from center base and volcano
    do {
        hx = 10 + Math.random() * (GRID - 20);
        hz = 10 + Math.random() * (GRID - 20);
        distToBase = Math.hypot(hx - GRID / 2, hz - GRID / 2);
        distToVolcano = Math.hypot(hx - 15, hz - 85);
    } while (distToBase < 15 || distToVolcano < 20);

    spawnHouse(hx, hz);
}

// ─── VOLCANO (MOUNTAIN LANDMARK) ───
const volcanoG = new THREE.Group();
const volBaseGeo = new THREE.CylinderGeometry(4, 15, 12, 12);
const volBaseMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 1, metalness: 0.1 });
const volBase = new THREE.Mesh(volBaseGeo, volBaseMat);
volBase.position.y = 6;
volcanoG.add(volBase);

const volCraterGeo = new THREE.TorusGeometry(3.8, 0.5, 8, 16);
const volCraterMat = new THREE.MeshStandardMaterial({ color: 0xff4400, emissive: 0xff0000, emissiveIntensity: 2 });
const volCrater = new THREE.Mesh(volCraterGeo, volCraterMat);
volCrater.rotation.x = Math.PI / 2;
volCrater.position.y = 12;
volcanoG.add(volCrater);

const volLavaGeo = new THREE.CircleGeometry(3.5, 12);
const volLavaMat = new THREE.MeshStandardMaterial({ color: 0xff6600, emissive: 0xff2200, emissiveIntensity: 5 });
const volLava = new THREE.Mesh(volLavaGeo, volLavaMat);
volLava.rotation.x = -Math.PI / 2;
volLava.position.y = 11.8;
volcanoG.add(volLava);

// Volcano Position (Southeast Corner)
const volX = 15, volZ = 85;
volcanoG.position.set(volX, 0, volZ);
scene.add(volcanoG);
registerObstacle(volX, volZ, 12, 15);

// Persistent Volcano Smoke
for (let layer = 0; layer < 4; layer++) {
    const p = new THREE.Mesh(
        new THREE.PlaneGeometry(8, 8),
        new THREE.MeshBasicMaterial({ color: 0x333333, transparent: true, opacity: 0.15, side: THREE.DoubleSide })
    );
    p.rotation.x = -Math.PI / 2;
    p.position.set(volX + (Math.random() - 0.5) * 2, 13 + layer * 4, volZ + (Math.random() - 0.5) * 2);
    scene.add(p);
    smokePlanes.push({ mesh: p, phase: Math.random() * 6.28 });
}

// ─── FIRE EFFECTS (enhanced) ───
function spawnFireAt(sid) {
    const sm = sectorMeshes[sid];
    if (!sm) return;
    const { r, c } = sm;
    const cx = c * CELL + CELL / 2, cz = r * CELL + CELL / 2;
    // Flame cones — varied sizes (reduced count for perf)
    for (let i = 0; i < 6; i++) {
        const h = 1.5 + Math.random() * 5;
        const rad = 0.2 + Math.random() * 1.0;
        const flame = new THREE.Mesh(
            new THREE.ConeGeometry(rad, h, 4),
            new THREE.MeshBasicMaterial({
                color: new THREE.Color().setHSL(0.02 + Math.random() * 0.08, 1, 0.4 + Math.random() * 0.2),
                transparent: true, opacity: 0.7 + Math.random() * 0.2
            })
        );
        flame.position.set(
            cx - CELL / 2 + Math.random() * CELL,
            0.5 + Math.random() * 2,
            cz - CELL / 2 + Math.random() * CELL
        );
        scene.add(flame);
        fireParticles.push({ mesh: flame, baseY: flame.position.y, speed: 1.5 + Math.random() * 4, phase: Math.random() * 6.28, type: 'flame' });
    }
    // Ember sparks (reduced for perf)
    for (let i = 0; i < 3; i++) {
        const ember = new THREE.Mesh(
            new THREE.SphereGeometry(0.1, 3, 3),
            new THREE.MeshBasicMaterial({
                color: new THREE.Color().setHSL(0.05 + Math.random() * 0.05, 1, 0.6),
                transparent: true, opacity: 0.9
            })
        );
        ember.position.set(
            cx - CELL / 3 + Math.random() * (CELL * 0.66),
            1 + Math.random() * 4,
            cz - CELL / 3 + Math.random() * (CELL * 0.66)
        );
        scene.add(ember);
        fireParticles.push({ mesh: ember, baseY: ember.position.y, speed: 2 + Math.random() * 5, phase: Math.random() * 6.28, type: 'ember' });
    }
}

function spawnSmokeAt(sid) {
    const sm = sectorMeshes[sid];
    if (!sm) return;
    const { r, c } = sm;
    const cx = c * CELL + CELL / 2, cz = r * CELL + CELL / 2;
    // Rising smoke puffs (reduced for perf)
    for (let i = 0; i < 2; i++) {
        const size = CELL * (0.3 + Math.random() * 0.4);
        const p = new THREE.Mesh(
            new THREE.SphereGeometry(size * 0.3, 6, 6),
            new THREE.MeshBasicMaterial({ color: 0x665544, transparent: true, opacity: 0.08, side: THREE.DoubleSide })
        );
        p.position.set(
            cx + (Math.random() - 0.5) * CELL * 0.6,
            2 + i * 4 + Math.random() * 2,
            cz + (Math.random() - 0.5) * CELL * 0.6
        );
        scene.add(p);
        smokePlanes.push({ mesh: p, phase: Math.random() * 6.28, baseX: p.position.x, baseZ: p.position.z, baseY: p.position.y });
    }
}

// Survivors

// ─── OBSTACLE AVOIDANCE (repulsive force field + stuck escape) ───
function computeAvoidanceSteer(pos, desiredDir, droneIdx = -1) {
    let steerX = 0, steerZ = 0;
    let nearestDist = Infinity;

    // Avoid obstacles
    for (const obs of obstacles) {
        // Height check: if drone is well ABOVE the obstacle, ignore it
        if (pos.y > obs.height + 1.5) continue;

        const dx = obs.x - pos.x, dz = obs.z - pos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const safeZone = obs.radius + 1.5;
        if (dist < AVOIDANCE_LOOKAHEAD + safeZone && dist > 0.01) {
            if (dist < nearestDist) nearestDist = dist;
            const urgency = Math.pow(Math.max(0, 1 - dist / (AVOIDANCE_LOOKAHEAD + safeZone)), 2);
            steerX -= (dx / dist) * urgency * 1.8;
            steerZ -= (dz / dist) * urgency * 1.8;
        }
    }

    // Avoid other drones (separation behavior)
    const DRONE_SEPARATION_DIST = 8.0;  // Minimum desired distance between drones
    const DRONE_AVOIDANCE_RANGE = 15.0; // Range to start avoiding other drones

    drones.forEach((otherDrone, otherIdx) => {
        if (otherIdx === droneIdx || otherDrone.dead) return;

        const otherPos = otherDrone.group.position;
        const dx = otherPos.x - pos.x;
        const dz = otherPos.z - pos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        // Only avoid if close enough
        if (dist < DRONE_AVOIDANCE_RANGE && dist > 0.01) {
            if (dist < nearestDist) nearestDist = dist;

            // Stronger repulsion when closer
            const urgency = Math.pow(Math.max(0, 1 - dist / DRONE_AVOIDANCE_RANGE), 2);

            // Repulsion vector (away from other drone)
            steerX -= (dx / dist) * urgency * 2.5;
            steerZ -= (dz / dist) * urgency * 2.5;

            // Additional repulsion if very close
            if (dist < DRONE_SEPARATION_DIST) {
                steerX -= (dx / dist) * 1.5;
                steerZ -= (dz / dist) * 1.5;
            }
        }
    });

    return { x: steerX, z: steerZ, blocked: nearestDist < 3.5 };
}

// ─── DRONES ───
const PATH_SAMPLE_INTERVAL = 5;
let frameCount = 0;

function createDrone(colorHex) {
    const g = new THREE.Group();
    const cHex = parseInt(colorHex.slice(1), 16);
    // Body — slightly more detailed
    const body = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 0.35, 1.2),
        new THREE.MeshStandardMaterial({ color: cHex, metalness: 0.7, roughness: 0.2, emissive: cHex, emissiveIntensity: 0.3 })
    );
    body.castShadow = false; g.add(body);
    // Arms connecting body to rotors
    const armMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.6, roughness: 0.3 });
    for (const [ax, az] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        // Arm strut
        const arm = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.06, 0.06), armMat);
        arm.position.set(ax * 0.5, 0.15, az * 0.5);
        arm.rotation.y = Math.atan2(az, ax);
        g.add(arm);
        // Rotor disc
        const rotor = new THREE.Mesh(
            new THREE.CylinderGeometry(0.45, 0.45, 0.03, 10),
            new THREE.MeshBasicMaterial({ color: 0x88ccff, transparent: true, opacity: 0.35 })
        );
        rotor.position.set(ax * 0.9, 0.25, az * 0.9);
        g.add(rotor);
    }
    // Navigation LED lights (front green, rear red)
    const ledFront = new THREE.Mesh(
        new THREE.SphereGeometry(0.06, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0x00ff00 })
    );
    ledFront.position.set(0, 0.05, -0.6);
    g.add(ledFront);
    const ledRear = new THREE.Mesh(
        new THREE.SphereGeometry(0.06, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0xff0000 })
    );
    ledRear.position.set(0, 0.05, 0.6);
    g.add(ledRear);

    // Observation Radius Visualizer (5 sectors = 100u diameter, 50u radius)
    const obsRadius = 1 * CELL;
    const obsRing = new THREE.Mesh(
        new THREE.TorusGeometry(obsRadius, 0.5, 3, 64),
        new THREE.MeshBasicMaterial({ color: 0xffeeaa, transparent: true, opacity: 0.15, wireframe: true })
    );
    obsRing.rotation.x = -Math.PI / 2;
    obsRing.position.y = -DRONE_FLY_HEIGHT + 1; // Project slightly above ground
    g.add(obsRing);
    g.userData.obsRing = obsRing;

    return g;
}

// Remove obstacles near base so drones never get stuck at spawn
for (let oi = obstacles.length - 1; oi >= 0; oi--) {
    if (Math.hypot(obstacles[oi].x - BASE.x, obstacles[oi].z - BASE.z) < 15) {
        obstacles.splice(oi, 1);
    }
}

// Sector queue
const globalQueue = [];
for (let r = 0; r < SECTORS; r++) for (let c = 0; c < SECTORS; c++) {
    const k = `S${r}_${c}`;
    if (!NO_FLY.has(k)) globalQueue.push({ r, c, k, hazard: hazardOf(r, c), assigned: false });
}

function getNextSector(d, idx) {
    // Simple FIFO over globalQueue of sectors that are not no-fly and not yet scanned/assigned
    for (let i = 0; i < globalQueue.length; i++) {
        const item = globalQueue[i];
        const sid = item.k;
        const sm = sectorMeshes[sid];
        if (!item.assigned && sm && !sm.scanned) {
            item.assigned = true;
            sm.assigned_to = idx;
            return item;
        }
    }
    return null;
}

// Assign initial targets (called by start button)
let missionStarted = false;
let missionStartTime = 0;
let missionComplete = false;

function formatTime(sec) {
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return `${m}m ${s.toString().padStart(2, '0')}s`;
}
// NOTE: startMission is defined at the bottom of the file (after syncWithServer)
// to ensure all dependencies (mcpClient, syncWithServer, etc.) are available.

function askLLMForSector(d, i) {
    return;
}

// Camera
const cameraViews = [
    { idx: -1, label: 'Overview', shortcut: '[0]' },
    { idx: -2, label: 'World', shortcut: '[6]' },
    { idx: -3, label: 'Swarm', shortcut: '[7]' }
];
let currentViewIndex = 0;

window.cycleCameraView = function () {
    currentViewIndex = (currentViewIndex + 1) % cameraViews.length;
    const view = cameraViews[currentViewIndex];
    switchCam(view.idx);

    // Update button label and shortcut
    document.getElementById('cam-view-label').textContent = view.label;
    document.querySelector('.cam-shortcut').textContent = view.shortcut;
};

window.switchCam = function (idx) {
    activeDrone = idx;
    state.activeDrone = idx;
    // Reset follow tracking so camera re-centers on new drone
    drones.forEach(d => d._lastCamPos = null);
    controls.enabled = true; // always allow orbit
    const thinkBox = document.querySelector('#thinking-box h4');
    const isHidden = document.getElementById('thoughts-content').style.display === 'none';
    const toggleHtml = `<span class="panel-toggle" id="toggle-thoughts" onclick="togglePanel('thoughts-content', 'toggle-thoughts')">${isHidden ? '[+]' : '[-]'}</span> `;
    const filterHtml = ['all', 'llm', 'mcp']
        .map(mode => `<span class="log-filter-btn ${state.logFilter === mode ? 'active' : ''}" id="filter-${mode}" onclick="setLogFilter('${mode}')">${mode.toUpperCase()}</span>`)
        .join(' ');
    thinkBox.innerHTML = toggleHtml + (idx >= 0 ? `🧠 ${DRONE_NAMES[idx]}'s THOUGHTS` : '🧠 DRONE THOUGHTS') + ' ' + filterHtml;
    updateFilterButtons();
    // Set world view camera
    if (idx === -2) {
        cam.position.set(GRID / 2, 320, GRID / 2 + 20);
        controls.target.set(GRID / 2, 0, GRID / 2);
    }
};
document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    const k = e.key.toLowerCase();
    if (k === '0') {
        currentViewIndex = 0;
        switchCam(-1);
        document.getElementById('cam-view-label').textContent = 'Overview';
        document.querySelector('.cam-shortcut').textContent = '[0]';
    }
    else if (k >= '1' && k <= '5') switchCam(parseInt(k) - 1);
    else if (k === '6') {
        currentViewIndex = 1;
        switchCam(-2);
        document.getElementById('cam-view-label').textContent = 'World';
        document.querySelector('.cam-shortcut').textContent = '[6]';
    }
    else if (k === '7') {
        currentViewIndex = 2;
        switchCam(-3);
        document.getElementById('cam-view-label').textContent = 'Swarm';
        document.querySelector('.cam-shortcut').textContent = '[7]';
    }
    else if (k === 'h') toggleScannedSectors();
    else if (k === 'p') togglePause();
    else if (k === 'n') toggleDayNight();
    else if (k === 'r') location.reload();
});

// Manual Drone Kill Function
window.killDrone = function (idx) {
    const d = drones[idx];
    if (d && !d.dead) {
        // Immediately mark as dead and stop all movement
        d.battery = 0;
        d.dead = true;
        d.state = 'idle';
        d.recharging = false;

        // Release any sector assignment
        if (d.target && d.target.sector) {
            const qs = globalQueue.find(q => q.k === d.target.sector);
            if (qs) qs.assigned = false;
            if (useLLM && mcpClient && mcpClient.connected) {
                mcpClient.callTool('assign_target', { drone_id: `drone_${idx + 1}`, sector_id: '__RECALL__' }).catch(e => console.warn(e));
            }
        }

        // Clear target
        d.target = null;

        // Visual crash effect
        d.group.position.y = 0.5;
        d.group.children[0].material.color.setHex(0x330000);
        d.group.children[0].material.emissive.setHex(0x110000);

        // Notifications
        showAlertDialog(`⚠️ DRONE ${idx + 1} EMERGENCY SHUTDOWN`);
        addThought(idx, 'danger', `💀 Emergency shutdown initiated — all systems offline.`);
        addMCP(idx, 'call', 'report_drone_loss', {
            drone_id: `drone_${idx + 1}`,
            location: [Math.round(d.group.position.x), Math.round(d.group.position.z)]
        }, { status: 'manual_kill', battery: 0 });
    }
};

// Manual RTB — force a drone back to the charging station immediately
window.recallDrone = function (idx) {
    const d = drones[idx];
    if (!d || d.dead || d.recharging) return;
    // Release any held sector assignment
    if (d.target && d.target.sector) {
        const qs = globalQueue.find(q => q.k === d.target.sector);
        if (qs) qs.assigned = false;
        if (useLLM && mcpClient && mcpClient.connected) {
            mcpClient.callTool('assign_target', { drone_id: `drone_${idx + 1}`, sector_id: '__RECALL__' }).catch(e => console.warn(e));
        }
    }
    // Clear any diversion state
    d._originalTarget = null;
    d._fireScanQueue = null;
    d.target = { x: BASE.x, z: BASE.z, sector: null, hazard: 'clear' };
    d.state = 'moving';
    addMCP(idx, 'call', 'recall_for_charging', { drone_id: `drone_${idx + 1}` }, { status: 'manual_rtb', base: [BASE.x, BASE.z] });
    addThought(idx, 'action', `🔋 Got a manual recall — heading back to the charging station now.`);
    showAlertDialog(`🔋 DRONE ${idx + 1} RETURNING TO CHARGING`);
};

// Add a new drone to the fleet
window.addNewDrone = async function () {
    if (!missionStarted) {
        alert('Please start the mission first before adding drones.');
        addThought(-1, 'system', 'Can\'t add a drone right now — the mission hasn\'t started yet');
        return;
    }

    const newIdx = drones.length;
    const droneId = `drone_${newIdx + 1}`;

    console.log(`[Add Drone] Adding drone ${droneId} at index ${newIdx}`);

    // Call MCP server to add drone
    if (useLLM && mcpClient && mcpClient.connected) {
        try {
            const result = await mcpClient.callTool('add_drone', { drone_id: droneId });
            console.log('[Add Drone] MCP result:', result);
        } catch (e) {
            console.warn('[Add Drone] Failed to add drone via MCP:', e);
        }
    } else {
        console.log('[Add Drone] MCP not connected, adding locally only');
    }

    // Create visual drone representation matching the startMission style
    const color = getRandomDroneColor();
    DRONE_COLORS.push(color);

    // Create drone group with the same structure as startMission
    const g = new THREE.Group();

    // Drone body (chassis)
    const bodyGeo = new THREE.BoxGeometry(0.6, 0.2, 0.6);
    const bodyMat = new THREE.MeshStandardMaterial({
        color: color,
        emissive: color,
        emissiveIntensity: 0.2
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.1;
    body.castShadow = true;
    g.add(body);

    // Central hub
    const hubGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.25, 16);
    const hubMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
    const hub = new THREE.Mesh(hubGeo, hubMat);
    hub.position.y = 0.2;
    g.add(hub);

    // Arms and rotors
    const armLength = 0.5;
    const armGeo = new THREE.BoxGeometry(armLength, 0.08, 0.1);
    const armMat = new THREE.MeshStandardMaterial({ color: 0x444444 });
    const rotorGeo = new THREE.CylinderGeometry(0.25, 0.25, 0.03, 16);
    const rotorMat = new THREE.MeshStandardMaterial({ color: 0x222222 });

    const rotors = [];
    for (let j = 0; j < 4; j++) {
        const angle = (j * Math.PI) / 2;
        const arm = new THREE.Mesh(armGeo, armMat);
        arm.position.set(
            Math.cos(angle) * armLength * 0.5,
            0.15,
            Math.sin(angle) * armLength * 0.5
        );
        arm.rotation.y = angle;
        g.add(arm);

        const rotor = new THREE.Mesh(rotorGeo, rotorMat);
        rotor.position.set(
            Math.cos(angle) * armLength,
            0.25,
            Math.sin(angle) * armLength
        );
        g.add(rotor);
        rotors.push(rotor);
    }

    // Position at base with offset
    const offsetX = newIdx * 2;
    const spawnX = BASE.x + offsetX;
    const spawnZ = BASE.z;
    g.position.set(spawnX, DRONE_FLY_HEIGHT, spawnZ);
    scene.add(g);

    console.log(`[Add Drone] Drone positioned at (${spawnX}, ${DRONE_FLY_HEIGHT}, ${spawnZ})`);

    // Create scan mesh (wireframe sphere)
    const scanMesh = new THREE.Mesh(
        new THREE.SphereGeometry(SCAN_RADIUS, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0x0066ff, transparent: true, opacity: 0.04, wireframe: true })
    );
    scanMesh.position.copy(g.position);
    scene.add(scanMesh);
    scanSpheres.push(scanMesh);

    // Add to drones array with same structure as startMission
    const newDrone = {
        group: g,
        rotors: rotors,
        battery: 100,
        target: null,
        state: "idle",
        scanTimer: 0,
        scanCooldown: 0,
        recharging: false,
        path: [{ x: g.position.x, z: g.position.z }],
        sectorsScanned: 0,
        avoidCount: 0,
        stuckCheck: { x: g.position.x, z: g.position.z, frame: 0 },
        escapeMode: "none",
        escapeTimer: 0,
        defaultHeight: DRONE_FLY_HEIGHT,
        targetHeight: DRONE_FLY_HEIGHT,
        dead: false,
        _lastSector: null,
        _fireScanQueue: null,
        _lastAlert: null
    };
    drones.push(newDrone);

    // Add thought log for new drone - ensure thoughtLogs can grow
    if (thoughtLogs.length <= newIdx) {
        thoughtLogs.push([]);
    }

    // Update DRONE_NAMES array to include new drone
    DRONE_NAMES.push(droneId);

    // Create label for new drone if it doesn't exist
    let label = document.getElementById(`drone-label-${newIdx}`);
    if (!label) {
        label = document.createElement('div');
        label.id = `drone-label-${newIdx}`;
        label.className = 'drone-label';
        label.style.cssText = 'position:absolute;transform:translate(-50%,-100%);pointer-events:none;font-family:Arial,sans-serif;font-size:11px;font-weight:bold;text-shadow:0 0 4px #000;white-space:nowrap;z-index:1000;color:' + color + ';';
        document.body.appendChild(label);
    }

    console.log(`[Add Drone] Fleet size now: ${drones.length}`);

    // Log the addition
    addThought(-1, 'action', `🚁 New drone deployed! ${droneId} is at base with a full battery.`);
    addMCP(newIdx, 'call', 'add_drone', { drone_id: droneId }, { status: 'deployed', battery: 100, fleet_size: drones.length });

    showAlertDialog(`🚁 NEW DRONE DEPLOYED! Fleet size: ${drones.length}`);
};

// Status
let missionGoal = "scanAll";
let totalSurvivorsInitially = 0;
let totalFound = 0;
let serverMetrics = { elapsed: 0, found: 0, total: 0, scanned: 0, discovered: 0, scannable: 0 };
let prevFoundCount = 0;
let alertTimeout = null;

function updateStatus() {
    // Mission info
    let h = '';
    h += `<div class="sr"><span class="sl">Coverage</span><span class="sv">${serverMetrics.scanned}/${serverMetrics.scannable}</span></div>`;
    h += `<div class="sr"><span class="sl">Discovered</span><span class="sv">${serverMetrics.discovered}/${serverMetrics.scannable}</span></div>`;
    h += `<div class="sr"><span class="sl">Survivors</span><span class="sv det">${serverMetrics.found}/${serverMetrics.total}</span></div>`;
    if (missionStarted) {
        h += `<div class="sr"><span class="sl">Time</span><span class="sv">${formatTime(serverMetrics.elapsed)}</span></div>`;
    }
    h += `<div class="sr"><span class="sl">Obstacles</span><span class="sv">${obstacles.length} tracked</span></div>`;
    document.getElementById('sc').innerHTML = h;

    // Drone fleet cards
    let fleetHtml = '';
    drones.forEach((d, i) => {
        const color = DRONE_COLORS[i] || '#7aa8cc';
        const statusClass = d.dead ? 'dead' : d.recharging ? 'recharging' : d.state === 'scanning' ? 'scanning' : d.state === 'moving' ? 'moving' : 'idle';
        const statusText = d.dead ? 'OFFLINE' : d.recharging ? 'CHARGING' : d.state === 'scanning' ? 'SCANNING' : d.state === 'moving' ? 'EN ROUTE' : 'IDLE';
        const batClass = d.battery < 25 ? 'low' : d.dead ? 'dead' : '';
        const isActive = activeDrone === i;

        fleetHtml += `<div class="drone-card${isActive ? ' active' : ''}" data-drone-idx="${i}" data-card="true">`;
        fleetHtml += `<div class="drone-card-header">`;
        fleetHtml += `<span class="drone-card-name" style="color:${color}">D${i + 1}</span>`;
        fleetHtml += `<span class="drone-card-status ${statusClass}">${statusText}</span>`;
        fleetHtml += `</div>`;
        fleetHtml += `<div class="drone-card-stats">`;
        fleetHtml += `<div class="drone-card-stat"><span class="drone-card-stat-label">BAT</span><span class="drone-card-stat-value" style="color:${d.dead ? '#b08080' : d.battery < 25 ? '#c0a870' : '#7aa8cc'}">${d.battery.toFixed(0)}%</span></div>`;
        if (d.target && d.target.sector) {
            fleetHtml += `<div class="drone-card-stat"><span class="drone-card-stat-label">TGT</span><span class="drone-card-stat-value">${d.target.sector}</span></div>`;
        }
        fleetHtml += `</div>`;
        if (!d.dead) {
            fleetHtml += `<div class="drone-card-actions">`;
            fleetHtml += `<button type="button" class="drone-card-btn kill" data-drone-idx="${i}" data-action="kill" title="Emergency Shutdown">KILL</button>`;
            if (!d.recharging) {
                fleetHtml += `<button type="button" class="drone-card-btn charge" data-drone-idx="${i}" data-action="charge" title="Send to Charging Station">CHARGE</button>`;
            }
            fleetHtml += `</div>`;
        }
        fleetHtml += `</div>`;
    });
    document.getElementById('fleet-list').innerHTML = fleetHtml;

    if (serverMetrics.found > prevFoundCount) {
        prevFoundCount = serverMetrics.found;
        showAlertDialog('🟢 SURVIVOR FOUND!');
    }

    // Drone death or charging return popup
    drones.forEach((d, i) => {
        if (d._lastAlert !== 'dead' && d.dead) {
            d._lastAlert = 'dead';
            showAlertDialog(`💀 DRONE ${i + 1} DOWN!`);
        } else if (d._lastAlert !== 'charging' && d.recharging) {
            d._lastAlert = 'charging';
            showAlertDialog(`🔋 DRONE ${i + 1} RETURNED TO CHARGING`);
        } else if (!d.dead && !d.recharging) {
            d._lastAlert = null;
        }
    });
}

// Alert dialog helper - global function
window.showAlertDialog = function (msg) {
    const ab = document.getElementById('alert-box');
    ab.textContent = msg;
    ab.classList.remove('show');
    // Set colors based on message type
    if (msg.includes('DRONE') && msg.includes('DOWN')) {
        ab.style.borderColor = '#8a6060';
        ab.style.color = '#b08080';
    } else if (msg.includes('DRONE') && msg.includes('DEPLOYED')) {
        ab.style.borderColor = '#4a9eff';
        ab.style.color = '#7aa8cc';
    } else {
        ab.style.borderColor = '#5a8ab8';
        ab.style.color = '#7aa8cc';
    }
    void ab.offsetWidth;
    ab.classList.add('show');
    clearTimeout(alertTimeout);
    alertTimeout = setTimeout(() => ab.classList.remove('show'), 3000);
};

// Survivor detection removed. Handled by backend thermal_scan.

// ─── BATCH SWARM COORDINATION (REMOVED: Use Commander Agent) ───
const assignmentQueue = [];
let lastBatchTime = 0;
setInterval(processBatchQueue, 1000);

function processBatchQueue() {
    if (!useLLM || !mcpClient || !mcpClient.connected) return;
    if (assignmentQueue.length === 0) return;
    const now = performance.now();
    if (now - lastBatchTime < 1500) return;
    lastBatchTime = now;

    const waitingIds = assignmentQueue.map(idx => `drone_${idx + 1}`);
    mcpClient.callTool('assign_targets', { waiting: waitingIds })
        .then(resp => {
            if (resp && resp.content && resp.content.length > 0) {
                try {
                    const data = JSON.parse(resp.content[0].text);
                    if (data.assignments) {
                        data.assignments.forEach(a => {
                            const idx = parseInt((a.drone_id || '').split('_')[1]) - 1;
                            const d = drones[idx];
                            const sm = sectorMeshes[a.sector_id];
                            if (!d || !sm) return;
                            d.target = { x: sm.c * CELL + CELL / 2, z: sm.r * CELL + CELL / 2, sector: a.sector_id, hazard: sm.hazard };
                            d.state = "moving";
                            const qIdx = assignmentQueue.indexOf(idx);
                            if (qIdx > -1) assignmentQueue.splice(qIdx, 1);
                            addThought(idx, 'action', `Coordinator assigned ${a.sector_id} — ${a.reason || 'covering new sector'}`);
                        });
                    }
                } catch (e) {
                    console.warn('assign_targets parse error', e);
                }
            }
        })
        .catch(e => console.warn('assign_targets failed', e));
}

// ─── ANIMATION LOOP ───
const clock = new THREE.Clock();
let elapsed = 0;

function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();

    if (!isPaused) {
        elapsed += dt;
        frameCount++;

        // processBatchQueue(); // Logic moved to Agent

        // Fire animation (enhanced)
        fireParticles.forEach(f => {
            if (f.type === 'ember') {
                // Embers float upward and drift sideways
                f.mesh.position.y = f.baseY + ((elapsed * f.speed + f.phase) % 8);
                f.mesh.position.x += Math.sin(elapsed * 2 + f.phase) * 0.01;
                f.mesh.material.opacity = Math.max(0, 0.9 - ((elapsed * f.speed + f.phase) % 8) * 0.12);
                // Reset when too high
                if (f.mesh.position.y > f.baseY + 8) {
                    f.mesh.position.y = f.baseY;
                }
            } else if (f.type === 'light') {
                // Flickering fire light
                f.mesh.intensity = 1.0 + Math.sin(elapsed * f.speed + f.phase) * 0.8 + Math.sin(elapsed * 7 + f.phase) * 0.3;
            } else {
                // Flame cones — dance and flicker
                f.mesh.position.y = f.baseY + Math.sin(elapsed * f.speed + f.phase) * 1.5;
                f.mesh.scale.x = 0.7 + Math.sin(elapsed * f.speed * 2 + f.phase) * 0.3;
                f.mesh.scale.z = 0.7 + Math.cos(elapsed * f.speed * 1.5 + f.phase) * 0.3;
                f.mesh.scale.y = 0.5 + Math.sin(elapsed * f.speed * 2.5 + f.phase) * 0.5;
                f.mesh.material.opacity = 0.3 + Math.sin(elapsed * 3 + f.phase) * 0.35;
                f.mesh.rotation.y += Math.sin(elapsed * 0.5 + f.phase) * 0.02;
            }
        });
        // Smoke animation (enhanced — rising, drifting)
        smokePlanes.forEach(s => {
            const t = elapsed * 0.3 + s.phase;
            s.mesh.material.opacity = 0.04 + Math.sin(t) * 0.03;
            // Gentle rise
            s.mesh.position.y = (s.baseY || s.mesh.position.y) + Math.sin(t * 0.5) * 1.5;
            // Drift sideways
            if (s.baseX !== undefined) {
                s.mesh.position.x = s.baseX + Math.sin(t * 0.7) * 2;
                s.mesh.position.z = s.baseZ + Math.cos(t * 0.5) * 1.5;
            }
            // Slowly grow
            const scale = 1 + Math.sin(t * 0.3) * 0.15;
            s.mesh.scale.set(scale, scale, scale);
        });

        // Survivor animation (enhanced — bobbing with SOS pulse)
        survivorMeshes.forEach((s, i) => {
            if (!s.found) {
                // Unfound survivors: gentle bobbing + occasional "wave" scale pulse
                s.body.position.y = 0.4 + Math.sin(elapsed * 1.5 + i) * 0.15;
                const wavePulse = 1 + Math.sin(elapsed * 3 + i * 2) * 0.15;
                s.body.scale.set(wavePulse, 1, wavePulse);
            } else if (s.ring) {
                // Found survivors: celebrating bounce + ring pulse
                s.body.position.y = 0.8 + Math.abs(Math.sin(elapsed * 2 + i)) * 0.5;
                s.ring.scale.setScalar(1 + Math.sin(elapsed * 2 + i) * 0.3);
                s.ring.material.opacity = 0.2 + Math.sin(elapsed * 3 + i) * 0.15;
            }
        });

        // Sector Visualization 
        Object.values(sectorMeshes).forEach(s => {
            const isFire = s.hazard === "fire";
            if (s.scanned) {
                if (showScannedSectors) {
                    // Toggle-on: bright pulsing colours
                    s.mesh.material.color.setHex(isFire ? 0xdd6600 : 0x00dd55);
                    s.mesh.material.opacity = 0.45 + Math.sin(elapsed * 2 + s.mesh.position.x) * 0.1;
                    s.mesh.material.emissive.setHex(isFire ? 0x441100 : 0x004422);
                } else {
                    // Default scanned colour
                    s.mesh.material.color.setHex(isFire ? 0x883300 : 0x00aa44);
                    s.mesh.material.opacity = 0.55;
                    s.mesh.material.emissive.setHex(isFire ? 0x221100 : 0x003311);
                }
            } else if (s.discovered) {
                // Discovered but not yet scanned: cyan/amber accent
                s.mesh.material.color.setHex(isFire ? 0xffaa33 : 0x33bbff);
                s.mesh.material.opacity = 0.35;
                s.mesh.material.emissive.setHex(isFire ? 0x553300 : 0x003355);
            }
        });

        // Update drones
        drones.forEach((d, i) => {
            d.rotors.forEach(r => r.rotation.y += dt * 30);

            // After mission complete, stop all processing once drone is idle/at base
            if (missionComplete && (d.state === 'idle' || d.dead)) {
                scanSpheres[i].position.copy(d.group.position);
                return;
            }

            // Record path
            if (frameCount % PATH_SAMPLE_INTERVAL === 0 && (d.state === 'moving' || d.state === 'scanning')) {
                const p = d.group.position;
                const last = d.path[d.path.length - 1];
                if (!last || Math.hypot(p.x - last.x, p.z - last.z) > 0.8) {
                    d.path.push({ x: p.x, z: p.z });
                }
            }

            // Wake up idle drones at base if there are unassigned sectors
            if (d.state === "idle" && !d.recharging && !d.dead && missionStarted && !missionComplete) {
                if (useLLM) {
                    // Add staggered wake-up delay based on drone index to prevent clustering
                    const wakeUpDelay = i * 500; // 500ms delay per drone index
                    setTimeout(() => {
                        if (d.state === "idle" && !d.dead && missionStarted) {
                            d.state = "waiting_orders";
                            if (!assignmentQueue.includes(i)) {
                                assignmentQueue.push(i);
                                addThought(i, 'info', `Waiting on the swarm coordinator for my next orders...`);
                            }
                        }
                    }, wakeUpDelay);
                } else {
                    const s = getNextSector(d, i);
                    if (s) {
                        d.target = { x: s.c * CELL + CELL / 2, z: s.r * CELL + CELL / 2, sector: s.k, hazard: s.hazard };
                        d.state = "moving";
                        addThought(i, 'action', `Woke up from standby — heading to ${s.k} now.`);
                    }
                }
            }

            // Skip dead drones
            if (d.dead) {
                scanSpheres[i].visible = false;
                return;
            }

            // Global check for death (battery depleted or manually killed)
            if (d.battery <= 0) {
                if (d.target && d.target.sector) {
                    const qs = globalQueue.find(q => q.k === d.target.sector);
                    if (qs) qs.assigned = false; // release sector for other drones
                    if (useLLM && mcpClient && mcpClient.connected) {
                        mcpClient.callTool('assign_target', { drone_id: `drone_${i + 1}`, sector_id: '__RECALL__' }).catch(e => console.warn(e));
                    }
                }
                d.battery = 0; d.dead = true; d.state = 'idle'; d.recharging = false;
                d.group.position.y = 0.5; // crash to ground
                d.group.children[0].material.color.setHex(0x330000);
                d.group.children[0].material.emissive.setHex(0x110000);
                addThought(i, 'danger', `⚠️ Battery's completely dead — going down at (${d.group.position.x.toFixed(0)}, ${d.group.position.z.toFixed(0)})!`);
                addMCP(i, 'call', 'report_drone_loss', { drone_id: `drone_${i + 1}`, location: [Math.round(d.group.position.x), Math.round(d.group.position.z)] }, { status: 'crashed', battery: 0 });
                return;
            }

            if (d.recharging) {
                d.battery = Math.min(100, d.battery + dt * 25);
                if (d.battery >= 100) {
                    d.recharging = false;
                    if (missionComplete) {
                        d.state = "idle"; // Mission done — stay at base
                        scanSpheres[i].position.copy(d.group.position);
                        return;
                    }
                    addThought(i, 'action', `Fully recharged! Ready to get back out there.`);
                    // Waiting for external command via syncWithServer
                    d.state = "idle";
                }
                d.group.position.y = 3 + Math.sin(elapsed * 2 + i) * 0.15;
                scanSpheres[i].position.copy(d.group.position);
                return;
            }

            if (d.state === "moving" && d.target) {
                const p = d.group.position;
                const dx = d.target.x - p.x, dz = d.target.z - p.z;
                const dist = Math.sqrt(dx * dx + dz * dz);

                if (dist > 0.5) {
                    const currentHazardMove = hazardOf(Math.floor(p.z / CELL), Math.floor(p.x / CELL));
                    const baseSpd = MOVE_SPEED * (currentHazardMove === "fire" ? 0.6 : 1);
                    let dirX = dx / dist, dirZ = dz / dist;
                    if (d.escapeMode === "backtrack") {
                        // Strong force away from target
                        dirX = -dx / dist * 2.5; dirZ = -dz / dist * 2.5;
                    } else if (d.escapeMode === "rising" && p.y < 18) {
                        // If rising but not high enough yet, don't move forward aggressively
                        dirX *= 0.1; dirZ *= 0.1;
                    }

                    // Apply obstacle avoidance
                    const steer = computeAvoidanceSteer(p, { x: dirX, z: dirZ }, i);
                    dirX += steer.x;
                    dirZ += steer.z;

                    if (steer.blocked && d.avoidCount % 120 === 0) {
                        addThought(i, 'warning', `Obstacle nearby — adjusting course to get around it...`);
                    }
                    if (steer.x !== 0 || steer.z !== 0) d.avoidCount++;
                    else d.avoidCount = 0;

                    // STUCK DETECTION: every 40 frames (more sensitive)
                    if (frameCount - d.stuckCheck.frame > 40) {
                        const moved = Math.hypot(p.x - d.stuckCheck.x, p.z - d.stuckCheck.z);
                        if (moved < 1.0 && d.state === 'moving' && d.escapeMode === "none") {
                            // STUCK! Only fly up to clear obstacles, costing extra battery.
                            d.escapeMode = "rising";
                            d.escapeTimer = 240;
                            d.targetHeight = 25; // Rise higher than any tree
                            d.battery -= 5.0; // Battery penalty for climbing
                            addThought(i, 'danger', `Stuck! Climbing to 25u to clear the canopy — gonna cost me 5% battery.`);
                        }
                        d.stuckCheck = { x: p.x, z: p.z, frame: frameCount };
                    }

                    // Escape timer logic
                    if (d.escapeTimer > 0) {
                        d.escapeTimer--;
                        if (d.escapeTimer === 0) {
                            d.escapeMode = "none";
                            d.targetHeight = d.defaultHeight;
                            addThought(i, 'action', `Cleared the obstacle — back to standard flight.`);
                        }
                    }

                    // Move
                    const finalLen = Math.sqrt(dirX * dirX + dirZ * dirZ) || 1;
                    p.x += (dirX / finalLen) * baseSpd;
                    p.z += (dirZ / finalLen) * baseSpd;

                    // Smooth altitude change with reduced bobbing
                    p.y += (d.targetHeight - p.y) * 0.04 + Math.sin(elapsed * 1.5 + i) * 0.15;

                    const lookTarget = new THREE.Vector3(p.x + dirX * 3, p.y, p.z + dirZ * 3);
                    d.group.lookAt(lookTarget);

                    // Battery drain — proportional to distance moved (frame-rate independent)
                    const curR = Math.floor(p.z / CELL), curC = Math.floor(p.x / CELL);
                    const currentSector = `S${curR}_${curC}`;
                    const currentHazard = hazardOf(curR, curC);
                    const mult = currentHazard === "fire" ? 3 : currentHazard === "smoke" ? 1.5 : 1;
                    d.battery -= baseSpd * DRAIN_PER_UNIT * mult;

                    // ─── EN-ROUTE SECTOR LOGIC ────────────────────────────────────────────────────

                    // 1. FLY-OVER SCAN
                    //    Track sector transitions. When the drone enters a new sector AND is within
                    //    SCAN_RADIUS of that sector's centre, fire a thermal scan.
                    //    This prevents ghost-scans from the sector boundary edge.
                    if (currentSector !== d._lastSector) {
                        d._lastSector = currentSector;
                    }
                    // Compute distance to current sector centre
                    const _smFlyOver = sectorMeshes[currentSector];
                    const _sectorCX = curC * CELL + CELL / 2;
                    const _sectorCZ = curR * CELL + CELL / 2;
                    const _distToSectorCenter = Math.hypot(p.x - _sectorCX, p.z - _sectorCZ);
                    const _nearSectorCenter = _distToSectorCenter <= SCAN_RADIUS;

                    if (_nearSectorCenter && _smFlyOver && !_smFlyOver.scanned && d.target.sector !== currentSector) {
                        _smFlyOver.scanned = true;
                        _smFlyOver.mesh.material.color.setHex(currentHazard === "fire" ? 0x2a0a00 : 0x152215);
                        _smFlyOver.mesh.material.opacity = 0.4;
                        d.sectorsScanned++;
                        addMCP(i, 'call', 'thermal_scan', { drone_id: `drone_${i + 1}`, sector: currentSector }, { status: 'fly_over_scan', hazard: currentHazard });
                        addMCP(i, 'call', 'scan_sector', { id: `drone_${i + 1}`, sector_id: currentSector }, { scanned: true, method: 'fly_over' });
                        addThought(i, 'info', currentHazard === "fire"
                            ? `🔥📡 Flying over a fire zone in ${currentSector} — scanning for trapped survivors.`
                            : `📡 Quick fly-over scan of ${currentSector} while passing through to ${d.target.sector}.`);
                        if (useLLM && mcpClient && mcpClient.connected) {
                            mcpClient.callTool('thermal_scan', { drone_id: `drone_${i + 1}`, sector: currentSector }).catch(e => console.warn(e));
                            mcpClient.callTool('scan_sector', { id: `drone_${i + 1}`, sector_id: currentSector }).catch(e => console.warn(e));
                        }
                    }

                    // 2. FIRE-HAZARD HALT
                    //    If the drone enters a fire sector that is NOT its assigned target, halt the
                    //    original route and queue all non-fire adjacent sectors for a full thermal scan.
                    //    Resumes to the original target once the queue is drained.
                    //    NOTE: thermal_scan MCP is only called once the drone is near the sector centre.
                    if (currentHazard === "fire" && d.target.sector !== currentSector && !d._originalTarget && !d._fireScanQueue) {
                        // Only trigger fire-halt logic when drone is near the fire sector centre
                        if (_nearSectorCenter) {
                            // Immediately scan the fire sector itself for trapped survivors
                            addMCP(i, 'call', 'thermal_scan', { drone_id: `drone_${i + 1}`, sector: currentSector }, { status: 'fire_zone_survivor_check' });
                            if (useLLM && mcpClient && mcpClient.connected) {
                                mcpClient.callTool('thermal_scan', { drone_id: `drone_${i + 1}`, sector: currentSector }).catch(e => console.warn(e));
                            }
                            const fireScanList = [];
                            for (let dr = -1; dr <= 1; dr++) {
                                for (let dc = -1; dc <= 1; dc++) {
                                    if (dr === 0 && dc === 0) continue;
                                    const nr = curR + dr, nc = curC + dc;
                                    if (nr < 0 || nr >= SECTORS || nc < 0 || nc >= SECTORS) continue;
                                    const sid = `S${nr}_${nc}`;
                                    const adjHazard = hazardOf(nr, nc);
                                    if (sectorMeshes[sid] && !sectorMeshes[sid].scanned
                                        && adjHazard !== "fire") {
                                        fireScanList.push({ r: nr, c: nc, k: sid, x: nc * CELL + CELL / 2, z: nr * CELL + CELL / 2 });
                                    }
                                }
                            }
                            if (fireScanList.length > 0) {
                                addThought(i, 'alert', `🔥 Hit fire in ${currentSector}! Halting my route to ${d.target.sector} — need to scan ${fireScanList.length} adjacent sectors first.`);
                                console.info(`fire-diversion start drone ${i + 1} queue=${fireScanList.map(f=>f.k).join(',')}`);
                                d._originalTarget = d.target;
                                d._fireScanQueue = fireScanList;
                                const next = d._fireScanQueue.shift();
                                d.target = { x: next.x, z: next.z, sector: next.k, hazard: hazardOf(next.r, next.c) };
                                // Remain in 'moving' state — drone heads to first adjacent sector
                            } else {
                                addThought(i, 'info', `🔥 Entered ${currentSector} but no safe adjacent sectors to scan. Continuing to ${d.target.sector}.`);
                            }
                        }
                        else {
                            addThought(i, 'info', `🔥 At fire edge ${currentSector}, waiting until near centre to trigger fire-scan diversion.`);
                            console.info(`fire-edge hold drone ${i + 1} in ${currentSector}`);
                        }
                    }

                    // 3. OPPORTUNISTIC RESCUE (RESTRICTED)
                    //    Only stop for survivors that are reasonably close to the direct path to target
                    //    This prevents the swarm from stopping tile-by-tile across the map
                    if (!d._originalTarget && d.target.sector !== currentSector
                        && sectorMeshes[currentSector] && !sectorMeshes[currentSector].scanned) {
                        // Check if another drone is already targeting this sector
                        const isSectorAlreadyTargeted = drones.some((otherDrone, otherIdx) =>
                            otherIdx !== i &&
                            otherDrone.target &&
                            otherDrone.target.sector === currentSector
                        );
                        if (isSectorAlreadyTargeted) {
                            // Another drone is already targeting this sector, continue to our target
                            addThought(i, 'info', `📡 Looks like ${currentSector} is already being handled by another drone — continuing to ${d.target.sector}.`);
                            // Continue with existing target
                        } else {
                            // Check for unfound survivors in this sector
                            const hasUnfoundSurvivors = SURVIVORS.some(s => {
                                if (s.found) return false;
                                const sr = Math.floor(s.z / CELL), sc = Math.floor(s.x / CELL);
                                return sr === curR && sc === curC;
                            });

                            // ONLY stop for survivors if:
                            // 1. Survivors are actually found AND
                            // 2. The drone is reasonably close to its target (within 3 sectors) OR
                            // 3. The survivor is in a sector that's strategically important
                            if (hasUnfoundSurvivors) {
                                // Calculate distance to target in sectors
                                if (d.target.sector) {
                                    const targetParts = d.target.sector.split('_');
                                    const targetR = parseInt(targetParts[0].substring(1));
                                    const targetC = parseInt(targetParts[1]);
                                    const sectorDist = Math.abs(curR - targetR) + Math.abs(curC - targetC);

                                    // Only stop for opportunistic rescue if we're close to target (within 3 sectors)
                                    // or if explicitly configured to be more aggressive
                                    if (sectorDist <= 3) {
                                        addThought(i, 'alert', `Picking up a signal! Survivors might be in ${currentSector} — intercepting on my way to ${d.target.sector}...`);
                                        d._originalTarget = d.target;
                                        d.target = { x: curC * CELL + CELL / 2, z: curR * CELL + CELL / 2, sector: currentSector };
                                        d.state = "scanning";
                                        d.scanTimer = 0;
                                        addMCP(i, 'call', 'thermal_scan', { drone_id: `drone_${i + 1}`, sector: currentSector }, { status: 'intercepting_rescue' });
                                        return; // Stop moving this frame to rescue survivors
                                    }
                                    // If too far from target, continue moving (don't stop for distant survivors)
                                }
                            }
                            // If no survivors found or too far from target, continue moving to assigned target
                        }
                    }

                    // Smart RTB: estimate battery needed to return.
                    // Since hazards increase drain by 1.5x - 3x, we must be very conservative.
                    const distToBase = Math.hypot(d.group.position.x - BASE.x, d.group.position.z - BASE.z);
                    const batteryToReturn = distToBase * DRAIN_PER_UNIT * 1.8 + 5;
                    if (d.battery < batteryToReturn && d.target.sector) {
                        const qs = globalQueue.find(q => q.k === d.target.sector);
                        if (qs) qs.assigned = false; // release sector for other drones
                        if (useLLM && mcpClient && mcpClient.connected) {
                            mcpClient.callTool('assign_target', { drone_id: `drone_${i + 1}`, sector_id: '__RECALL__' }).catch(e => console.warn(e));
                        }
                        addThought(i, 'danger', `Battery's at ${d.battery.toFixed(0)}% — need about ${batteryToReturn.toFixed(0)}% to make it back. Returning NOW!`);
                        d.target = { x: BASE.x, z: BASE.z, sector: null, hazard: "clear" };
                        d.state = "moving";
                    }
                } else {
                    if (d.target.sector) {
                        d.state = "scanning"; d.scanTimer = 0;
                        addMCP(i, 'call', 'thermal_scan', { drone_id: `drone_${i + 1}`, sector: d.target.sector }, { status: 'scanning', radius: SCAN_RADIUS });
                        addThought(i, 'action', `Reached ${d.target.sector} — deploying thermal scan (radius: ${SCAN_RADIUS}u)...`);
                    } else {
                        // Reached base
                        if (missionComplete) {
                            d.state = "idle"; // Mission done — park at base
                            d.group.position.set(BASE.x + i * 2, 3, BASE.z + i * 2);
                        } else {
                            d.recharging = true; d.state = "idle";
                            addMCP(i, 'call', 'recall_for_charging', { drone_id: `drone_${i + 1}` }, { status: 'charging', base: [BASE.x, BASE.z] });
                            addThought(i, 'action', `Back at base — charging up.`);
                        }
                    }
                }
            } // End of state === "moving"

            if (d.state === "scanning") {
                d.scanTimer += dt;
                d.group.position.y = DRONE_FLY_HEIGHT + Math.sin(elapsed * 4) * 0.4;
                d.group.rotation.y += dt * 0.8;
                scanSpheres[i].material.color.setHex(0x00ff88);
                scanSpheres[i].material.opacity = 0.06 + Math.sin(elapsed * 5) * 0.04;

                // Hard cap to avoid stuck scanning
                if (d.scanTimer > 8.0) {
                    d.state = "idle";
                    d.target = null;
                    d.scanTimer = 0;
                    addThought(i, 'warn', 'Scan timeout; resetting to idle.');
                    return;
                }

                if (d.scanTimer > 2.0) {
                    if (d.target && d.target.sector) {
                        const sm = sectorMeshes[d.target.sector];
                        if (sm) {
                            sm.scanned = true;
                            sm.discovered = true;
                            sm.mesh.material.color.setHex(0x152215);
                            sm.mesh.material.opacity = 0.4;
                        }
                        d.sectorsScanned++;

                        const qs = globalQueue.find(q => q.k === d.target.sector);
                        if (qs) qs.assigned = false;

                        addMCP(i, 'call', 'scan_sector', { id: `drone_${i + 1}`, sector_id: d.target.sector }, { scanned: true, survivors_in_range: survivorMeshes.filter(s => s.found).length });
                        addThought(i, 'info', `Done scanning ${d.target.sector}. Battery at ${d.battery.toFixed(0)}%, ${d.sectorsScanned} sectors covered so far.`);
                        d.battery -= 0.2; // Drain exactly once for the scan

                        if (d._fireScanQueue && d._fireScanQueue.length > 0) {
                            // Still more fire-adjacent sectors to scan — dispatch to next one
                            const next = d._fireScanQueue.shift();
                            d.target = { x: next.x, z: next.z, sector: next.k, hazard: hazardOf(next.r, next.c) };
                            d.state = "moving";
                            addThought(i, 'action', `🔥 Continuing fire-area scan — next up is sector ${next.k}.`);
                            console.info(`fire-diversion continue drone ${i + 1} -> ${next.k}`);
                        } else if (d._originalTarget) {
                            // Queue drained (fire diversion) or opportunistic rescue done — restore original route
                            const prevTarget = d.target.sector;
                            const wasFireScan = d._fireScanQueue !== null;
                            d.target = d._originalTarget;
                            d._originalTarget = null;
                            d._fireScanQueue = null;
                            d.state = "moving";
                            addThought(i, 'action', wasFireScan
                                ? `🔥 Fire-area scan around ${prevTarget} is done. Getting back on track to ${d.target.sector}.`
                                : `Rescue in ${prevTarget} wrapped up — resuming course to ${d.target.sector}.`);
                            console.info(`fire-diversion complete drone ${i + 1} returning to ${d.target ? d.target.sector : 'none'}`);
                        } else {
                            d.state = "idle"; // RESET TO IDLE SO AGENT CAN REASSIGN
                            d.target.sector = null;
                            if (useLLM && !assignmentQueue.includes(i)) assignmentQueue.push(i);
                            addThought(i, 'info', `✅ Finished scanning ${d.target ? d.target.sector : 'sector'}; awaiting next coordinator order.`);
                            console.info(`fire-diversion idle drone ${i + 1} queued for coordinator`);
                        }
                    }
                    scanSpheres[i].material.color.setHex(0x0066ff);
                    scanSpheres[i].material.opacity = 0.04;

                    if (d.battery <= 0) {
                        d.battery = 0; d.dead = true; d.state = 'idle';
                        d.group.position.y = 0.5;
                        d.group.children[0].material.color.setHex(0x330000);
                        d.group.children[0].material.emissive.setHex(0x110000);
                        addThought(i, 'danger', `⚠️ Battery died mid-scan — going down!`);
                        return;
                    }

                    // CHECK GLOBAL MISSION COMPLETION BEFORE QUEUING
                    const scanned = Object.values(sectorMeshes).filter(sec => sec.scanned).length;
                    const scannable = Object.values(sectorMeshes).length;
                    let isComplete = (missionGoal === 'scanAll') ? (scanned === scannable) : (totalFound >= totalSurvivorsInitially || scanned === scannable);

                    if (isComplete && !missionComplete) {
                        missionComplete = true;
                        drones.forEach((allD, dIdx) => {
                            if (!allD.dead) {
                                allD.target = { x: BASE.x, z: BASE.z, sector: null, hazard: "clear" };
                                allD.state = "moving";
                                if (dIdx === i) addThought(dIdx, 'info', `Mission objective met [${missionGoal}] — heading back to base with the fleet.`);
                            }
                        });
                        const totalTime = formatTime((performance.now() - missionStartTime - totalPausedTime) / 1000);
                        addThought(-1, 'phase', 'PHASE 4: MISSION COMPLETE — Summary');
                        addThought(-1, 'info', `Final progress: ${missionGoal === 'scanAll' ? (scanned + '/' + scannable + ' sectors') : (totalFound + '/' + totalSurvivorsInitially + ' survivors')}`);
                        addThought(i, 'alert', `🎯 Mission successful! [Total Time: ${totalTime}]`);
                        addMCP(i, 'call', 'finalize_mission', { completion_time: totalTime, goal: missionGoal }, { status: 'mission_complete' });
                        document.getElementById('final-time').textContent = totalTime;
                        document.getElementById('final-found').textContent = `${totalFound}/${totalSurvivorsInitially}`;
                        document.getElementById('final-sectors').textContent = `${scanned}/${scannable}`;
                        document.getElementById('success-modal').style.display = 'flex';
                        d.state = "moving"; // We are already RTB-ing above
                    } else if (!missionComplete) {
                        // IMMEDIATE ASSIGNMENT — push to batch queue
                        if (useLLM) {
                            d.state = "waiting_orders";
                            if (!assignmentQueue.includes(i)) {
                                assignmentQueue.push(i);
                            }
                        } else {
                            d.state = "waiting_orders";
                            addThought(i, 'danger', `Local brain is off — standing by for the MCP coordinator...`);
                        }
                    } else {
                        d.state = "moving"; // Returning to base
                    }
                }
            }


            scanSpheres[i].position.copy(d.group.position);
            d.battery = Math.max(0, d.battery);
        });


    } // End of if (!isPaused)

    // ─── CAMERA AND OVERLAYS (ALWAYS RUN) ───
    // Camera follow
    if (activeDrone >= 0 && activeDrone < drones.length) {
        const dp = drones[activeDrone].group.position;
        // Move camera + target by how much the drone moved this frame
        if (!drones[activeDrone]._lastCamPos) {
            drones[activeDrone]._lastCamPos = dp.clone();
            // Initial position: behind and above the drone
            cam.position.set(dp.x, dp.y + 12, dp.z - 18);
            controls.target.set(dp.x, dp.y, dp.z);
        }
        const delta = dp.clone().sub(drones[activeDrone]._lastCamPos);
        cam.position.add(delta);
        controls.target.add(delta);
        drones[activeDrone]._lastCamPos.copy(dp);
    } else if (activeDrone === -3) {
        // Swarm Group Tracking Camera
        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
        let activeCount = 0;
        drones.forEach(d => {
            if (!d.dead) {
                minX = Math.min(minX, d.group.position.x);
                minZ = Math.min(minZ, d.group.position.z);
                maxX = Math.max(maxX, d.group.position.x);
                maxZ = Math.max(maxZ, d.group.position.z);
                activeCount++;
            }
        });
        if (activeCount > 0) {
            const cx = (minX + maxX) / 2;
            const cz = (minZ + maxZ) / 2;
            const span = Math.max(maxX - minX, maxZ - minZ);

            controls.target.lerp(new THREE.Vector3(cx, 0, cz), 0.05);

            const maxDist = Math.max(40, span * 1.5 + 20);
            const desiredCamPos = new THREE.Vector3(cx, maxDist * 0.8, cz + maxDist * 0.5);
            cam.position.lerp(desiredCamPos, 0.05);
        } else {
            // All dead, aim at base
            controls.target.lerp(new THREE.Vector3(BASE.x, 0, BASE.z), 0.05);
            cam.position.lerp(new THREE.Vector3(BASE.x, 30, BASE.z + 30), 0.05);
        }
    }

    controls.update();

    // Always update HUD/minimap even when paused so interactions show immediately
    updateStatus();
    drawMinimap();
    renderThoughts();

    // Update drone overlay labels (always run so they track with camera orbit)
    for (let i = 0; i < drones.length; i++) {
        const label = document.getElementById(`drone-label-${i}`);
        if (!label) continue;

        const d = drones[i];
        // Hide if drone doesn't exist, is in camera view, or mission not started
        if (!d || !missionStarted || activeDrone >= 0) {
            label.style.display = 'none';
            continue;
        }

        label.style.display = 'block';

        // Project 3D position to screen
        const pos3 = d.group.position.clone();
        pos3.y += 3.5; // Adjusted height above drone
        pos3.project(cam);

        const x = (pos3.x * 0.5 + 0.5) * window.innerWidth;
        const y = (-(pos3.y) * 0.5 + 0.5) * window.innerHeight;

        // Hide if behind camera
        if (pos3.z > 1) {
            label.style.display = 'none';
            continue;
        }

        label.style.left = Math.round(x) + 'px';
        label.style.top = Math.round(y) + 'px';

        const statusText = d.dead ? 'CRASHED' : d.recharging ? 'CHARGING' : d.state === 'scanning' ? 'SCANNING' : d.state === 'moving' ? 'MOVING' : 'IDLE';
        const batClass = d.dead ? 'dead' : d.battery < 25 ? 'low' : '';
        const distToBase = Math.hypot(d.group.position.x - BASE.x, d.group.position.z - BASE.z);
        const estRTB = (distToBase * DRAIN_PER_UNIT * 1.4 + 8).toFixed(0);
        const color = DRONE_COLORS[i];

        label.innerHTML = `<span class="dl-name" style="color:${color}">D${i + 1}</span> ${statusText}<br>`
            + `<span class="dl-bat ${batClass}">⚡${d.battery.toFixed(0)}%</span>`
            + (d.dead ? '' : ` <span class="dl-rtb">← RTB: ~${estRTB}%</span>`);
    }

    renderer.render(scene, cam);
}
animate();

addEventListener('resize', () => {
    cam.aspect = innerWidth / innerHeight;
    cam.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
});

// ─── DRONE BUTTON EVENT DELEGATION ───
// Store pending button action to handle rapid HTML regeneration
let pendingButtonAction = null;
let pendingButtonTimer = null;

const fleetList = document.getElementById('fleet-list');

// Handle button mousedown - store the action immediately
fleetList.addEventListener('mousedown', function (e) {
    const btn = e.target.closest('.drone-card-btn');
    if (!btn) return;

    e.stopImmediatePropagation();
    e.stopPropagation();
    e.preventDefault();

    const droneIdx = parseInt(btn.getAttribute('data-drone-idx'));
    const action = btn.getAttribute('data-action');

    // Store action and execute on next frame
    pendingButtonAction = { droneIdx, action };

    // Clear any existing timer
    if (pendingButtonTimer) {
        clearTimeout(pendingButtonTimer);
    }

    // Execute after a short delay to ensure DOM is stable
    pendingButtonTimer = setTimeout(() => {
        if (pendingButtonAction) {
            const { droneIdx, action } = pendingButtonAction;
            if (action === 'kill') {
                killDrone(droneIdx);
            } else if (action === 'charge') {
                recallDrone(droneIdx);
            }
            pendingButtonAction = null;
        }
    }, 50);

    return false;
}, true);

// Also handle drone card clicks (for camera switching)
// Use same deferred pattern as buttons for consistency
let pendingCardAction = null;
let pendingCardTimer = null;

fleetList.addEventListener('mousedown', function (e) {
    // Only handle if clicking the card itself, not buttons
    if (e.target.closest('.drone-card-btn')) return;

    const card = e.target.closest('.drone-card');
    if (!card) return;

    e.stopPropagation();

    const droneIdx = parseInt(card.getAttribute('data-drone-idx'));
    if (isNaN(droneIdx)) return;

    // Store action and execute with delay
    pendingCardAction = droneIdx;

    if (pendingCardTimer) {
        clearTimeout(pendingCardTimer);
    }

    pendingCardTimer = setTimeout(() => {
        if (pendingCardAction !== null) {
            switchCam(pendingCardAction);
            pendingCardAction = null;
        }
    }, 50);
}, true);

// ─── MCP SYNC LOOP ───
let isSyncing = false;
async function syncWithServer() {
    if (!initReady || isPaused || isSyncing) return;
    isSyncing = true;
    try {
        // Report drone telemetry to engine (drones report their position/battery back)
        for (let i = 0; i < drones.length; i++) {
            const d = drones[i];
            const safeBat = Number.isFinite(d.battery) ? Math.max(0, d.battery) : 0;
            const safeX = Number.isFinite(d.group.position.x) ? d.group.position.x : 0;
            const safeY = Number.isFinite(d.group.position.y) ? d.group.position.y : 0;
            const safeZ = Number.isFinite(d.group.position.z) ? d.group.position.z : 0;

            // We only want to forcefully clear the target if the drone is actively charging at base.
            // If it is merely waiting_orders, it might have JUST received an order that we haven't synced yet.
            const droneStatus = safeBat <= 0 ? 'offline' : (d.recharging ? 'charging' : (d.state === 'idle' ? 'waiting_orders' : d.state));
            const clearTargetFlag = (droneStatus === 'charging');

            await mcpClient.callTool('report_telemetry', {
                drone_id: `drone_${i + 1}`,
                battery: safeBat,
                x: safeX,
                y: safeY,
                z: safeZ,
                status: droneStatus,
                clear_target: clearTargetFlag
            });
        }
        const resp = await mcpClient.callTool('get_world_state', {});
        if (resp && resp.content && resp.content.length > 0) {
            const world = JSON.parse(resp.content[0].text);

            // Sync Mission Log (Reasoning)
            if (world.mission_log) {
                world.mission_log.forEach(entry => {
                    // ── Strategy line ──────────────────────────────────────────
                    if (entry.includes("🧠 STRATEGY:")) {
                        const strat = entry.split("🧠 STRATEGY:")[1].trim();
                        const exists = thoughtLogs.some(log => log.some(t => t.msg.includes(strat)));
                        if (!exists) addThought(-1, 'phase', `🧠 Strategy decided: ${strat}`);
                    }

                    // ── Per-drone structured reasoning ─────────────────────────
                    // Format: "🧠 REASONING: drone_X → SY_Z: [OBSERVATION]:... [RISK ASSESSMENT]:... [DECISION]:..."
                    if (entry.includes("🧠 REASONING:")) {
                        const body = entry.split("🧠 REASONING:")[1].trim();
                        // Parse "drone_X → SY_Z: <reason text>"
                        const match = body.match(/^(drone_\d+)\s*→\s*(\S+):\s*(.+)$/s);
                        if (match) {
                            const [, droneId, sector, reasonText] = match;
                            const droneIdx = parseInt(droneId.split('_')[1]) - 1;
                            // Deduplicate: skip if this exact reasoning is already logged
                            const exists = droneIdx >= 0 && thoughtLogs[droneIdx] &&
                                thoughtLogs[droneIdx].some(t => t.msg.includes(sector) && t.msg.includes('[OBSERVATION]'));
                            if (!exists && droneIdx >= 0 && droneIdx < drones.length) {
                                addThought(droneIdx, 'reason', reasonText);
                            }
                        }
                    }
                });
            }

            // Sync Hazards and Scanned Status
            Object.keys(world.sectors).forEach(sid => {
                const sServer = world.sectors[sid];
                const sm = sectorMeshes[sid];
                if (sm) {
                    // Only ever set scanned/discovered to true; never back to false on client
                    if (sServer.scanned) sm.scanned = true;
                    if (sServer.discovered) sm.discovered = true;
                }
            });

            // Render ground-truth fire/smoke (visible to everyone, independent of AI discovery)
            if (world.ground_truth_hazards) {
                Object.entries(world.ground_truth_hazards).forEach(([sid, hazard]) => {
                    const sm = sectorMeshes[sid];
                    if (!sm) return;
                    if (hazard === "fire" && !FIRE.has(sid)) {
                        sm.mesh.material.color.setHex(0x2a0800);
                        sm.hazard = "fire"; // Update local state for movement logic
                        FIRE.add(sid);
                        spawnFireAt(sid);
                    } else if (hazard === "smoke" && !SMOKE.has(sid)) {
                        sm.mesh.material.color.setHex(0x1a1508);
                        sm.hazard = "smoke";
                        SMOKE.add(sid);
                        spawnSmokeAt(sid);
                    }
                });
            }

            // Sync Drone Assignments (only when using MCP/API as the source of truth)
            if (useLLM && mcpClient && mcpClient.connected) {
                Object.keys(world.drones).forEach(did => {
                    const idx = parseInt(did.split('_')[1]) - 1;
                    const d = drones[idx];
                    if (!d) return;
                    const sDrone = world.drones[did];

                    // If the server has a target, and the frontend either has NO target or a DIFFERENT target
                    if (sDrone.target_sector && (!d.target || d.target.sector !== sDrone.target_sector)) {
                        const qIdx = assignmentQueue.indexOf(idx);
                        if (qIdx > -1) assignmentQueue.splice(qIdx, 1);

                        if (sDrone.target_sector === "__RECALL__") {
                            d.target = { x: BASE.x, z: BASE.z, sector: null, hazard: "clear" };
                            d.state = "moving";
                        } else {
                            const sm = sectorMeshes[sDrone.target_sector];
                            if (sm) {
                                d.target = { x: sm.c * CELL + CELL / 2, z: sm.r * CELL + CELL / 2, sector: sDrone.target_sector, hazard: sm.hazard };
                                d.state = "moving";
                                // Show the reason as structured reasoning if it has the [OBSERVATION] tags,
                                // otherwise wrap it in a plain action message
                                const rawReason = sDrone.reason || `Proceed to ${sDrone.target_sector}`;
                                if (rawReason.includes('[OBSERVATION]')) {
                                    addThought(idx, 'reason', rawReason);
                                } else {
                                    addThought(idx, 'action', `🎯 Assigned to ${sDrone.target_sector} — ${rawReason}`);
                                }
                            }
                        }
                    } else if ((!sDrone.target_sector) && d.target && d.target.sector) {
                        // Sync: Server says No Target, but frontend still thinks it has one
                        d.target = { x: d.group.position.x, z: d.group.position.z, sector: null, hazard: "clear" };
                        if (d.state !== "scanning") d.state = "idle";
                    }
                });
            }

            // --- SYNC SURVIVORS & MISSION STATUS ---
            serverMetrics.elapsed = world.elapsed_seconds;
            serverMetrics.found = world.found_survivors;
            serverMetrics.total = world.total_survivors;
            const sectorsObj = world.sectors || {};
            const discoveredFallback = Object.values(sectorsObj).filter(s => s.discovered).length;
            serverMetrics.scanned = world.sectors_scanned ?? 0;
            serverMetrics.scannable = world.total_scannable_sectors ?? Object.keys(sectorsObj).length;
            serverMetrics.discovered = world.sectors_discovered ?? discoveredFallback;

            // --- UPDATE WIND & TEMPERATURE DISPLAYS ---
            if (world.wind) {
                const windSpeed = Math.round(world.wind.speed_kmh);
                const windAngle = world.wind.angle_deg;
                // Convert angle to compass direction
                const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
                const dirIdx = Math.round(windAngle / 45) % 8;
                const windDir = dirs[dirIdx];
                document.getElementById('wind-display').textContent = `${windSpeed} km/h ${windDir}`;
            }

            // Simulate temperature based on fire zones (more fire = higher temp)
            const fireCount = FIRE.size;
            const baseTemp = 28; // Base forest temperature
            const fireImpact = fireCount * 2; // Each fire zone adds 2°C
            const currentTemp = baseTemp + fireImpact + Math.sin(Date.now() / 5000) * 2; // Slight fluctuation
            document.getElementById('temp-display').textContent = `${Math.round(currentTemp)}°C`;

            // Sync Mission Completion
            if (world.mission_complete && !missionComplete) {
                missionComplete = true;
                const totalTime = formatTime(world.elapsed_seconds);
                addThought(-1, 'phase', 'PHASE 4: MISSION COMPLETE — Summary');
                addThought(-1, 'alert', `🎯 Mission successful! [Total Time: ${totalTime}]`);
                document.getElementById('final-time').textContent = totalTime;
                document.getElementById('final-found').textContent = `${world.found_survivors}/${world.total_survivors}`;
                document.getElementById('final-sectors').textContent = `${world.sectors_scanned}/${world.total_scannable_sectors}`;
                document.getElementById('success-modal').style.display = 'flex';

                drones.forEach((d, i) => {
                    if (!d.dead) {
                        d.target = { x: BASE.x, z: BASE.z, sector: null, hazard: "clear" };
                        d.state = "moving";
                    }
                });
            }

            // Sync Survivors (God Mode Visualization)
            if (world.all_survivors) {
                totalFound = world.found_survivors; // Sync HUD counter
                const discoveredSet = new Set((world.discovered_survivors || []).map(p => `${p[0]},${p[2]}`));

                world.all_survivors.forEach(survivor => {
                    // Handle both old format (array) and new format (object with pos/expired)
                    const pos = survivor.pos || survivor;
                    const isExpired = survivor.expired || false;
                    const id = `${pos[0]},${pos[2]}`;
                    const isDiscovered = discoveredSet.has(id);

                    // Check if we already have a mesh at this pos
                    let existing = survivorMeshes.find(m => Math.abs(m.body.position.x - pos[0]) < 0.5 && Math.abs(m.body.position.z - pos[2]) < 0.5);

                    if (!existing) {
                        // Create NEW visual
                        // Red = Unfound, Green = Found, Gray/Black X = Expired/Dead
                        let color, geometry, scale;
                        if (isExpired) {
                            color = 0x444444; // Gray for dead
                            geometry = new THREE.BoxGeometry(0.6, 0.6, 0.6); // X shape using box
                            scale = 1;
                        } else if (isDiscovered) {
                            color = 0x00ff44; // Green for found
                            geometry = new THREE.SphereGeometry(0.8, 12, 12);
                            scale = 1;
                        } else {
                            color = 0xff3300; // Red for unfound
                            geometry = new THREE.SphereGeometry(0.4, 12, 12);
                            scale = 1;
                        }

                        const mesh = new THREE.Mesh(
                            geometry,
                            new THREE.MeshStandardMaterial({
                                color: color,
                                emissive: color,
                                emissiveIntensity: isExpired ? 0.1 : (isDiscovered ? 0.7 : 0.4),
                                roughness: 0.3
                            })
                        );

                        // For expired survivors, rotate to form an X
                        if (isExpired) {
                            mesh.rotation.x = Math.PI / 4;
                            mesh.rotation.y = Math.PI / 4;
                            mesh.position.set(pos[0], 0.5, pos[2]);
                        } else {
                            mesh.position.set(pos[0], isDiscovered ? 0.8 : 0.4, pos[2]);
                        }

                        scene.add(mesh);

                        let ring = null;
                        if (isDiscovered && !isExpired) {
                            ring = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.08, 8, 24), new THREE.MeshBasicMaterial({ color: 0x00ff44, transparent: true, opacity: 0.3 }));
                            ring.rotation.x = -Math.PI / 2; ring.position.set(pos[0], 0.2, pos[2]); scene.add(ring);
                        }

                        survivorMeshes.push({ body: mesh, ring, found: isDiscovered, expired: isExpired, pos_id: id });

                        // Add to SURVIVORS array for minimap
                        SURVIVORS.push({ x: pos[0], y: pos[1], z: pos[2], found: isDiscovered, expired: isExpired });
                    } else if (!existing.expired && isExpired) {
                        // TRANSITION: Alive -> Dead (Expired)
                        existing.expired = true;
                        existing.body.material.color.setHex(0x444444);
                        existing.body.material.emissive.setHex(0x444444);
                        existing.body.material.emissiveIntensity = 0.1;

                        // Change geometry to X shape (box)
                        const oldPos = existing.body.position.clone();
                        scene.remove(existing.body);

                        const newMesh = new THREE.Mesh(
                            new THREE.BoxGeometry(0.6, 0.6, 0.6),
                            new THREE.MeshStandardMaterial({
                                color: 0x444444,
                                emissive: 0x444444,
                                emissiveIntensity: 0.1,
                                roughness: 0.3
                            })
                        );
                        newMesh.rotation.x = Math.PI / 4;
                        newMesh.rotation.y = Math.PI / 4;
                        newMesh.position.copy(oldPos);
                        newMesh.position.y = 0.5;
                        scene.add(newMesh);
                        existing.body = newMesh;

                        // Remove ring if exists
                        if (existing.ring) {
                            scene.remove(existing.ring);
                            existing.ring = null;
                        }

                        // Sync Minimap - update the SURVIVORS array
                        const m = SURVIVORS.find(s => {
                            const sid = `${s.x},${s.z}`;
                            return sid === id;
                        });
                        if (m) {
                            m.expired = true;
                            console.log(`💀 Survivor at ${id} marked as EXPIRED in minimap`);
                        }
                    } else if (isDiscovered && !existing.found && !isExpired) {
                        // TRANSITION: Unfound (Red) -> Found (Green)
                        existing.found = true;
                        existing.body.material.color.setHex(0x00ff44);
                        existing.body.material.emissive.setHex(0x00ff44);
                        existing.body.material.emissiveIntensity = 0.7;
                        existing.body.scale.setScalar(2); // Make it larger (0.4 -> 0.8)
                        existing.body.position.y = 0.8;

                        // Add Pulsing Ring
                        const ring = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.08, 8, 24), new THREE.MeshBasicMaterial({ color: 0x00ff44, transparent: true, opacity: 0.3 }));
                        ring.rotation.x = -Math.PI / 2; ring.position.set(pos[0], 0.2, pos[2]); scene.add(ring);
                        existing.ring = ring;

                        // Sync Minimap - use the pos_id to find the exact survivor
                        const m = SURVIVORS.find(s => {
                            const sid = `${s.x},${s.z}`;
                            return sid === id;
                        });
                        if (m) m.found = true;
                    }
                });

                // Direct sync: Ensure SURVIVORS array matches world state expired status
                world.all_survivors.forEach(survivor => {
                    const pos = survivor.pos || survivor;
                    const isExpired = survivor.expired || false;
                    const id = `${pos[0]},${pos[2]}`;

                    // Update SURVIVORS array
                    const s = SURVIVORS.find(sv => {
                        const sid = `${sv.x},${sv.z}`;
                        return sid === id;
                    });
                    if (s && s.expired !== isExpired) {
                        s.expired = isExpired;
                        if (isExpired) console.log(`💀 Synced dead survivor at ${id} to minimap`);
                    }

                    // Update survivorMeshes array
                    const sm = survivorMeshes.find(m => m.pos_id === id);
                    if (sm && sm.expired !== isExpired) {
                        sm.expired = isExpired;
                    }
                });
            }
        }
    } catch (e) { console.warn("Sync failed:", e); }
    finally { isSyncing = false; }
}
setInterval(syncWithServer, 500);

// UNIFIED startMission — creates drones, calls MCP, renders ground-truth fire
window.startMission = async function () {
    if (missionStarted) return;
    if (!useLLM || !mcpClient || !mcpClient.connected) {
        alert("LLM/MCP not connected. Please start the full stack (API + MCP + orchestrator) and reload.");
        return;
    }

    const survCount = parseInt(document.getElementById('surv-count').value);
    const droneCount = parseInt(document.getElementById('drone-count').value);
    const goal = document.getElementById('mission-goal').value;

    missionGoal = goal;
    totalSurvivorsInitially = survCount;
    missionStarted = true;
    missionStartTime = performance.now();
    document.getElementById('start-controls').style.display = 'none';

    // Enable Add Drone button
    const addDroneBtn = document.getElementById('add-drone-btn');
    if (addDroneBtn) {
        addDroneBtn.style.opacity = '1';
        addDroneBtn.style.pointerEvents = 'auto';
        addDroneBtn.style.cursor = 'pointer';
    }

    // ── Clear previous state ──
    drones.forEach(d => scene.remove(d.group));
    scanSpheres.forEach(s => scene.remove(s));
    drones.length = 0;
    scanSpheres.length = 0;
    FIRE.clear();
    SMOKE.clear();
    fireParticles.forEach(f => scene.remove(f.mesh));
    fireParticles.length = 0;
    smokePlanes.forEach(p => scene.remove(p.mesh));
    smokePlanes.length = 0;
    survivorMeshes.forEach(m => { scene.remove(m.body); if (m.ring) scene.remove(m.ring); });
    survivorMeshes.length = 0;
    SURVIVORS.length = 0;
    totalFound = 0;

    // Reset all sector visuals
    Object.keys(sectorMeshes).forEach(sid => {
        const sm = sectorMeshes[sid];
        sm.mesh.material.color.setHex(0x0f2f0f);
        sm.hazard = "clear";
        sm.scanned = false;
    });

    // ── Create drones ──
    DRONE_COLORS.length = 0;
    assignmentQueue.length = 0;
    for (let i = 0; i < droneCount; i++) {
        const color = getRandomDroneColor();
        DRONE_COLORS.push(color);
        const g = createDrone(color);
        g.position.set(BASE.x + i * 2, DRONE_FLY_HEIGHT, BASE.z + i * 2);
        scene.add(g);

        const scanMesh = new THREE.Mesh(
            new THREE.SphereGeometry(SCAN_RADIUS, 16, 16),
            new THREE.MeshBasicMaterial({ color: 0x0066ff, transparent: true, opacity: 0.04, wireframe: true })
        );
        scanMesh.position.copy(g.position); scene.add(scanMesh);
        scanSpheres.push(scanMesh);

        drones.push({
            group: g, rotors: g.children.filter(c => c.type === 'Mesh' && c.geometry.type === 'CylinderGeometry' && c.geometry.parameters.height === 0.03),
            battery: 100,
            target: null, state: useLLM ? "waiting_orders" : "idle", scanTimer: 0, recharging: false,
            path: [{ x: g.position.x, z: g.position.z }],
            sectorsScanned: 0, avoidCount: 0,
            stuckCheck: { x: g.position.x, z: g.position.z, frame: 0 },
            escapeMode: "none",
            escapeTimer: 0,
            defaultHeight: DRONE_FLY_HEIGHT,
            targetHeight: DRONE_FLY_HEIGHT,
            dead: false,
            _lastSector: null,     // tracks last sector to detect transitions for fly-over scan
            _fireScanQueue: null,  // queue of adjacent sectors to scan when fire is detected en route
        });
        if (useLLM) assignmentQueue.push(i);
    }

    // Show/hide drone labels based on drone count
    for (let i = 0; i < drones.length; i++) {
        const label = document.getElementById(`drone-label-${i}`);
        if (label) label.style.display = 'block';
    }

    // ── Thought log ──
    addThought(-1, 'phase', 'PHASE 1: DISCOVERY — Scouting the fleet & environment');
    addThought(-1, 'action', 'Calling list_drones() to see what we\'ve got on the network...');
    addThought(-1, 'info', `Found ${drones.length} drones: ${DRONE_NAMES.slice(0, drones.length).join(', ')}`);
    addThought(-1, 'phase', 'PHASE 2: DEPLOYMENT — Initializing the swarm');

    document.getElementById('start-btn').style.display = 'none';
    document.getElementById('surv-count').disabled = true;
    document.getElementById('drone-count').disabled = true;
    document.getElementById('mission-goal').disabled = true;

    totalPausedTime = 0;
    pauseStartTime = 0;

    // ── Call MCP to start mission (generates hazards & survivors on engine) ──
    if (useLLM && mcpClient && mcpClient.connected && !mcpClient.isShim) {
        try {
            const resp = await mcpClient.callTool('start_mission', {
                survivor_count: survCount,
                active_drones: droneCount
            });
            if (resp && resp.content && resp.content.length > 0) {
                const result = JSON.parse(resp.content[0].text);
                addThought(-1, 'info', `Engine started — ${result.total_survivors} survivors placed, hazards generated.`);
                applyHazardsFromWorld(result.world || {});
            }
        } catch (e) {
            console.error("Failed to start mission via MCP:", e);
        }

        // ── Render ground-truth fire/smoke (visible to everyone) ──
        try {
            const worldResp = await mcpClient.callTool('get_world_state', {});
            if (worldResp && worldResp.content && worldResp.content.length > 0) {
                const world = JSON.parse(worldResp.content[0].text);
                applyHazardsFromWorld(world);
            }
        } catch (e) {
            console.warn("Failed to fetch ground truth hazards:", e);
        }
    } else {
        // Fallback: hit REST API to seed hazards when no MCP backend
        const world = await fetchWorldHazards();
        if (world) {
            applyHazardsFromWorld(world);
            addThought(-1, 'info', 'Hazards seeded from API fallback');
        }
    }

    addThought(-1, 'info', 'Strategy: prioritize fire-adjacent sectors — survivors are most likely trapped there.');
    addThought(-1, 'phase', 'PHASE 3: EXECUTION — Autonomous wildfire search sweep');

    // Start sync loop
    setTimeout(syncWithServer, 500);
};

// Mark initialization complete so sync/handlers can run even without MCP backend
initReady = true;
})();
