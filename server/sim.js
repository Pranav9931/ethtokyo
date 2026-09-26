// Authoritative MuJoCo simulation + the robot's autonomous "agent".
// Robot: Unitree G1 humanoid (29 position-controlled joints), pelvis welded to a stand,
// working at a bench. Runs in Node with the official @mujoco/mujoco WASM bindings.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import loadMujoco from '@mujoco/mujoco';
import { EventEmitter } from 'node:events';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCENE_DIR = path.join(__dirname, 'scenes', 'unitree_g1');

// ---------- poses (ctrl targets by actuator name; unspecified joints = 0 = standing) ----------
// Calibrated with FK for the right wrist: feeder box centre ≈ (0.40, -0.17, 0.875), bin at (0.12, -0.50).
const sym = (sp, sr, sy, el, wp, wy = 0) => ({ waist_yaw: wy, waist_pitch: wp, left_shoulder_pitch: sp, right_shoulder_pitch: sp, left_shoulder_roll: sr, right_shoulder_roll: -sr, left_shoulder_yaw: sy, right_shoulder_yaw: -sy, left_elbow: el, right_elbow: el });
const CARRY_YAW = -0.9;
const POSES = {
  stand:    {},
  approach: sym(-1.45, 0.35, 0.2, 1.05, 0.1),           // hands open high above the feeder, clear of the box
  descend:  sym(-1.2, 0.2, 0.2, 1.05, 0.15),            // hands open just above the box, 30 cm apart
  grasp:    sym(-1.1, 0.2, -0.2, 1.05, 0.3),            // hands close on the box, 24 cm apart
  lift:     sym(-1.4, 0.2, -0.2, 1.05, 0.1),            // straight up
  carry:    sym(-1.4, 0.2, -0.2, 1.05, 0.1, CARRY_YAW), // waist turned to the bin
  release:  sym(-1.3, 0.5, -0.2, 1.05, 0.1, CARRY_YAW), // hands open, box drops
  open_high: sym(-1.5, 0.6, 0.0, 0.9, 0.0),             // hands high and wide: first move of any retreat
  safe:     { left_shoulder_pitch: 0.1, right_shoulder_pitch: 0.1, left_elbow: 1.0, right_elbow: 1.0, left_shoulder_roll: 0.2, right_shoulder_roll: -0.2 }, // arms folded low at the sides
};
// One cycle: approach the feeder, grasp, lift, carry to the bin, release, come back. Loops forever.
const ROUTINE = ['recover', 'approach', 'descend', 'grasp', 'lift', 'carry', 'release', 'lift_back']; // after lift_back the cycle re-enters at 'approach'
const DWELL = { recover: 0.3, approach: 0.4, descend: 0.4, grasp: 0.5, lift: 0.4, carry: 0.6, release: 0.5, lift_back: 0.3 };
POSES.recover = sym(-1.5, 0.6, 0.0, 0.9, 0.0); // same as open_high: hands high and wide, clear of the feeder
POSES.lift_back = sym(-1.5, 0.5, -0.2, 1.05, 0.1, CARRY_YAW); // hands up and open before swinging back
const GRASP_RADIUS = 0.22;               // each wrist must be this close to the box centre to close on it

const LIMBS = [
  { key: 'left_leg',  label: 'Left leg',   prefixes: ['left_hip_', 'left_knee', 'left_ankle_'] },
  { key: 'right_leg', label: 'Right leg',  prefixes: ['right_hip_', 'right_knee', 'right_ankle_'] },
  { key: 'waist',     label: 'Waist',      prefixes: ['waist_'] },
  { key: 'left_arm',  label: 'Left arm',   prefixes: ['left_shoulder_', 'left_elbow', 'left_wrist_'] },
  { key: 'right_arm', label: 'Right arm',  prefixes: ['right_shoulder_', 'right_elbow', 'right_wrist_'] },
];

let TARGET_HOME = [0.40, 0, 0.89];           // where the feeder presents the next box
const BOX_PARK = [[3, 0, 0.06], [3.4, 0, 0.06], [3.8, 0, 0.06], [4.2, 0, 0.06], [4.6, 0, 0.06]];
const BELT = { x: [0.10, 0.40], yStart: -0.15, yEnd: -2.35, top: 0.72, speed: 0.35 }; // outfeed conveyor along -y
const OBSTACLE_PARK = [3, 3, 0.15];
const OBSTACLE_SPOT = [0.40, 0, 1.03];       // long crate racked across the feeder, right where the hands close
const PERSON_PARK = [3, -3, 0.66];
const PERSON_NEAR = [0.35, 0.55, 0.66];
const PERSON_AWAY = [1.4, 1.6, 0.66];
const HAZARD_RADIUS = 0.6;

const STUCK = {
  obstructed: { title: 'Arm blocked at the feeder', detail: 'Joint tracking error stayed high for 3 s. Something is in the reach path to the feeder. Back off, route the arm over it, or get it removed.', urgency: 'medium', reward: 0.075 },
  hazard:     { title: 'Person inside the robot cell', detail: 'A person is within 0.6 m of a hand. The robot is holding position. Tuck the arms, get the person out, confirm the cell is clear.', urgency: 'high', reward: 0.1 },
  lowconf:    { title: 'Cannot localize the next box', detail: 'The box is not on the feeder mark (pose deviates > 15 cm). Nudge it back onto the green mark, accept its new position, or skip it.', urgency: 'low', reward: 0.05 },
};

const ACTIONS = {
  hazard: [
    { id: 'retract', label: 'Tuck arms to safe pose', desc: 'Both arms back and close to the body, away from the person.' },
    { id: 'speak', label: 'Talk to the person', desc: 'Hold the mic: your voice plays from the robot\'s speaker and the person reacts to it.', needs: () => true },
    { id: 'step_back', label: 'Play the warning chime', desc: 'Automated announcement + light: the person leaves the cell.' },
    { id: 'confirm_clear', label: 'Confirm area clear', desc: 'You checked the camera: nobody within 0.6 m. Enables resume.', needs: (sim) => !sim.personNear },
  ],
  obstructed: [
    { id: 'retract', label: 'Back off', desc: 'Pull the arm out of contact with the crate.' },
    { id: 'request_removal', label: 'Request removal', desc: 'Ticket to the floor crew: the crate is carried away.' },
    { id: 'manual_clear', label: 'Work around it yourself', desc: 'Take manual control and see if the arm can get to the box past the crate.' },
  ],
  lowconf: [
    { id: 'rescan', label: 'Accept new box position', desc: 'You confirmed the box is intact: the agent re-plans the grasp around where it is now.' },
    { id: 'manual_nudge', label: 'Nudge it back yourself', desc: 'Drag the robot or use the sticks to push the box onto the green mark.' },
    { id: 'skip_part', label: 'Discard this box', desc: 'Box is damaged or missing: pull it and feed the next one.' },
  ],
};

export class Sim extends EventEmitter {
  static async create() {
    const mujoco = await loadMujoco();
    const vfs = new mujoco.MjVFS();
    for (const f of fs.readdirSync(path.join(SCENE_DIR, 'assets'))) vfs.addBuffer('assets/' + f, fs.readFileSync(path.join(SCENE_DIR, 'assets', f)));
    for (const f of ['g1_fixed.xml', 'scene.xml']) vfs.addBuffer(f, fs.readFileSync(path.join(SCENE_DIR, f)));
    const model = mujoco.MjModel.from_xml_path('scene.xml', vfs);
    const data = new mujoco.MjData(model);
    return new Sim(mujoco, model, data);
  }

  constructor(mujoco, model, data) {
    super();
    this.mujoco = mujoco; this.model = model; this.data = data;
    this.nu = model.nu;
    this.ctrl = data.ctrl; this.qpos = data.qpos; this.qvel = data.qvel;
    this.geomXpos = data.geom_xpos; this.geomXmat = data.geom_xmat;
    this.mocapPos = data.mocap_pos; this.xfrc = data.xfrc_applied;
    this.boxes = [0, 1, 2, 3, 4].map((i) => ({ body: model.body(`box${i}`).id, qadr: model.jnt_qposadr[model.jnt(`box${i}_free`).id], dadr: model.jnt_dofadr[model.jnt(`box${i}_free`).id] }));
    this.current = 0; this.held = null; this.processed = 0; this.releasedAt = null;
    this.personMocap = model.body_mocapid[model.body('person').id];
    this.obstacleMocap = model.body_mocapid[model.body('obstacle').id];
    this.rightWrist = model.body('right_wrist_yaw_link').id; this.leftWrist = model.body('left_wrist_yaw_link').id;
    this.handBodies = [this.leftWrist, this.rightWrist];
    Object.defineProperty(this, 'targetBody', { get: () => this.boxes[this.current].body });

    // actuator bookkeeping
    this.actNames = []; this.actQadr = []; this.actLimb = [];
    for (let i = 0; i < this.nu; i++) {
      const name = model.actuator(i).name.replace(/_joint$/, '');
      this.actNames.push(name);
      this.actQadr.push(model.jnt_qposadr[model.actuator_trnid[2 * i]]);
      this.actLimb.push(LIMBS.find((l) => l.prefixes.some((p) => name.startsWith(p)))?.key || 'other');
    }
    this.poseVec = (name) => this.actNames.map((n) => POSES[name][n] ?? 0);
    this.bodyLimb = new Map();
    for (let b = 0; b < model.nbody; b++) { const n = model.body(b).name; this.bodyLimb.set(b, LIMBS.find((l) => l.prefixes.some((p) => n.startsWith(p)))?.key || null); }

    this.mode = 'auto'; this.stuckReason = null;
    this.step = 0; this.stepEnteredAt = 0; this.highErrSince = null;
    this.teleTargets = new Float64Array(this.nu);
    this.personNear = false; this.sweepHigh = false; this.skipInspect = false; this.actionsDone = []; this.anims = [];
    this.drag = null; // { body, target:[x,y,z], limb }
    this.macro = null;
    this.reset();
  }

  // ---------- description for clients ----------
  describe() {
    const m = this.model, geoms = [];
    for (let i = 0; i < m.ngeom; i++) {
      const matid = m.geom_matid[i];
      const rgba = matid >= 0 ? Array.from(m.mat_rgba.subarray(4 * matid, 4 * matid + 4)) : Array.from(m.geom_rgba.subarray(4 * i, 4 * i + 4));
      const g = { name: m.geom(i).name, type: m.geom_type[i], group: m.geom_group[i], body: m.geom_bodyid[i], size: Array.from(m.geom_size.subarray(3 * i, 3 * i + 3)), rgba };
      if (g.type === 7) {
        const mid = m.geom_dataid[i]; g.mesh = m.mesh(mid).name; g.meshScale = Array.from(m.mesh_scale.subarray(3 * mid, 3 * mid + 3));
        // MuJoCo re-expresses mesh vertices in the mesh's inertial frame: v' = R(quat)^T (v - pos). The viewer must do the same to raw STL data.
        g.meshPos = Array.from(m.mesh_pos.subarray(3 * mid, 3 * mid + 3)); g.meshQuat = Array.from(m.mesh_quat.subarray(4 * mid, 4 * mid + 4));
      }
      geoms.push(g);
    }
    const meshFiles = {};
    for (const line of fs.readFileSync(path.join(SCENE_DIR, 'g1_fixed.xml'), 'utf8').matchAll(/<mesh\s+(?:name="([^"]+)"\s+)?file="([^"]+)"/g)) meshFiles[line[1] || line[2].replace(/\.[^.]+$/, '')] = line[2];
    const bodies = []; for (let b = 0; b < m.nbody; b++) bodies.push({ id: b, name: m.body(b).name, limb: this.bodyLimb.get(b) });
    const actuators = this.actNames.map((name, i) => ({ name, limb: this.actLimb[i], range: [m.actuator_ctrlrange[2 * i], m.actuator_ctrlrange[2 * i + 1]] }));
    return { robotName: 'Unitree G1', geoms, meshFiles, meshBase: '/scenes/unitree_g1/assets/', bodies, actuators, limbs: LIMBS.map(({ key, label }) => ({ key, label })), timestep: m.opt.timestep, version: this.mujoco.mj_versionString() };
  }

  poses() {
    const out = new Array(this.model.ngeom * 12);
    for (let i = 0, k = 0; i < this.model.ngeom; i++) {
      for (let j = 0; j < 3; j++) out[k++] = +this.geomXpos[3 * i + j].toFixed(4);
      for (let j = 0; j < 9; j++) out[k++] = +this.geomXmat[9 * i + j].toFixed(4);
    }
    return out;
  }

  status() {
    return {
      mode: this.mode, stuckReason: this.stuckReason, time: +this.data.time.toFixed(2),
      waypoint: ROUTINE[this.step], qpos: this.actQadr.map((a) => +this.qpos[a].toFixed(3)),
      ctrl: Array.from(this.ctrl).map((v) => +v.toFixed(3)), personNear: this.personNear,
      targetDisplaced: this.targetDisplacement() > 0.15, ncon: this.data.ncon,
      obstacleInPath: this.obstacleInPath(), sweepHigh: this.sweepHigh, dragging: this.drag ? this.drag.body : null,
      boxesProcessed: this.processed, shipped: this.shipped || 0, holding: this.held != null,
      person: { pos: [0, 1, 2].map((i) => +this.mocapPos[3 * this.personMocap + i].toFixed(3)), motion: this.personMotion() },
      actions: this.stuckReason ? ACTIONS[this.stuckReason].map((a) => ({ id: a.id, label: a.label, desc: a.desc, done: this.actionsDone.includes(a.id), available: a.needs ? a.needs(this) : true })) : [],
      actionsDone: this.actionsDone, resume: this.resumeCheck(),
    };
  }
  obstacleInPath() { const m = this.mocapPos, k = this.obstacleMocap; return Math.hypot(m[3 * k], m[3 * k + 1]) < 1.2; }
  resumeCheck() {
    switch (this.stuckReason) {
      case 'hazard': return this.personNear ? 'A person is still within 0.6 m of a hand.' : !this.actionsDone.includes('confirm_clear') ? 'Confirm the area is clear first.' : null;
      case 'obstructed': return this.obstacleInPath() ? 'The crate is still in the reach path. Get it removed.' : null;
      case 'lowconf': return this.targetDisplacement() > 0.15 ? 'The box is still off the feeder mark. Nudge it back, accept its new position, or discard it.' : null;
      default: return null;
    }
  }

  // ---------- scenario controls ----------
  reset() {
    this.mujoco.mj_resetData(this.model, this.data);
    TARGET_HOME = [0.40, 0, 0.89]; POSES.grasp.waist_yaw = POSES.approach.waist_yaw = POSES.lift.waist_yaw = 0;
    this.current = 0; this.held = null; this.processed = 0; this.shipped = 0; this.releasedAt = null;
    this.boxes.forEach((b, i) => this.placeFree(b.qadr, b.dadr, i === 0 ? TARGET_HOME : BOX_PARK[i]));
    this.setMocap(this.obstacleMocap, OBSTACLE_PARK);
    this.setPerson(PERSON_PARK);
    for (let i = 0; i < this.nu; i++) this.ctrl[i] = 0;
    this.mujoco.mj_forward(this.model, this.data);
    this.mode = 'auto'; this.stuckReason = null; this.step = 0; this.stepEnteredAt = this.data.time; this.highErrSince = null;
    this.sweepHigh = false; this.skipInspect = false; this.actionsDone = []; this.anims = []; this.drag = null; this.clearForces();
    this.emit('status');
  }
  placeFree(qadr, dadr, pos) {
    this.qpos[qadr] = pos[0]; this.qpos[qadr + 1] = pos[1]; this.qpos[qadr + 2] = pos[2];
    this.qpos[qadr + 3] = 1; this.qpos[qadr + 4] = 0; this.qpos[qadr + 5] = 0; this.qpos[qadr + 6] = 0;
    for (let i = 0; i < 6; i++) this.qvel[dadr + i] = 0;
    this.mujoco.mj_forward(this.model, this.data);
  }
  setMocap(id, pos) { for (let i = 0; i < 3; i++) this.mocapPos[3 * id + i] = pos[i]; }
  setPerson(pos) { this.setMocap(this.personMocap, pos); }
  spawnObstacle() { this.setMocap(this.obstacleMocap, OBSTACLE_SPOT); }
  clearObstacle() { this.setMocap(this.obstacleMocap, OBSTACLE_PARK); }
  personEnter() { this.setPerson(PERSON_NEAR); }
  personLeaveSlowly(delay = 0) { const m = this.mocapPos, k = this.personMocap; if (Math.hypot(m[3 * k] - PERSON_AWAY[0], m[3 * k + 1] - PERSON_AWAY[1]) < 0.1) return false; this.animateMocap(this.personMocap, PERSON_AWAY, 4.5, null, delay); return true; }
  // The person heard the robot speak: after a beat they walk out. Returns true if they were still in the cell.
  personHeard() { if (!this.actionsDone.includes('speak')) this.actionsDone.push('speak'); const left = this.personLeaveSlowly(0.8); this.emit('status'); return left; }
  personMotion() { const a = this.anims.find((x) => x.id === this.personMocap); if (!a) return null; const k = Math.min(1, (this.data.time - a.t0) / a.dur); return { walking: k < 1, heading: Math.atan2(a.to[1] - a.from[1], a.to[0] - a.from[0]) }; }
  personLeave() { this.setPerson(PERSON_PARK); }
  knockTarget() { if (this.held != null) return; const b = this.boxes[this.current]; this.placeFree(b.qadr, b.dadr, [0.55, 0.22, 0.85]); this.qvel[b.dadr] = 0.3; this.qvel[b.dadr + 1] = 1.2; }
  restoreTarget() { const b = this.boxes[this.current]; this.placeFree(b.qadr, b.dadr, TARGET_HOME); }
  // feeder: bring in the next box from the pool
  feedNext() { this.current = (this.current + 1) % this.boxes.length; const b = this.boxes[this.current]; this.placeFree(b.qadr, b.dadr, [TARGET_HOME[0], TARGET_HOME[1], TARGET_HOME[2] + 0.03]); }
  boxPos(i = this.current) { const b = this.boxes[i].body; return [this.data.xpos[3 * b], this.data.xpos[3 * b + 1], this.data.xpos[3 * b + 2]]; }
  wrist(b) { const x = this.data.xpos; return [x[3 * b], x[3 * b + 1], x[3 * b + 2]]; }
  handToBox() { const p = this.boxPos(); return Math.max(...this.handBodies.map((h) => { const w = this.wrist(h); return Math.hypot(w[0] - p[0], w[1] - p[1], w[2] - p[2]); })); }
  grab() { this.held = this.current; }
  drop() { if (this.held == null) return; this.held = null; this.releasedAt = this.data.time; }
  // outfeed conveyor: boxes resting on the belt are carried along it; past the tail they leave the frame and rejoin the pool
  conveyor() {
    this.boxes.forEach((b, i) => {
      if (i === this.held || i === this.current) return;
      const x = this.qpos[b.qadr], y = this.qpos[b.qadr + 1], z = this.qpos[b.qadr + 2];
      if (x < BELT.x[0] || x > BELT.x[1] || y > BELT.yStart || z > BELT.top + 0.12) return;
      if (y < BELT.yEnd) { this.placeFree(b.qadr, b.dadr, BOX_PARK[i]); this.shipped = (this.shipped || 0) + 1; return; }
      // belt drive: hold the box's planar velocity at belt speed (the integrator moves it), keep it from spinning
      this.qvel[b.dadr] = (0.25 - x) * 2; this.qvel[b.dadr + 1] = -BELT.speed; this.qvel[b.dadr + 3] = this.qvel[b.dadr + 4] = this.qvel[b.dadr + 5] = 0;
    });
  }
  // two-handed carry: the held box sits at the midpoint between the wrists, yawed with the hand line
  carryHeld() {
    if (this.held == null) return;
    const L = this.wrist(this.leftWrist), R = this.wrist(this.rightWrist), b = this.boxes[this.held];
    for (let i = 0; i < 3; i++) this.qpos[b.qadr + i] = (L[i] + R[i]) / 2;
    const yaw = Math.atan2(L[1] - R[1], L[0] - R[0]) - Math.PI / 2;
    this.qpos[b.qadr + 3] = Math.cos(yaw / 2); this.qpos[b.qadr + 4] = 0; this.qpos[b.qadr + 5] = 0; this.qpos[b.qadr + 6] = Math.sin(yaw / 2);
    for (let i = 0; i < 6; i++) this.qvel[b.dadr + i] = 0;
  }

  // ---------- teleop ----------
  setTeleop(targets) {
    if (this.mode !== 'teleop') return false;
    const r = this.model.actuator_ctrlrange;
    for (let i = 0; i < this.nu; i++) {
      const v = Number(targets[i]);
      if (Number.isFinite(v)) this.teleTargets[i] = Math.min(r[2 * i + 1], Math.max(r[2 * i], v));
    }
    return true;
  }
  beginTeleop() {
    if (this.mode !== 'stuck') return false;
    this.mode = 'teleop';
    for (let i = 0; i < this.nu; i++) this.teleTargets[i] = this.ctrl[i];
    this.emit('status');
    return true;
  }
  // Drag-to-pose: the grabbed body is pulled toward `target` (MuJoCo world coords) by a spring while the actuators
  // of that limb are relaxed; on release the limb's targets freeze at the reached pose.
  setDrag(bodyId, target) {
    if (this.mode !== 'teleop') return false;
    if (bodyId == null || !Number.isInteger(bodyId) || bodyId <= 0 || bodyId >= this.model.nbody) { this.releaseDrag(); return true; }
    const limb = this.bodyLimb.get(bodyId);
    if (!limb) return false;
    if (!this.drag || this.drag.body !== bodyId) { this.releaseDrag(); this.drag = { body: bodyId, limb, target: target.map(Number) }; }
    else this.drag.target = target.map(Number);
    return true;
  }
  releaseDrag() {
    if (!this.drag) return;
    for (let i = 0; i < this.nu; i++) if (this.actLimb[i] === this.drag.limb) this.teleTargets[i] = this.qpos[this.actQadr[i]];
    this.drag = null; this.clearForces();
  }
  clearForces() { for (let i = 0; i < this.xfrc.length; i++) this.xfrc[i] = 0; }

  humanAction(id) {
    if (this.mode !== 'teleop') return 'robot is not under human control';
    const def = (ACTIONS[this.stuckReason] || []).find((a) => a.id === id);
    if (!def) return `action ${id} is not offered for this job`;
    if (def.needs && !def.needs(this)) return 'that action is not available yet';
    switch (id) {
      case 'retract': this.releaseDrag(); this.teleTargets.set(this.poseVec('open_high')); this.macro = { pose: this.stuckReason === 'hazard' ? 'safe' : 'open_high', at: this.data.time + 1.2 }; break;
      case 'step_back': this.personLeaveSlowly(); break;
      case 'speak': break; // marked done by the server when speech actually reaches the robot
      case 'confirm_clear': break;
      case 'manual_clear': break;
      case 'request_removal': this.animateMocap(this.obstacleMocap, OBSTACLE_PARK, 3.0, [OBSTACLE_SPOT[0], OBSTACLE_SPOT[1], 1.7]); break; // crane it straight up, then away
      case 'rescan': {
        // approach pose puts the wrist at bearing -0.48 rad with waist_yaw 0.2; re-aim the waist at the box's bearing
        const p = this.boxPos(); TARGET_HOME = [p[0], p[1], p[2]];
        const yaw = Math.atan2(p[1], p[0]);   // both hands close at bearing 0 with the waist straight
        POSES.approach.waist_yaw = POSES.grasp.waist_yaw = POSES.lift.waist_yaw = Math.max(-1.2, Math.min(1.2, yaw));
        break;
      }
      case 'manual_nudge': break;
      case 'skip_part': this.feedNext(); break;
    }
    if (!this.actionsDone.includes(id)) this.actionsDone.push(id);
    this.emit('status');
    return null;
  }
  animateMocap(id, to, dur, via = null, delay = 0) {
    const from = [0, 1, 2].map((i) => this.mocapPos[3 * id + i]);
    this.anims = this.anims.filter((a) => a.id !== id).concat({ id, from, to, via, t0: this.data.time + delay, dur });
  }
  endTeleop() {
    const blocker = this.resumeCheck();
    if (blocker) return blocker;
    this.releaseDrag();
    this.mode = 'auto'; this.stuckReason = null; this.highErrSince = null; this.actionsDone = [];
    this.step = this.held != null ? 4 : 0; this.stepEnteredAt = this.data.time;   // holding a box: continue from lift; else recover first
    this.emit('status');
    return null;
  }
  releaseToPool() { if (this.mode === 'teleop') { this.releaseDrag(); this.mode = 'stuck'; this.emit('status'); } }

  // ---------- agent ----------
  targetDisplacement() { const p = this.data.xpos, b = this.targetBody; return Math.hypot(p[3 * b] - TARGET_HOME[0], p[3 * b + 1] - TARGET_HOME[1]); }
  handToPerson() {
    const x = this.data.xpos, m = this.mocapPos, k = this.personMocap;
    let best = Infinity;
    for (const b of this.handBodies) best = Math.min(best, Math.hypot(x[3 * b] - m[3 * k], x[3 * b + 1] - m[3 * k + 1], x[3 * b + 2] - m[3 * k + 2]));
    return best;
  }
  becomeStuck(reason) {
    if (this.mode !== 'auto') return;
    this.mode = 'stuck'; this.stuckReason = reason;
    for (let i = 0; i < this.nu; i++) this.ctrl[i] = this.qpos[this.actQadr[i]]; // hold position
    this.emit('status');
    this.emit('stuck', { reason, ...STUCK[reason] });
  }
  agentTick() {
    const t = this.data.time;
    this.personNear = this.handToPerson() < HAZARD_RADIUS;
    if (this.mode !== 'auto') return;
    if (this.personNear) return this.becomeStuck('hazard');

    let name = ROUTINE[this.step];
    const target = this.poseVec(name);
    for (let i = 0; i < this.nu; i++) this.ctrl[i] = target[i];
    let err = 0;
    for (let i = 0; i < this.nu; i++) err = Math.max(err, Math.abs(this.qpos[this.actQadr[i]] - target[i]));

    // before committing to a grasp the box must be on the feeder mark
    if ((ROUTINE[this.step] === 'approach' || ROUTINE[this.step] === 'descend') && this.held == null && this.targetDisplacement() > 0.15) return this.becomeStuck('lowconf');
    if (err > 0.25) { this.highErrSince ??= t; if (t - this.highErrSince > 3.0) return this.becomeStuck('obstructed'); }
    else this.highErrSince = null;

    const dwell = DWELL[ROUTINE[this.step]] ?? 0.6;
    if (err < 0.12 && t - this.stepEnteredAt > dwell) {
      const done = ROUTINE[this.step];
      if (done === 'grasp') { if (this.handToBox() < GRASP_RADIUS) this.grab(); else return this.becomeStuck('lowconf'); }
      if (done === 'release') { this.drop(); this.processed++; this.feedNext(); this.emit('status'); }
      this.step = (this.step + 1) % ROUTINE.length; if (this.step === 0) this.step = 1; // 'recover' only runs when (re)starting
      this.stepEnteredAt = t; this.emit('status');
    }
  }

  // ---------- stepping ----------
  advance(seconds) {
    const dt = this.model.opt.timestep;
    let n = Math.min(Math.round(seconds / dt), 100);
    if (this.mode === 'teleop') {
      if (this.macro && this.data.time >= this.macro.at) { this.teleTargets.set(this.poseVec(this.macro.pose)); this.macro = null; }
      for (let i = 0; i < this.nu; i++) this.ctrl[i] = this.drag && this.actLimb[i] === this.drag.limb ? this.qpos[this.actQadr[i]] : this.teleTargets[i];
      if (this.drag) {
        const b = this.drag.body, x = this.data.xpos, v = this.data.cvel;
        for (let i = 0; i < 3; i++) {
          const f = 250 * (this.drag.target[i] - x[3 * b + i]) - 12 * (v ? v[6 * b + 3 + i] : 0);
          this.xfrc[6 * b + i] = Math.max(-120, Math.min(120, f));
        }
      }
    }
    while (n-- > 0) { this.mujoco.mj_step(this.model, this.data); this.carryHeld(); this.conveyor(); }
    for (const a of this.anims) {
      if (this.data.time < a.t0) continue;
      const k = Math.min(1, (this.data.time - a.t0) / a.dur);
      let p0 = a.from, p1 = a.to, u = k;
      if (a.via) { if (k < 0.4) { p1 = a.via; u = k / 0.4; } else { p0 = a.via; u = (k - 0.4) / 0.6; } }
      const e = u * u * (3 - 2 * u);
      for (let i = 0; i < 3; i++) this.mocapPos[3 * a.id + i] = p0[i] + (p1[i] - p0[i]) * e;
    }
    this.anims = this.anims.filter((a) => this.data.time - a.t0 < a.dur);
    this.personNear = this.handToPerson() < HAZARD_RADIUS;
    this.agentTick();
  }
}

export { STUCK, ACTIONS, POSES, LIMBS, ROUTINE };
