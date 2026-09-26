// three.js viewer fed by the server's geom pose stream. No physics here.
// Renders MuJoCo primitives and mesh geoms (STL files served by the backend), and turns
// mouse drags on the robot into drag targets in MuJoCo world coordinates.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const GEOM = { PLANE: 0, SPHERE: 2, CAPSULE: 3, ELLIPSOID: 4, CYLINDER: 5, BOX: 6, MESH: 7 };
const HOME = { pos: [2.2, 1.5, 2.0], target: [0.2, 0.8, 0] };

export function createViewer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf3f4f5);
  scene.fog = new THREE.Fog(0xf3f4f5, 7, 16);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 100);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  function resetCamera() { camera.position.set(...HOME.pos); controls.target.set(...HOME.target); controls.update(); }
  resetCamera();

  scene.add(new THREE.HemisphereLight(0xffffff, 0xd6d9dd, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(3, 6, 2); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -4; sun.shadow.camera.right = sun.shadow.camera.top = 4;
  scene.add(sun);

  const world = new THREE.Group();
  world.rotation.x = -Math.PI / 2; // MuJoCo Z-up -> three Y-up; `world` local space IS MuJoCo space
  scene.add(world);
  const grid = new THREE.GridHelper(40, 80, 0xd6d9dd, 0xe4e6ea);
  grid.rotation.x = Math.PI / 2; world.add(grid);

  const stl = new STLLoader();
  const meshCache = new Map();
  function loadMesh(url) {
    if (!meshCache.has(url)) meshCache.set(url, new Promise((res, rej) => stl.load(url, (g) => { g.computeVertexNormals(); res(g); }, undefined, rej)));
    return meshCache.get(url);
  }
  function primitive(type, [sx, sy, sz]) {
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

  // ---------- the person: a rigged human (glTF) standing in for the capsule proxy ----------
  const personGroup = new THREE.Group(); world.add(personGroup);
  const avatarPivot = new THREE.Group(); avatarPivot.rotation.x = Math.PI / 2; personGroup.add(avatarPivot); // glTF is Y-up; world group is MuJoCo Z-up
  let avatar = null, mixer = null, clips = {}, activeClip = null, headMeshIndex = -1, lastPerson = null;
  new GLTFLoader().load('/scenes/people/Soldier.glb', (g) => {
    avatar = g.scene; avatar.scale.setScalar(0.92);
    avatar.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
    avatarPivot.add(avatar);
    mixer = new THREE.AnimationMixer(avatar);
    for (const c of g.animations) clips[c.name] = mixer.clipAction(c);
    play('Idle');
  }, undefined, () => {});
  function play(name) { if (!clips[name] || activeClip === name) return; const next = clips[name]; next.reset().fadeIn(0.25).play(); if (activeClip) clips[activeClip].fadeOut(0.25); activeClip = name; }
  function setPerson(p) {
    if (!p) return; lastPerson = p;
    personGroup.position.set(p.pos[0], p.pos[1], 0);
    const walking = !!p.motion?.walking;
    const yaw = walking ? p.motion.heading : Math.atan2(-p.pos[1], -p.pos[0]); // face the robot when standing
    personGroup.rotation.z = yaw + Math.PI / 2; // model faces +z in its own frame => +y after the pivot; rotate to heading
    play(walking ? 'Walk' : 'Idle');
    personGroup.visible = Math.hypot(p.pos[0], p.pos[1]) < 2.8; // parked far away => hidden
  }
  const clock = new THREE.Clock();
  const tmpV = new THREE.Vector3();
  // screen position (px) of the robot's head, for speech bubbles
  function projectHead() {
    const m = headMeshIndex >= 0 ? meshes[headMeshIndex] : null; if (!m) return null;
    tmpV.setFromMatrixPosition(m.matrixWorld); tmpV.project(camera);
    if (tmpV.z > 1) return null;
    const r = canvas.getBoundingClientRect();
    return { x: (tmpV.x + 1) / 2 * r.width + r.left, y: (1 - tmpV.y) / 2 * r.height + r.top - 40 };
  }

  let meshes = [], robotMeshes = [];
  async function setGeoms(desc) {
    for (const m of meshes) if (m) { world.remove(m); m.geometry.dispose(); m.material.dispose(); }
    meshes = []; robotMeshes = [];
    headMeshIndex = -1;
    for (const g of desc.geoms) {
      if (g.group === 3 || g.group > 3 || /^person_/.test(g.name)) { meshes.push(null); continue; } // collision geoms, hidden groups, the person's physics proxy
      if (g.mesh === 'head_link') headMeshIndex = meshes.length;
      let geometry = null;
      if (g.type === GEOM.MESH) {
        const file = desc.meshFiles?.[g.mesh];
        if (!file) { meshes.push(null); continue; }
        try { geometry = (await loadMesh(desc.meshBase + file)).clone(); } catch { meshes.push(null); continue; }
        if (g.meshScale && (g.meshScale[0] !== 1 || g.meshScale[1] !== 1 || g.meshScale[2] !== 1)) geometry.scale(...g.meshScale);
        if (g.meshPos && g.meshQuat) { // into MuJoCo's recentered mesh frame (see server describe())
          const [w, x, y, z] = g.meshQuat;
          geometry.translate(-g.meshPos[0], -g.meshPos[1], -g.meshPos[2]);
          geometry.applyQuaternion(new THREE.Quaternion(x, y, z, w).invert());
        }
      } else geometry = primitive(g.type, g.size);
      if (!geometry) { meshes.push(null); continue; }
      const isPlane = g.type === GEOM.PLANE, isRobot = g.type === GEOM.MESH;
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(g.rgba[0], g.rgba[1], g.rgba[2]),
        roughness: isPlane ? 0.95 : isRobot ? 0.45 : 0.55, metalness: isPlane ? 0 : isRobot ? 0.35 : 0.1,
        transparent: g.rgba[3] < 1, opacity: g.rgba[3],
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = !isPlane && g.rgba[3] >= 1; mesh.receiveShadow = true; mesh.matrixAutoUpdate = false;
      mesh.userData = { body: g.body, name: g.name, robot: isRobot };
      world.add(mesh);
      meshes.push(mesh);
      if (isRobot) robotMeshes.push(mesh);
    }
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

  // ---------- drag-to-pose ----------
  // Pointer down on a robot mesh grabs its body; while dragging, the grab point is moved on a camera-facing plane
  // through the original hit and reported in MuJoCo coordinates. `onDrag({ body, target })`, `onDrag({ body: null })`.
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(), hit = new THREE.Vector3();
  let drag = null, onDrag = () => {}, dragEnabled = false, hover = null;
  function pointerNdc(ev) { const r = canvas.getBoundingClientRect(); ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, camera); }
  function pick(ev) { pointerNdc(ev); const hits = ray.intersectObjects(robotMeshes, false); return hits[0] || null; }
  function toMujoco(v) { return world.worldToLocal(v.clone()).toArray().map((x) => +x.toFixed(4)); }
  canvas.addEventListener('pointerdown', (ev) => {
    if (!dragEnabled || ev.button !== 0) return;
    const h = pick(ev); if (!h) return;
    ev.preventDefault(); controls.enabled = false;
    canvas.setPointerCapture(ev.pointerId);
    plane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()).negate(), h.point);
    drag = { body: h.object.userData.body, point: h.point.clone() };
    h.object.material.emissive.setHex(0x1a3d7a);
    drag.mesh = h.object;
    onDrag({ body: drag.body, target: toMujoco(h.point) });
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (drag) {
      pointerNdc(ev);
      if (ray.ray.intersectPlane(plane, hit)) onDrag({ body: drag.body, target: toMujoco(hit) });
      return;
    }
    if (!dragEnabled) return;
    const h = pick(ev);
    if (hover && hover !== h?.object) { hover.material.emissive.setHex(0); hover = null; }
    if (h && h.object !== hover) { hover = h.object; hover.material.emissive.setHex(0x0b2a5c); }
    canvas.style.cursor = h ? 'grab' : '';
  });
  const endDrag = (ev) => {
    if (!drag) return;
    drag.mesh.material.emissive.setHex(0);
    try { canvas.releasePointerCapture(ev.pointerId); } catch {}
    drag = null; controls.enabled = true;
    onDrag({ body: null });
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  function setDragEnabled(on) { dragEnabled = !!on; if (!on) { canvas.style.cursor = ''; if (hover) { hover.material.emissive.setHex(0); hover = null; } } }

  function resize() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }
  addEventListener('resize', resize); resize();
  (function loop() { controls.update(); mixer?.update(clock.getDelta()); renderer.render(scene, camera); requestAnimationFrame(loop); })();

  return { setGeoms, setPoses, setPerson, projectHead, resetCamera, setDragEnabled, set onDrag(fn) { onDrag = fn; }, canvas };
}
