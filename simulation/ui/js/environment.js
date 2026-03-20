import * as THREE from 'three';
import { OBSTACLE_RADIUS, hazardOf as hazardOfFn, hslWithAlpha } from './utils.js';

export function initEnvironment(state, scene, registerObstacle) {
    const {
        GRID, SECTORS, CELL,
        FIRE, SMOKE, NO_FLY,
        sectorMeshes, survivorMeshes, fireParticles, smokePlanes,
        obstacles,
    } = state;

    function registerObstacleDefault(x, z, r, h) {
        const entry = { x, z, radius: r || OBSTACLE_RADIUS, height: h || 20 };
        obstacles.push(entry);
    }

    const addObstacle = registerObstacle || registerObstacleDefault;

    // Sector tiles
    for (let r = 0; r < SECTORS; r++) for (let c = 0; c < SECTORS; c++) {
        const h = hazardOfFn(state, r, c);
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

    // Trees, stones, ponds
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
        addObstacle(cx, cz, 1.2, trunkH + (burned ? 0 : 6));

        if (!burned) {
            const canopyR = 2 + Math.random() * 2.5;
            const mats = [treeMaterials.canopyDark, treeMaterials.canopyMed, treeMaterials.canopyLight];
            const canopy = new THREE.Mesh(
                new THREE.SphereGeometry(canopyR, 7, 7),
                mats[Math.floor(Math.random() * mats.length)]
            );
            canopy.position.set(cx + (Math.random() - 0.5) * 1.5, trunkH + canopyR * 0.4, cz + (Math.random() - 0.5) * 1.5);
            scene.add(canopy);
            if (Math.random() > 0.4) {
                const c2 = new THREE.Mesh(
                    new THREE.SphereGeometry(canopyR * 0.65, 6, 6),
                    mats[Math.floor(Math.random() * mats.length)]
                );
                c2.position.set(cx + (Math.random() - 0.5) * 3, trunkH - 1 + Math.random() * 2, cz + (Math.random() - 0.5) * 3);
                scene.add(c2);
            }
        } else {
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

    function spawnStone(cx, cz, scale = 1) {
        const size = (0.5 + Math.random() * 1.5) * scale;
        const geo = new THREE.IcosahedronGeometry(size, 0);
        const mesh = new THREE.Mesh(geo, treeMaterials.stone);
        mesh.position.set(cx, size * 0.6, cz);
        mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
        mesh.scale.set(1, 0.4 + Math.random() * 0.6, 1);
        scene.add(mesh);
        if (size > 1.2) {
            addObstacle(cx, cz, size * 0.8, size);
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
        addObstacle(cx, cz, 4, 7);
    }

    // CENTER CABIN
    spawnHouse(GRID / 2, GRID / 2, true);
    // ADDITIONAL HOUSES
    for (let i = 0; i < 10; i++) {
        let hx, hz, distToBase, distToVolcano;
        do {
            hx = 10 + Math.random() * (GRID - 20);
            hz = 10 + Math.random() * (GRID - 20);
            distToBase = Math.hypot(hx - GRID / 2, hz - GRID / 2);
            distToVolcano = Math.hypot(hx - 15, hz - 85);
        } while (distToBase < 15 || distToVolcano < 20);
        spawnHouse(hx, hz);
    }

    // VOLCANO
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
    const volX = 15, volZ = 85;
    volcanoG.position.set(volX, 0, volZ);
    scene.add(volcanoG);
    addObstacle(volX, volZ, 12, 15);
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

    // Trees/stones per sector
    for (let r = 0; r < SECTORS; r++) for (let c = 0; c < SECTORS; c++) {
        const h = hazardOfFn(state, r, c);
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

        if (h === 'clear' || h === 'smoke') {
            if (Math.random() > 0.7) {
                const sx = cx0 + 2 + Math.random() * (CELL - 4);
                const sz = cz0 + 2 + Math.random() * (CELL - 4);
                spawnStone(sx, sz);
            }
            if (h === 'clear' && Math.random() > 0.92) {
                const px = cx0 + CELL / 2 + (Math.random() - 0.5) * 4;
                const pz = cz0 + CELL / 2 + (Math.random() - 0.5) * 4;
                spawnPond(px, pz);
            }
        }
    }

    function spawnFireAt(sid) {
        const sm = sectorMeshes[sid];
        if (!sm) return;
        const { r, c } = sm;
        const cx = c * CELL + CELL / 2, cz = r * CELL + CELL / 2;
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

    function updateFireSmoke(elapsed) {
        fireParticles.forEach(f => {
            if (f.type === 'ember') {
                f.mesh.position.y = f.baseY + ((elapsed * f.speed + f.phase) % 8);
                f.mesh.position.x += Math.sin(elapsed * 2 + f.phase) * 0.01;
                f.mesh.material.opacity = Math.max(0, 0.9 - ((elapsed * f.speed + f.phase) % 8) * 0.12);
                if (f.mesh.position.y > f.baseY + 8) f.mesh.position.y = f.baseY;
            } else {
                const t = elapsed * f.speed + f.phase;
                f.mesh.position.y = f.baseY + Math.sin(t) * 0.8;
                f.mesh.material.opacity = 0.5 + Math.sin(t) * 0.2;
            }
        });

        smokePlanes.forEach(s => {
            const t = elapsed + s.phase;
            if (s.type === 'light') {
                s.mesh.position.y = s.baseY + Math.sin(t * 2) * 0.3;
                s.mesh.material.opacity = 0.05 + Math.sin(t * 3) * 0.02;
            } else {
                s.mesh.position.x = s.baseX + Math.sin(t * 0.7) * 2;
                s.mesh.position.z = s.baseZ + Math.cos(t * 0.5) * 1.5;
                const scale = 1 + Math.sin(t * 0.3) * 0.15;
                s.mesh.scale.set(scale, scale, scale);
            }
        });

        survivorMeshes.forEach((s, i) => {
            if (!s.found) {
                s.body.position.y = 0.4 + Math.sin(elapsed * 1.5 + i) * 0.15;
                const wavePulse = 1 + Math.sin(elapsed * 3 + i * 2) * 0.15;
                s.body.scale.set(wavePulse, 1, wavePulse);
            } else if (s.ring) {
                s.body.position.y = 0.8 + Math.abs(Math.sin(elapsed * 2 + i)) * 0.5;
                s.ring.scale.setScalar(1 + Math.sin(elapsed * 2 + i) * 0.3);
                s.ring.material.opacity = 0.2 + Math.sin(elapsed * 3 + i) * 0.15;
            }
        });
    }

    return {
        applyHazardsFromWorld,
        spawnFireAt,
        spawnSmokeAt,
        updateFireSmoke,
    };
}
