// three.js viewer fed by the server's geom pose stream. No physics here.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const GEOM = { PLANE: 0, SPHERE: 2, ELLIPSOID: 4, CAPSULE: 3, CYLINDER: 5, BOX: 6 };

export function createViewer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf3f4f5);
  scene.fog = new THREE.Fog(0xf3f4f5, 7, 16);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
  camera.position.set(2.4, 1.7, 2.4);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0.5, 0);
  controls.enableDamping = true;

  scene.add(new THREE.HemisphereLight(0xffffff, 0xd6d9dd, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(3, 6, 2); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -4; sun.shadow.camera.right = sun.shadow.camera.top = 4;
  scene.add(sun);

  const world = new THREE.Group();
  world.rotation.x = -Math.PI / 2; // MuJoCo Z-up -> three Y-up
  scene.add(world);
  const grid = new THREE.GridHelper(40, 80, 0xd6d9dd, 0xe4e6ea);
  grid.rotation.x = Math.PI / 2; world.add(grid);

  let meshes = [];
  function geometryFor(type, [sx, sy, sz]) {
    switch (type) {
      case GEOM.PLANE: return new THREE.PlaneGeometry(sx > 0 ? sx * 2 : 40, sy > 0 ? sy * 2 : 40);
      case GEOM.SPHERE: return new THREE.SphereGeometry(sx, 32, 16);
      case GEOM.ELLIPSOID: return new THREE.SphereGeometry(1, 32, 16).scale(sx, sy, sz);
      case GEOM.CAPSULE: return new THREE.CapsuleGeometry(sx, sy * 2, 8, 24).rotateX(Math.PI / 2);
      case GEOM.CYLINDER: return new THREE.CylinderGeometry(sx, sx, sy * 2, 32).rotateX(Math.PI / 2);
      case GEOM.BOX: return new THREE.BoxGeometry(sx * 2, sy * 2, sz * 2);
      default: return null;
    }
  }
  function setGeoms(geoms) {
    for (const m of meshes) if (m) { world.remove(m); m.geometry.dispose(); m.material.dispose(); }
    meshes = geoms.map((g) => {
      const geometry = geometryFor(g.type, g.size);
      if (!geometry) return null;
      const isPlane = g.type === GEOM.PLANE;
      const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(g.rgba[0], g.rgba[1], g.rgba[2]), roughness: isPlane ? .95 : .5, metalness: isPlane ? 0 : .15, transparent: g.rgba[3] < 1, opacity: g.rgba[3] });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = !isPlane && g.rgba[3] >= 1; mesh.receiveShadow = true; mesh.matrixAutoUpdate = false;
      world.add(mesh);
      return mesh;
    });
  }
  const m4 = new THREE.Matrix4();
  function setPoses(p) {
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i]; if (!mesh) continue;
      const k = 12 * i;
      m4.set(p[k + 3], p[k + 4], p[k + 5], p[k], p[k + 6], p[k + 7], p[k + 8], p[k + 1], p[k + 9], p[k + 10], p[k + 11], p[k + 2], 0, 0, 0, 1);
      mesh.matrix.copy(m4);
    }
  }
  function resize() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
  addEventListener('resize', resize); resize();
  (function loop() { controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop); })();
  return { setGeoms, setPoses };
}
