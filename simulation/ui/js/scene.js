import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function buildScene(state) {
    const { GRID } = state;

    // Create background scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x060810);
    scene.fog = new THREE.FogExp2(0x060810, 0.003);

    // Set up renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setSize(innerWidth, innerHeight);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.shadowMap.enabled = false;
    document.body.appendChild(renderer.domElement);

    // Set up camera
    const cam = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 1000);
    cam.position.set(100, 140, -30);

    // Orbit controls
    const controls = new OrbitControls(cam, renderer.domElement);
    controls.target.set(100, 0, 100);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.maxPolarAngle = Math.PI / 2.1;

    // Lightning
    const ambientLight = new THREE.AmbientLight(0x223344, 0.4);
    scene.add(ambientLight);

    // Sun direction
    const sun = new THREE.DirectionalLight(0xffddaa, 0.6);
    sun.position.set(60, 120, 40);
    scene.add(sun);

    const hemiLight = new THREE.HemisphereLight(0x112233, 0x221100, 0.25);
    scene.add(hemiLight);

    // Sunlight
    const sunGlow = new THREE.PointLight(0xffaa00, 2, 300);
    const sunMesh = new THREE.Mesh(
        new THREE.SphereGeometry(15, 32, 32),
        new THREE.MeshBasicMaterial({ color: 0xffffee, transparent: true, opacity: 0.9 })
    );
    const sunHalo = new THREE.Mesh(
        new THREE.SphereGeometry(18, 32, 32),
        new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending })
    );
    sunMesh.add(sunHalo);
    sunMesh.add(sunGlow);
    sunMesh.position.set(120, 100, -80);
    sunMesh.visible = false;
    scene.add(sunMesh);
    sun.position.copy(sunMesh.position);

    // Moonlight
    const moonGlow = new THREE.PointLight(0x88aaff, 1.5, 200);
    const moonMesh = new THREE.Mesh(
        new THREE.SphereGeometry(12, 32, 32),
        new THREE.MeshBasicMaterial({ color: 0xccddff })
    );
    const moonHalo = new THREE.Mesh(
        new THREE.SphereGeometry(14, 32, 32),
        new THREE.MeshBasicMaterial({ color: 0x6688ff, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending })
    );
    moonMesh.add(moonHalo);
    moonMesh.add(moonGlow);
    moonMesh.position.set(80, 100, -60);
    moonMesh.visible = true;
    scene.add(moonMesh);

    // Day/night toggle
    let isNight = true;
    function toggleDayNight() {
        isNight = !isNight;
        if (isNight) {
            scene.background.setHex(0x060810);
            scene.fog.color.setHex(0x060810);
            ambientLight.intensity = 0.4;
            sun.intensity = 0.6;
            hemiLight.intensity = 0.25;
            sunMesh.visible = false;
            moonMesh.visible = true;
        } else {
            scene.background.setHex(0x87CEEB);
            scene.fog.color.setHex(0x87CEEB);
            ambientLight.intensity = 1.2;
            sun.intensity = 1.4;
            hemiLight.intensity = 0.8;
            sunMesh.visible = true;
            moonMesh.visible = false;
        }
        return isNight;
    }

    // Ground
    const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(GRID + 20, GRID + 20),
        new THREE.MeshStandardMaterial({ color: 0x0f1f0f, roughness: 0.95 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(GRID / 2, -0.01, GRID / 2);
    ground.receiveShadow = false;
    scene.add(ground);

    window.addEventListener('resize', () => {
        cam.aspect = innerWidth / innerHeight;
        cam.updateProjectionMatrix();
        renderer.setSize(innerWidth, innerHeight);
    });

    return {
        scene,
        renderer,
        cam,
        controls,
        toggleDayNight,
        lights: { ambientLight, sun, moonMesh, sunMesh, hemiLight },
    };
}
