export function initMinimap(state, utils) {
    const mapCanvas = document.getElementById('minimap');
    const mapCtx = mapCanvas.getContext('2d');
    const MAP_W = 260, MAP_H = 260, MAP_PAD = 5;
    const MAP_CELL = (MAP_W - MAP_PAD * 2) / state.SECTORS;

    function draw() {
        const { GRID, SECTORS, SCAN_RADIUS, sectorMeshes, obstacles, SURVIVORS, drones, DRONE_COLORS, DRONE_NAMES, activeDrone } = state;
        const { hazardOf, hslWithAlpha } = utils;
        mapCtx.clearRect(0, 0, MAP_W, MAP_H);
        mapCtx.fillStyle = '#0d1520';
        mapCtx.fillRect(0, 0, MAP_W, MAP_H);

        for (let r = 0; r < SECTORS; r++) for (let c = 0; c < SECTORS; c++) {
            const h = hazardOf(r, c), scanned = sectorMeshes[`S${r}_${c}`]?.scanned;
            let fill = '#1a3a1a';
            if (h === 'fire') fill = scanned ? '#663300' : '#441100';
            else if (h === 'smoke') fill = scanned ? '#1a4a2a' : '#332810';
            else fill = scanned ? '#006633' : '#1a2a1a';
            const x = MAP_PAD + c * MAP_CELL, y = MAP_PAD + r * MAP_CELL;
            mapCtx.fillStyle = fill;
            mapCtx.fillRect(x + 1, y + 1, MAP_CELL - 2, MAP_CELL - 2);
            mapCtx.strokeStyle = '#2a3a2a'; mapCtx.lineWidth = 0.5;
            mapCtx.strokeRect(x + 1, y + 1, MAP_CELL - 2, MAP_CELL - 2);
            if (scanned) {
                mapCtx.fillStyle = h === 'fire' ? 'rgba(255,120,0,0.28)' : 'rgba(0,255,100,0.35)';
                mapCtx.fillRect(x + 1, y + 1, MAP_CELL - 2, MAP_CELL - 2);
            }
            if (h === 'fire') { mapCtx.fillStyle = '#ff440066'; mapCtx.font = '12px sans-serif'; mapCtx.fillText('🔥', x + MAP_CELL / 2 - 7, y + MAP_CELL / 2 + 5); }
        }

        mapCtx.fillStyle = '#33553322';
        obstacles.forEach(o => {
            const ox = MAP_PAD + (o.x / GRID) * (MAP_W - MAP_PAD * 2);
            const oy = MAP_PAD + (o.z / GRID) * (MAP_H - MAP_PAD * 2);
            mapCtx.beginPath(); mapCtx.arc(ox, oy, 1.5, 0, Math.PI * 2); mapCtx.fill();
        });

        SURVIVORS.forEach((s) => {
            const sx = MAP_PAD + (s.x / GRID) * (MAP_W - MAP_PAD * 2);
            const sy = MAP_PAD + (s.z / GRID) * (MAP_H - MAP_PAD * 2);
            const matchingMesh = state.survivorMeshes.find(m => Math.abs(m.body.position.x - s.x) < 0.5 && Math.abs(m.body.position.z - s.z) < 0.5);
            const isExpired = matchingMesh?.expired === true || s.expired === true;
            const isFound = matchingMesh?.found === true || s.found === true;
            if (isExpired) {
                const size = 4;
                mapCtx.beginPath();
                mapCtx.strokeStyle = '#000000';
                mapCtx.lineWidth = 2;
                mapCtx.moveTo(sx - size, sy - size);
                mapCtx.lineTo(sx + size, sy + size);
                mapCtx.moveTo(sx + size, sy - size);
                mapCtx.lineTo(sx - size, sy + size);
                mapCtx.stroke();
            } else if (isFound) {
                mapCtx.beginPath(); mapCtx.arc(sx, sy, 3, 0, Math.PI * 2); mapCtx.fillStyle = '#00ff44'; mapCtx.fill();
            } else {
                mapCtx.beginPath(); mapCtx.arc(sx, sy, 3, 0, Math.PI * 2); mapCtx.fillStyle = '#ff3300'; mapCtx.fill();
                mapCtx.beginPath(); mapCtx.arc(sx, sy, 5, 0, Math.PI * 2); mapCtx.strokeStyle = '#ff440044'; mapCtx.lineWidth = 1; mapCtx.stroke();
            }
        });

        drones.forEach((d, i) => {
            if (activeDrone >= 0 && activeDrone !== i) return;
            const color = DRONE_COLORS[i];
            if (d.path.length > 1) {
                mapCtx.beginPath(); mapCtx.strokeStyle = hslWithAlpha(color, 0.4); mapCtx.lineWidth = 1.2;
                d.path.forEach((pt, pi) => {
                    const px = MAP_PAD + (pt.x / GRID) * (MAP_W - MAP_PAD * 2);
                    const py = MAP_PAD + (pt.z / GRID) * (MAP_H - MAP_PAD * 2);
                    if (pi === 0) mapCtx.moveTo(px, py); else mapCtx.lineTo(px, py);
                });
                mapCtx.stroke();
            }
            const p = d.group.position;
            const dx2 = MAP_PAD + (p.x / GRID) * (MAP_W - MAP_PAD * 2);
            const dy2 = MAP_PAD + (p.z / GRID) * (MAP_H - MAP_PAD * 2);
            const sr = (SCAN_RADIUS / GRID) * (MAP_W - MAP_PAD * 2);
            mapCtx.beginPath(); mapCtx.arc(dx2, dy2, sr, 0, Math.PI * 2); mapCtx.strokeStyle = hslWithAlpha(color, 0.2); mapCtx.lineWidth = 0.8; mapCtx.stroke();
            mapCtx.beginPath(); mapCtx.arc(dx2, dy2, 4, 0, Math.PI * 2); mapCtx.fillStyle = color; mapCtx.fill();
            mapCtx.fillStyle = '#e0f0ff'; mapCtx.font = 'bold 7px sans-serif'; mapCtx.textAlign = 'center'; mapCtx.fillText(`${i + 1}`, dx2, dy2 + 2.5);
        });

        drones.forEach((d, i) => {
            if (activeDrone >= 0 && activeDrone !== i) return;
            if (d.target && d.state === 'moving') {
                const color = DRONE_COLORS[i], p = d.group.position;
                const dx2 = MAP_PAD + (p.x / GRID) * (MAP_W - MAP_PAD * 2);
                const dy2 = MAP_PAD + (p.z / GRID) * (MAP_H - MAP_PAD * 2);
                const tx = MAP_PAD + (d.target.x / GRID) * (MAP_W - MAP_PAD * 2);
                const ty = MAP_PAD + (d.target.z / GRID) * (MAP_H - MAP_PAD * 2);
                mapCtx.beginPath(); mapCtx.setLineDash([3, 3]); mapCtx.strokeStyle = hslWithAlpha(color, 0.5); mapCtx.lineWidth = 1;
                mapCtx.moveTo(dx2, dy2); mapCtx.lineTo(tx, ty); mapCtx.stroke(); mapCtx.setLineDash([]);
            }
        });
    }

    return { drawMinimap: draw };
}
