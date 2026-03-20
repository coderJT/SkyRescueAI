import * as THREE from 'three';
import { apiFetch, apiClient, connectApi } from './api.js';
import { initState } from './state.js';
import { registerHud } from './hud.js';
import { initMinimap } from './minimap.js';
import { DRONE_FLY_HEIGHT, getRandomDroneColor, hslWithAlpha, hazardOf as hazardOfFn } from './utils.js';
import { initLogs } from './logs.js';
import { buildScene } from './scene.js';
import { initEnvironment } from './environment.js';
import { buildDroneVisual } from './drones.js';

window.startMission = window.startMission || (() => console.warn('Simulation initializing...'));
let initReady = false;

(async function init() {

    const SETTINGS = await (window.fetchSettings ? window.fetchSettings().catch(() => ({})) : Promise.resolve({}));

    // Initialize state from state.js
    const state = initState(SETTINGS);
    // Try API bridge connection for status dot; UI remains render-only
    try { await connectApi(); } catch (e) { console.warn('API bridge unreachable', e); }
    // Expose for HUD/other modules that don't import it directly
    window.apiClient = apiClient;

    const {
        GRID, SECTORS, CELL, SCAN_RADIUS,
        DRONE_COLORS, DRONE_NAMES, SURVIVORS, BASE, drones, scanSpheres,
        thoughtLogs, NO_FLY_MACRO, NO_FLY, FIRE, SMOKE, obstacles, sectorMeshes,
        survivorMeshes, fireParticles, smokePlanes
    } = state;

    const DRAIN_PER_UNIT = SETTINGS.drain_per_unit;

    let isPaused = false;
    let pauseStartTime = 0;
    let totalPausedTime = 0;
    let showScannedSectors = false;
    let MOVE_SPEED = (SETTINGS.autopilot_speed ?? 6.0); // server-driven; not used client-side
    let activeDrone = -1;
    let lastMissionLogSize = 0;
    let telemetryAccum = 0;

    registerHud({
        getIsPaused: () => isPaused,
        setIsPaused: (v) => { isPaused = v; },
        markPauseStart: (t) => { pauseStartTime = t; },
        addPausedDuration: (now) => { totalPausedTime += (now - pauseStartTime); },
        setShowScanned: (fn) => { showScannedSectors = typeof fn === 'function' ? fn(showScannedSectors) : !!fn; return showScannedSectors; },
        setMoveSpeed: (v) => { MOVE_SPEED = v; },
    });

    const useLLM = false; // UI no longer issues MCP tool calls
    const TELEMETRY_INTERVAL = 0.25;

    const utils = { getRandomDroneColor, hslWithAlpha, hazardOf: (r, c) => hazardOfFn(state, r, c) };
    const hazardOf = utils.hazardOf;
    const { drawMinimap } = initMinimap(state, utils);
    const { addThought, renderThoughts, setLogFilter, updateFilterButtons } = initLogs(state, utils, apiClient);
    const setDayNightLabel = (isNight) => {
        const btn = document.getElementById('daynight-btn');
        if (btn) btn.textContent = isNight ? '🌙 Night [N]' : '☀️ Day [N]';
    };
    const METRICS_DEBUG = () => Boolean(window.DEBUG_METRICS);
    function logMetrics(tag, data) {
        if (!METRICS_DEBUG()) return;
        console.debug(`[metrics:${tag}]`, JSON.parse(JSON.stringify(data)));
    }
    const isScanning = (d) => d && (d.status === 'scanning' || d.scanning_pending);

    function finishScan(droneIdx) {
        const d = drones[droneIdx];
        if (!d || !d.target || !d.target.sector) {
            if (d) { d.status = "idle"; d.target = null; d.scanTimer = 0; }
            return;
        }
        const sectorId = d.target.sector;
        // Optimistically mark scanned locally to prevent re-assignment loops
        const sm = sectorMeshes[sectorId];
        if (sm) { sm.scanned = true; sm.discovered = true; }

        d.status = "idle";
        d.scanTimer = 0;
        d.scanCooldown = 2.0;
        d.status = "idle";
        d.target = null;
        addThought(droneIdx, 'info', `✅ Finished scanning ${sectorId}. (UI-local)`);
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

    const { scene, renderer, cam, controls, toggleDayNight } = buildScene(state);
    window.toggleDayNight = function () {
        const isNight = toggleDayNight();
        setDayNightLabel(isNight);
    };
    setDayNightLabel(true);
    const { applyHazardsFromWorld, spawnFireAt, spawnSmokeAt, updateFireSmoke } = initEnvironment(state, scene, (x, z, r, h) => obstacles.push({ x, z, radius: r || OBSTACLE_RADIUS, height: h || 20 }));

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

    // ─── VOLCANO (MOUNTAIN LANDMARK) ───
    // Survivors

    // ─── DRONES ───
    const PATH_SAMPLE_INTERVAL = 5;
    let frameCount = 0;
    const seenHazardRedirects = new Set();
    let showThermalOnMap = false;

    // Remove obstacles near base so drones never get stuck at spawn
    for (let oi = obstacles.length - 1; oi >= 0; oi--) {
        if (Math.hypot(obstacles[oi].x - BASE.x, obstacles[oi].z - BASE.z) < 15) {
            obstacles.splice(oi, 1);
        }
    }

    // Swarm assignments only (no local queue); targets come from MCP

    // Assign initial targets (called by start button)
    let missionStarted = false;
    let missionStartTime = 0;
    let missionComplete = false;

    function formatTime(sec) {
        const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
        return `${m}m ${s.toString().padStart(2, '0')}s`;
    }
    // NOTE: startMission is defined at the bottom of the file (after syncWithServer)
    // to ensure all dependencies (api client, syncWithServer, etc.) are available.

    function askLLMForSector(d, i) {
        return;
    }

    async function sendTelemetry(clearTarget = false) {
        const tasks = [];
        drones.forEach((d, i) => {
            const name = DRONE_NAMES[i] || `drone_${i + 1}`;
            tasks.push(apiClient.callTool('report_telemetry', {
                drone_id: name,
                battery: d.battery ?? 100,
                x: d.group.position.x,
                y: d.group.position.y,
                z: d.group.position.z,
                status: d.status,
                clear_target: clearTarget,
            }).catch(() => null));
        });
        await Promise.all(tasks);
    }

    async function notifyArrival(droneIdx, sectorId) {
        const name = DRONE_NAMES[droneIdx] || `drone_${droneIdx + 1}`;
        try {
            await apiClient.callTool('thermal_scan', {
                id: name,
                sector_id: sectorId,
                sector: sectorId,
                drone_id: name,
            });
            addThought(droneIdx, 'info', `🌡️ Arrived at ${sectorId}, performing thermal scan.`);
        } catch (e) {
            addThought(droneIdx, 'warning', `Thermal scan failed at ${sectorId}: ${e.message || e}`);
        }
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
        const filterHtml = ['all', 'llm', 'mcp'] // keep filter id for compatibility with UI labels
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
        else if (k === 'h') toggleThermalOverlay();
        else if (k === 'p') togglePause();
        else if (k === 'n') setDayNightLabel(toggleDayNight());
        else if (k === 'r') location.reload();
    });

    // Manual Drone Kill Function
    window.killDrone = function () {
        showAlertDialog('Control disabled — managed by backend');
    };

    // Manual RTB — force a drone back to the charging station immediately
    window.recallDrone = function () {
        showAlertDialog('Recall disabled — managed by backend');
    };

    // Add drone disabled in UI; backend controls fleet.
    window.addNewDrone = function () { showAlertDialog('Add drone disabled — managed by backend'); };

    // Status
    let missionGoal = "scanAll";
    let totalSurvivorsInitially = 0;
    let totalFound = 0;
    let prevFoundCount = 0;
    let alertTimeout = null;

    function toggleThermalOverlay() {
        showThermalOnMap = !showThermalOnMap;
        document.getElementById('scan-toggle')?.classList.toggle('active', showThermalOnMap);
        state.showThermalOnMap = showThermalOnMap;
    }

    function updateStatus() {
        // Mission info
        let h = '';
        const totalSectors = state.metrics.sectors_total || state.metrics.scannable || Object.keys(sectorMeshes).length;
        const totalSurvivors = state.metrics.total_survivors || 0;
        h += `<div class="sr"><span class="sl">Coverage</span><span class="sv">${state.metrics.thermal_scanned}/${totalSectors}</span></div>`;
        h += `<div class="sr"><span class="sl">Discovered</span><span class="sv">${state.metrics.sectors_discovered}/${totalSectors}</span></div>`;
        h += `<div class="sr"><span class="sl">Survivors</span><span class="sv det">${state.metrics.survivors_found}/${totalSurvivors}</span></div>`;
        if (missionStarted) {
            h += `<div class="sr"><span class="sl">Time</span><span class="sv">${formatTime(state.metrics.elapsed ?? 0)}</span></div>`;
        }
        h += `<div class="sr"><span class="sl">Obstacles</span><span class="sv">${obstacles.length} tracked</span></div>`;
        document.getElementById('sc').innerHTML = h;
        logMetrics('render', {
            covered: `${state.metrics.thermal_scanned}/${totalSectors}`,
            discovered: `${state.metrics.sectors_discovered}/${totalSectors}`,
            survivors: `${state.metrics.survivors_found}/${totalSurvivors}`,
            elapsed: state.metrics.elapsed ?? 0,
        });
        // Drone fleet cards
        let fleetHtml = '';
        drones.forEach((d, i) => {
            const color = DRONE_COLORS[i] || '#7aa8cc';
            const statusClass = d.dead ? 'dead' : d.recharging ? 'recharging' : d.status === 'scanning' ? 'scanning' : d.status === 'moving' ? 'moving' : 'idle';
            const statusText = d.dead ? 'OFFLINE' : d.recharging ? 'CHARGING' : d.status === 'scanning' ? 'SCANNING' : d.status === 'moving' ? 'EN ROUTE' : 'IDLE';
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

        if ((state.metrics.survivors_found ?? 0) > prevFoundCount) {
            prevFoundCount = state.metrics.survivors_found ?? 0;
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

    // ─── ANIMATION LOOP ───
    const clock = new THREE.Clock();
    let elapsed = 0;

    function animate() {
        requestAnimationFrame(animate);
        const dt = clock.getDelta();

        if (!isPaused) {
            elapsed += dt;
            frameCount++;
            telemetryAccum += dt;
            updateFireSmoke(elapsed);

            // Sector Visualization 
            Object.values(sectorMeshes).forEach(s => {
                const isFire = s.hazard === "fire";
                if (s.thermal_scanned) {
                    // Only tint sectors that were thermal scanned (high-contrast lime/amber)
                    s.mesh.material.color.setHex(isFire ? 0xff9933 : 0x66ff33);
                    s.mesh.material.opacity = 0.6;
                    s.mesh.material.emissive.setHex(isFire ? 0x552200 : 0x115500);
                } else if (s.scanned || s.discovered) {
                    // Leave non-thermal scanned sectors neutral
                    s.mesh.material.color.setHex(isFire ? 0x442211 : 0x0f2f0f);
                    s.mesh.material.opacity = 0.3;
                    s.mesh.material.emissive.setHex(isFire ? 0x110800 : 0x000500);
                }
            });

            // Update drones: client-driven movement toward targets
            drones.forEach((d, i) => {
                const scanning = isScanning(d);
                if (d.targetPos && !scanning) {
                    const dir = d.targetPos.clone().sub(d.group.position);
                    const dist = dir.length();
                    if (dist > 0.001) {
                        const step = MOVE_SPEED * dt;
                        const moved = Math.min(step, dist);
                        if (dist <= step) {
                            d.group.position.copy(d.targetPos);
                            if (!d.arrivalNotified && d.target && d.target.sector) {
                                d.arrivalNotified = true;
                                d.status = 'idle';
                                notifyArrival(i, d.target.sector);
                            }
                        } else {
                            dir.normalize().multiplyScalar(step);
                            d.group.position.add(dir);
                            d.status = 'moving';
                        }
                        // Battery drain on movement (UI-side)
                        if (DRAIN_PER_UNIT != null) {
                            d.battery = Math.max(0, (d.battery ?? 100) - (moved * DRAIN_PER_UNIT));
                        }
                    }
                }
                // Record path for minimap (cap length)
                if (!d.path) d.path = [];
                d.path.push({ x: d.group.position.x, z: d.group.position.z });
                if (d.path.length > 80) d.path.shift();
                d.rotors.forEach(r => r.rotation.y += dt * 30);
                scanSpheres[i].position.copy(d.group.position);
            });

            // Periodic telemetry to backend
            if (telemetryAccum >= TELEMETRY_INTERVAL) {
                sendTelemetry();
                telemetryAccum = 0;
            }

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

            const statusText = d.dead ? 'CRASHED' : d.recharging ? 'CHARGING' : d.status === 'scanning' ? 'SCANNING' : d.status === 'moving' ? 'MOVING' : 'IDLE';
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
            const resp = await apiFetch('/state');
            const world = resp.ok ? resp.json : null;
            if (world) {

                // Sync Mission Log (Reasoning)
                if (world.mission_log) {
                    // Push new mission log lines into thoughts
                    for (let i = lastMissionLogSize; i < world.mission_log.length; i++) {
                        const entry = world.mission_log[i];
                        // Prefix with drone if present like "[drone_1]"
                        const droneMatch = entry.match(/\[(drone_\d+)\]/i);
                        const dIdx = droneMatch ? parseInt(droneMatch[1].split('_')[1], 10) - 1 : -1;
                        let tType = 'info';
                        if (entry.includes('🛠 MCP')) tType = 'mcp-call';
                        else if (entry.includes('🤖 LLM') || entry.includes('🧠 LLM')) tType = 'llm';
                        addThought(dIdx >= 0 ? dIdx : -1, tType, entry);
                    }
                    lastMissionLogSize = world.mission_log.length;

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

                // Hazard redirect events: override current target immediately
                if (world.hazard_redirects && Array.isArray(world.hazard_redirects)) {
                    world.hazard_redirects.forEach(evt => {
                        const eid = evt.event_id || evt.id || `${evt.drone_id}-${evt.sector_id}-${evt.ts}`;
                        if (seenHazardRedirects.has(eid)) return;
                        seenHazardRedirects.add(eid);
                        const idx = evt.drone_id ? parseInt(evt.drone_id.split('_')[1]) - 1 : -1;
                        if (idx < 0 || idx >= drones.length) return;
                        const d = drones[idx];
                        const [cx, , cz] = evt.center || [null, null, null];
                        if (cx == null || cz == null) return;
                        if (!d.targetPos) d.targetPos = d.group.position.clone();
                        d.targetPos.set(cx, DRONE_FLY_HEIGHT, cz);
                        d.target = { sector: evt.sector_id, x: cx, z: cz };
                        // d.status = 'moving';
                        d.arrivalNotified = false;
                        addThought(idx, 'warning', `⚠️ Hazard redirect → ${evt.sector_id} (${evt.reason || 'hazard'})`);
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
                        if (sServer.thermal_scanned) sm.thermal_scanned = true;
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

                // Sync drone poses/status purely from backend state
                Object.keys(world.drones || {}).forEach(did => {
                    const idx = parseInt(did.split('_')[1]) - 1;
                    const d = drones[idx];
                    if (!d) return;
                    const sDrone = world.drones[did];
                    const [x, , z] = sDrone.coordinates || [d.group.position.x, 5, d.group.position.z];
                    if (!d.initialized) {
                        d.initialized = true;
                    }
                    const sector = sDrone.target_sector && (world.sectors || {})[sDrone.target_sector];
                    const serverScanning = sDrone.status === 'scanning';
                    if (serverScanning || isScanning(d)) {
                        // Respect scanning state: only update pose/battery; keep target/targetPos intact
                        d.group.position.set(x, DRONE_FLY_HEIGHT, z);
                        d.targetPos = d.targetPos || d.group.position.clone();
                        if (sDrone.battery != null) d.battery = sDrone.battery;
                        d.status = 'scanning';
                    } else if (sector && sector.center) {
                        const [cx, cz] = sector.center;
                        if (!d.targetPos) d.targetPos = d.group.position.clone();
                        d.targetPos.set(cx, DRONE_FLY_HEIGHT, cz);
                        d.target = { sector: sDrone.target_sector, x: cx, z: cz };
                        d.state = 'moving';
                        d.status = 'moving';
                        if (sDrone.battery != null) d.battery = sDrone.battery;
                        d.arrivalNotified = false;
                    } else {
                        // No target; stay at current pose
                        d.group.position.set(x, DRONE_FLY_HEIGHT, z);
                        d.targetPos = d.group.position.clone();
                        d.target = null;
                        d.state = sDrone.status || 'idle';
                        d.status = sDrone.status || d.status || "idle";
                        if (sDrone.battery != null) d.battery = sDrone.battery;
                        d.arrivalNotified = false;
                    }
                });

                // --- SYNC SURVIVORS & MISSION STATUS ---
                const sectorsObj = world.sectors || {};
                const discoveredFallback = Object.values(sectorsObj).filter(s => s.discovered).length;
                state.metrics.elapsed = world.elapsed_seconds;
                state.metrics.survivors_found = world.found_survivors;
                state.metrics.total_survivors = world.total_survivors;
                state.metrics.sectors_scanned = world.sectors_scanned ?? 0;
                state.metrics.sectors_total = world.total_scannable_sectors ?? Object.keys(sectorsObj).length;
                state.metrics.sectors_discovered = world.sectors_discovered ?? discoveredFallback;
                state.metrics.discovery_pct = world.discovery_pct ?? (state.metrics.sectors_total ? Math.round(state.metrics.sectors_discovered / state.metrics.sectors_total * 100) : 0);
                state.metrics.thermal_scanned = world.thermal_scanned ?? 0;
                state.metrics.coverage_pct = world.coverage_pct ?? (state.metrics.sectors_total ? Math.round(state.metrics.thermal_scanned / state.metrics.sectors_total * 100) : 0);
                logMetrics('sync', {
                    scanned: state.metrics.sectors_scanned,
                    total: state.metrics.sectors_total,
                    discovered: state.metrics.sectors_discovered,
                    cov_pct: state.metrics.coverage_pct,
                    disc_pct: state.metrics.discovery_pct,
                    surv_found: state.metrics.survivors_found,
                    surv_total: state.metrics.total_survivors,
                    elapsed: state.metrics.elapsed,
                });

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
                            // d.status = "moving";
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
        for (let i = 0; i < droneCount; i++) {
            const color = getRandomDroneColor();
            DRONE_COLORS.push(color);
            const { group: g, rotors, scanMesh } = buildDroneVisual({
                colorHex: DRONE_COLORS[i],
                scanRadius: SCAN_RADIUS,
                base: BASE,
                idx: i,
                flyHeight: DRONE_FLY_HEIGHT,
                scene,
            });
            scanSpheres.push(scanMesh);

            drones.push({
                group: g, rotors,
                battery: 100,
                target: null, status: "idle", scanTimer: 0, recharging: false,
                path: [{ x: g.position.x, z: g.position.z }],
                sectorsScanned: 0, avoidCount: 0,
                stuckCheck: { x: g.position.x, z: g.position.z, frame: 0 },
                escapeMode: "none",
                escapeTimer: 0,
                defaultHeight: DRONE_FLY_HEIGHT,
                targetHeight: DRONE_FLY_HEIGHT,
                dead: false,
                _offlineNotified: false,
            });
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
        // Ensure thought panel is visible and filter reset
        document.getElementById('thoughts-content').style.display = 'block';
        state.logFilter = 'all';
        updateFilterButtons();

        document.getElementById('start-btn').style.display = 'none';
        document.getElementById('surv-count').disabled = true;
        document.getElementById('drone-count').disabled = true;
        document.getElementById('mission-goal').disabled = true;

        totalPausedTime = 0;
        pauseStartTime = 0;

        // ── Call MCP to start mission (generates hazards & survivors on engine) ──
        try {
            const resp = await apiFetch('/commands/start', { method: 'POST', body: JSON.stringify({ survivor_count: survCount, active_drones: droneCount }) });
            if (resp.ok && resp.json) {
                addThought(-1, 'info', `Engine started — survivors placed, hazards generated.`);
                applyHazardsFromWorld(resp.json.world || {});
            }
        } catch (e) {
            console.error("Failed to start mission via API:", e);
        }

        addThought(-1, 'info', 'Strategy: prioritize fire-adjacent sectors — survivors are most likely trapped there.');
        addThought(-1, 'phase', 'PHASE 3: EXECUTION — Autonomous wildfire search sweep');

        // Start sync loop
        setTimeout(syncWithServer, 500);
    };

    // Mark initialization complete so sync/handlers can run even without MCP backend
    initReady = true;
})();
