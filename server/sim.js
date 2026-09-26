// Authoritative MuJoCo simulation + the robot's autonomous "agent".
// Runs in Node using the official @mujoco/mujoco WASM bindings.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import loadMujoco from '@mujoco/mujoco';
import { EventEmitter } from 'node:events';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Joint-space waypoints for the inspection sweep. The last one hovers over the target block.
const WAYPOINTS = [
  { name: 'home',        q: [0.0, -0.3, 2.0] },   // folded up near the base
  { name: 'sweep-left',  q: [1.2,  0.55, 2.0] },  // hand ~0.47 m out, 0.26 m above the floor
  { name: 'sweep-right', q: [-1.2, 0.55, 2.0] },
  { name: 'inspect',     q: [0.39, 0.75, 1.45] },  // hovers just above the target block
];
const SAFE_POSE = [0.0, -0.6, 1.8];        // folded up and back, hand ~0.75 m high near the base
const HIGH_SWEEP = { left: [1.2, 0.1, 1.6], right: [-1.2, 0.1, 1.6] }; // hand ~0.6 m high: clears a crate in the path
const PERSON_AWAY = [1.6, 1.4, 0.9];
let TARGET_HOME = [0.6, 0.25, 0.07];

// What a verified human can do for each stuck reason. Sliders are only a manual override.
const ACTIONS = {
  hazard: [
    { id: 'retract',   label: 'Retract to safe pose',         desc: 'Fold the arm up and back, away from the person.' },
    { id: 'step_back', label: 'Ask the person to step back',  desc: 'Speaker + light: the person leaves the cell.' },
    { id: 'confirm_clear', label: 'Confirm area clear',       desc: 'You checked the camera: nobody within 0.6 m. Enables resume.', needs: (sim) => !sim.personNear },
  ],
  obstructed: [
    { id: 'retract',   label: 'Back off',                     desc: 'Lift the arm out of contact with the obstacle.' },
    { id: 'sweep_high', label: 'Plan detour over it',         desc: 'Switch the sweep to a high path that clears the crate.' },
    { id: 'request_removal', label: 'Request removal',        desc: 'Ticket to the floor crew: crate is carried away.' },
  ],
  lowconf: [
    { id: 'rescan',    label: 'Accept new part position',     desc: 'You confirmed the part is intact: agent re-plans around where it is now.' },
    { id: 'manual_nudge', label: 'Nudge it back yourself',    desc: 'Use manual override to push the part into the green zone.' },
    { id: 'skip_part', label: 'Skip this part',               desc: 'Part is damaged or missing: drop the inspection step.' },
  ],
};
const OBSTACLE_PARK = [3, 3, 0.15];
const PERSON_PARK = [3, -3, 0.9];
const PERSON_NEAR = [0.3, 0.62, 0.9];

const STUCK = {
  obstructed: {
    title: 'Arm blocked mid-sweep',
    detail: 'Joint tracking error stayed high for 3 s. Something heavy is in the sweep path. Move the arm around it and confirm the path is clear.',
    urgency: 'medium', reward: 0.075,
  },
  hazard: {
    title: 'Person inside the robot cell',
    detail: 'A person is within 0.6 m of the end effector. The arm is holding position. Move the arm to a safe pose away from the person, then release.',
    urgency: 'high', reward: 0.1,
  },
  lowconf: {
    title: 'Cannot localize target part',
    detail: 'The part is not where the plan expects it (pose deviates > 15 cm). Nudge it back into the green drop zone, or park the arm and confirm.',
    urgency: 'low', reward: 0.05,
  },
};

export class Sim extends EventEmitter {
  static async create() {
    const mujoco = await loadMujoco();
    const xml = fs.readFileSync(path.join(__dirname, 'robot.xml'), 'utf8');
    const model = mujoco.MjModel.from_xml_string(xml);
    const data = new mujoco.MjData(model);
    return new Sim(mujoco, model, data);
  }

  constructor(mujoco, model, data) {
    super();
    this.mujoco = mujoco; this.model = model; this.data = data;
    this.nu = model.nu;
    this.ctrl = data.ctrl; this.qpos = data.qpos; this.qvel = data.qvel;
    this.geomXpos = data.geom_xpos; this.geomXmat = data.geom_xmat;
    this.mocapPos = data.mocap_pos;
    this.targetQadr = model.jnt_qposadr[model.jnt('target_free').id];
    this.targetDadr = model.jnt_dofadr[model.jnt('target_free').id];
    this.obstacleMocap = model.body_mocapid[model.body('obstacle').id];
    this.personMocap = model.body_mocapid[model.body('person').id];
    this.tipSite = model.site('tip').id;
    this.targetBody = model.body('target').id;

    this.mode = 'auto';          // auto | stuck | teleop
    this.stuckReason = null;
    this.wp = 0; this.wpEnteredAt = 0; this.highErrSince = null;
    this.teleTargets = new Float64Array(this.nu);
    this.personNear = false;
    this.sweepHigh = false; this.skipInspect = false; this.actionsDone = []; this.anims = [];
    this.reset();
  }

  // ---------- geometry description for clients ----------
  describe() {
    const m = this.model, g = [];
    for (let i = 0; i < m.ngeom; i++) {
      g.push({
        name: m.geom(i).name, type: m.geom_type[i],
        size: Array.from(m.geom_size.subarray(3 * i, 3 * i + 3)),
        rgba: Array.from(m.geom_rgba.subarray(4 * i, 4 * i + 4)),
      });
    }
    const actuators = [];
    for (let i = 0; i < this.nu; i++) {
      actuators.push({ name: m.actuator(i).name, range: [m.actuator_ctrlrange[2 * i], m.actuator_ctrlrange[2 * i + 1]] });
    }
    return { geoms: g, actuators, timestep: m.opt.timestep, version: this.mujoco.mj_versionString() };
  }

  poses() {
    // [x y z r00..r22] per geom, rounded to keep frames small
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
      waypoint: WAYPOINTS[this.wp].name, qpos: Array.from(this.qpos.subarray(0, this.nu)).map(v => +v.toFixed(3)),
      ctrl: Array.from(this.ctrl).map(v => +v.toFixed(3)), personNear: this.personNear,
      targetDisplaced: this.targetDisplacement() > 0.15, ncon: this.data.ncon,
      obstacleInPath: this.obstacleInPath(), sweepHigh: this.sweepHigh,
      actions: this.stuckReason ? ACTIONS[this.stuckReason].map((a) => ({ id: a.id, label: a.label, desc: a.desc, done: this.actionsDone.includes(a.id), available: a.needs ? a.needs(this) : true })) : [],
      actionsDone: this.actionsDone, resume: this.resumeCheck(),
    };
  }
  obstacleInPath() { const m = this.mocapPos, k = this.obstacleMocap; return Math.hypot(m[3 * k], m[3 * k + 1]) < 1.2; }
  // Why the robot may not resume yet. null => ready.
  resumeCheck() {
    switch (this.stuckReason) {
      case 'hazard': return this.personNear ? 'A person is still within 0.6 m of the arm.' : !this.actionsDone.includes('confirm_clear') ? 'Confirm the area is clear first.' : null;
      case 'obstructed': return this.obstacleInPath() && !this.sweepHigh ? 'The crate is still in the sweep path. Detour or get it removed.' : null;
      case 'lowconf': return this.targetDisplacement() > 0.15 && !this.skipInspect ? 'The part is still out of place. Nudge it back, accept its new position, or skip it.' : null;
      default: return null;
    }
  }

  // ---------- scenario controls (the "world" acting on the robot) ----------
  reset() {
    this.mujoco.mj_resetData(this.model, this.data);
    this.placeFree(this.targetQadr, this.targetDadr, TARGET_HOME);
    this.setMocap(this.obstacleMocap, OBSTACLE_PARK);
    this.setPerson(PERSON_PARK);
    this.mujoco.mj_forward(this.model, this.data);
    this.mode = 'auto'; this.stuckReason = null; this.wp = 0; this.wpEnteredAt = this.data.time; this.highErrSince = null;
    this.sweepHigh = false; this.skipInspect = false; this.actionsDone = []; this.anims = []; TARGET_HOME = [0.6, 0.25, 0.07];
    this.emit('status');
  }
  placeFree(qadr, dadr, pos) {
    this.qpos[qadr] = pos[0]; this.qpos[qadr + 1] = pos[1]; this.qpos[qadr + 2] = pos[2];
    this.qpos[qadr + 3] = 1; this.qpos[qadr + 4] = 0; this.qpos[qadr + 5] = 0; this.qpos[qadr + 6] = 0;
    for (let i = 0; i < 6; i++) this.qvel[dadr + i] = 0;
  }
  setMocap(id, pos) { for (let i = 0; i < 3; i++) this.mocapPos[3 * id + i] = pos[i]; }
  setPerson(pos) { this.setMocap(this.personMocap, pos); }

  spawnObstacle() { this.setMocap(this.obstacleMocap, [0.45, 0.05, 0.16]); }
  clearObstacle() { this.setMocap(this.obstacleMocap, OBSTACLE_PARK); }
  personEnter() { this.setPerson(PERSON_NEAR); }
  personLeave() { this.setPerson(PERSON_PARK); }
  knockTarget() {
    // shove the block sideways so the plan's expected pose is wrong
    this.placeFree(this.targetQadr, this.targetDadr, [0.35, 0.55, 0.3]);
    this.qvel[this.targetDadr] = -1.5; this.qvel[this.targetDadr + 1] = 1.0;
  }
  restoreTarget() { this.placeFree(this.targetQadr, this.targetDadr, TARGET_HOME); }

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
  // A verified human performs one of the job's actions. Returns an error string or null.
  humanAction(id) {
    if (this.mode !== 'teleop') return 'robot is not under human control';
    const def = (ACTIONS[this.stuckReason] || []).find((a) => a.id === id);
    if (!def) return `action ${id} is not offered for this job`;
    if (def.needs && !def.needs(this)) return 'that action is not available yet';
    const t = this.data.time;
    switch (id) {
      case 'retract': for (let i = 0; i < this.nu; i++) this.teleTargets[i] = SAFE_POSE[i]; break;
      case 'step_back': this.animateMocap(this.personMocap, PERSON_AWAY, 4.0); break;
      case 'confirm_clear': break;
      case 'sweep_high': this.sweepHigh = true; break;
      case 'request_removal': this.animateMocap(this.obstacleMocap, OBSTACLE_PARK, 3.0); break;
      case 'rescan': { const p = this.data.xpos, b = this.targetBody; TARGET_HOME = [p[3 * b], p[3 * b + 1], 0.07]; WAYPOINTS[3].q[0] = Math.atan2(TARGET_HOME[1], TARGET_HOME[0]); break; }
      case 'manual_nudge': break; // just a hint: the sliders are the tool
      case 'skip_part': this.skipInspect = true; break;
    }
    if (!this.actionsDone.includes(id)) this.actionsDone.push(id);
    this.emit('status');
    return null;
  }
  animateMocap(id, to, dur) {
    const from = [0, 1, 2].map((i) => this.mocapPos[3 * id + i]);
    this.anims = this.anims.filter((a) => a.id !== id).concat({ id, from, to, t0: this.data.time, dur });
  }
  endTeleop() {
    // Human says the situation is handled. Only allowed once the job's resume condition holds.
    const blocker = this.resumeCheck();
    if (blocker) return blocker;
    this.mode = 'auto'; this.stuckReason = null; this.highErrSince = null; this.actionsDone = [];
    this.wp = 0; this.wpEnteredAt = this.data.time;
    this.emit('status');
    return null;
  }
  releaseToPool() {
    // claim expired/cancelled: robot stays paused, waits for the next human
    if (this.mode === 'teleop') { this.mode = 'stuck'; this.emit('status'); }
  }

  // ---------- agent ----------
  targetDisplacement() {
    const p = this.data.xpos, b = this.targetBody;
    return Math.hypot(p[3 * b] - TARGET_HOME[0], p[3 * b + 1] - TARGET_HOME[1]);
  }
  tipToPerson() {
    const s = this.data.site_xpos, t = this.tipSite, m = this.mocapPos, k = this.personMocap;
    return Math.hypot(s[3 * t] - m[3 * k], s[3 * t + 1] - m[3 * k + 1], s[3 * t + 2] - m[3 * k + 2]);
  }
  becomeStuck(reason) {
    if (this.mode !== 'auto') return;
    this.mode = 'stuck'; this.stuckReason = reason;
    // hold position exactly where we are
    for (let i = 0; i < this.nu; i++) this.ctrl[i] = this.qpos[i];
    this.emit('status');
    this.emit('stuck', { reason, ...STUCK[reason] });
  }
  agentTick() {
    const t = this.data.time;
    // hazard check always wins, even during teleop we just report it
    this.personNear = this.tipToPerson() < 0.6;
    if (this.mode !== 'auto') return;
    if (this.personNear) return this.becomeStuck('hazard');

    let target = WAYPOINTS[this.wp].q;
    if (this.sweepHigh && WAYPOINTS[this.wp].name === 'sweep-left') target = HIGH_SWEEP.left;
    if (this.sweepHigh && WAYPOINTS[this.wp].name === 'sweep-right') target = HIGH_SWEEP.right;
    if (this.skipInspect && WAYPOINTS[this.wp].name === 'inspect') { this.wp = 0; this.wpEnteredAt = t; return; }
    for (let i = 0; i < this.nu; i++) this.ctrl[i] = target[i];
    let err = 0;
    for (let i = 0; i < this.nu; i++) err = Math.max(err, Math.abs(this.qpos[i] - target[i]));

    if (WAYPOINTS[this.wp].name === 'inspect' && this.targetDisplacement() > 0.15) return this.becomeStuck('lowconf');

    if (err > 0.25) { this.highErrSince ??= t; if (t - this.highErrSince > 3.0) return this.becomeStuck('obstructed'); }
    else this.highErrSince = null;

    if (err < 0.15 && t - this.wpEnteredAt > 1.5) { this.wp = (this.wp + 1) % WAYPOINTS.length; this.wpEnteredAt = t; this.emit('status'); }
  }

  // ---------- stepping ----------
  advance(seconds) {
    const dt = this.model.opt.timestep;
    let n = Math.min(Math.round(seconds / dt), 100);
    if (this.mode === 'teleop') for (let i = 0; i < this.nu; i++) this.ctrl[i] = this.teleTargets[i];
    while (n-- > 0) this.mujoco.mj_step(this.model, this.data);
    for (const a of this.anims) {
      const k = Math.min(1, (this.data.time - a.t0) / a.dur), e = k * k * (3 - 2 * k);
      for (let i = 0; i < 3; i++) this.mocapPos[3 * a.id + i] = a.from[i] + (a.to[i] - a.from[i]) * e;
    }
    this.anims = this.anims.filter((a) => this.data.time - a.t0 < a.dur);
    this.agentTick();
  }
}

export { STUCK, WAYPOINTS, ACTIONS };
