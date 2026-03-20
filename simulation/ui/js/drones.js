import * as THREE from 'three';

/**
 * Build and register a drone's visual elements.
 * Returns { group, rotors, scanMesh }.
 */
export function buildDroneVisual({ colorHex, scanRadius, base, idx, flyHeight, scene }) {
    const group = new THREE.Group();

    // Core body
    const body = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 0.5, 1.6),
        new THREE.MeshStandardMaterial({ color: colorHex, emissive: colorHex, emissiveIntensity: 0.4, roughness: 0.3 })
    );
    body.position.y = 0.25;
    group.add(body);

    // Arms & rotors
    const armLength = 1.2;
    const armGeo = new THREE.BoxGeometry(armLength, 0.12, 0.14);
    const armMat = new THREE.MeshStandardMaterial({ color: 0x2d2d2d, roughness: 0.35, metalness: 0.25 });
    const rotorGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.08, 20);
    const rotorMat = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, emissive: 0xaaaaaa, emissiveIntensity: 0.35, roughness: 0.2, metalness: 0.9 });
    const rotors = [];
    for (let i = 0; i < 4; i++) {
        const angle = (i / 4) * Math.PI * 2;
        const arm = new THREE.Mesh(armGeo, armMat);
        arm.position.set(
            Math.cos(angle) * armLength * 0.5,
            0.3,
            Math.sin(angle) * armLength * 0.5
        );
        arm.rotation.y = angle;
        group.add(arm);

        const rotor = new THREE.Mesh(rotorGeo, rotorMat);
        rotor.position.set(
            Math.cos(angle) * (armLength * 0.75),
            0.6,
            Math.sin(angle) * (armLength * 0.75)
        );
        rotor.rotation.x = Math.PI / 2;
        group.add(rotor);
        rotors.push(rotor);
    }

    // Position at base with offset
    const offsetX = idx * 2;
    const spawnX = base.x + offsetX;
    const spawnZ = base.z;
    group.position.set(spawnX, flyHeight, spawnZ);
    scene.add(group);

    // Scan wireframe sphere for visuals
    const scanMesh = new THREE.Mesh(
        new THREE.SphereGeometry(scanRadius, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0x0066ff, transparent: true, opacity: 0.04, wireframe: true })
    );
    scanMesh.position.copy(group.position);
    scene.add(scanMesh);

    return { group, rotors, scanMesh };
}
