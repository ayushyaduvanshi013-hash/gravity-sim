/* Newtonian N-body physics for P's gravity simulation.
 *
 * Units: astronomical units (AU), days, solar masses. With these, G = k^2 where k is the Gaussian
 * gravitational constant, so real orbital speeds and periods come out right (Earth: 1 AU, 365.25 days).
 *
 * Integration: kick-drift-kick leapfrog (velocity Verlet), which keeps orbits stable for thousands of
 * years instead of spiralling in or out like plain Euler. The step size adapts to the closest and fastest
 * pair of bodies, so close fly-bys and crashes stay accurate. Bodies that touch merge (mass and momentum
 * are conserved). A body being dragged with the mouse is "kinematic": its position is set from outside,
 * and everything else still feels its pull.
 *
 * No browser APIs here, so the same file runs in the page and in the self-test.
 */
(function (global) {
  "use strict";

  const G = 2.959122082855911e-4;          // AU^3 / (Msun * day^2)
  const AU_KM = 149597870.7;
  const KMS_PER_AU_DAY = AU_KM / 86400;    // 1 AU/day = 1731.5 km/s
  const M_EARTH = 3.003489e-6;             // Earth's mass in solar masses
  const ETA = 0.02;                        // step = ETA x shortest orbital timescale (~314 steps per orbit)
  const DT_MAX = 0.5;                      // days
  const DT_MIN = 1e-7;

  function vec(x, y, z) { return [x || 0, y || 0, z || 0]; }

  /* ---------------------------------------------------------------- presets */

  // Start a body at the closest point of its orbit around `parent`, at angle `angleDeg` in the ecliptic,
  // with the orbit tilted by `incDeg` (velocity rotated about the radius vector).
  function onOrbit(parent, a, e, incDeg, angleDeg, mBody) {
    const mu = G * (parent.m + mBody);
    const rp = a * (1 - e);
    const vp = Math.sqrt(mu * (1 + e) / rp);
    const th = angleDeg * Math.PI / 180, inc = incDeg * Math.PI / 180;
    const ux = Math.cos(th), uy = Math.sin(th);
    return {
      x: [parent.x[0] + rp * ux, parent.x[1] + rp * uy, parent.x[2]],
      v: [parent.v[0] - vp * uy * Math.cos(inc), parent.v[1] + vp * ux * Math.cos(inc), parent.v[2] + vp * Math.sin(inc)],
    };
  }

  // How a body is named in a sentence: "the Sun", "the Moon", but "Earth", "Mars".
  const CALLED = { Sun: "the Sun", Moon: "the Moon" };
  function called(b) { return CALLED[b.name] || b.name; }

  function body(spec) {
    return Object.assign({
      x: vec(), v: vec(), a: vec(), R: 1e-5, vr: 0.03, color: "#ffffff", star: false,
      parent: null, alive: true, kinematic: false,
    }, spec);
  }

  function planet(list, parentName, name, m, a, e, inc, angle, look) {
    const parent = list.find(b => b.name === parentName);
    const s = onOrbit(parent, a, e, inc, angle, m);
    list.push(body(Object.assign({ name, m, x: s.x, v: s.v }, look)));
  }

  const PRESETS = {
    solar: {
      title: "Sun, Earth, Moon & Mars",
      view: 2.0,
      build() {
        const L = [body({ name: "Sun", m: 1, R: 0.00465, vr: 0.085, color: "#ffd25a", star: true })];
        planet(L, "Sun", "Earth", M_EARTH, 1.0, 0.0167, 0, 0, { R: 4.26e-5, vr: 0.032, color: "#4f9dff" });
        planet(L, "Earth", "Moon", 3.694e-8, 0.00257, 0.0549, 5.145, 0,
               { R: 1.16e-5, vr: 0.012, color: "#c9ccd3", parent: "Earth" });
        planet(L, "Sun", "Mars", 3.227e-7, 1.5237, 0.0934, 1.85, 140, { R: 2.27e-5, vr: 0.026, color: "#ff6a3d" });
        return L;
      },
    },
    inner: {
      title: "Inner planets + Jupiter",
      view: 6.0,
      build() {
        const L = [body({ name: "Sun", m: 1, R: 0.00465, vr: 0.16, color: "#ffd25a", star: true })];
        planet(L, "Sun", "Mercury", 1.66e-7, 0.387, 0.2056, 7.0, 60, { R: 1.63e-5, vr: 0.035, color: "#b9b2a8" });
        planet(L, "Sun", "Venus", 2.448e-6, 0.723, 0.0068, 3.39, 200, { R: 4.05e-5, vr: 0.05, color: "#e8c27a" });
        planet(L, "Sun", "Earth", M_EARTH, 1.0, 0.0167, 0, 0, { R: 4.26e-5, vr: 0.055, color: "#4f9dff" });
        planet(L, "Earth", "Moon", 3.694e-8, 0.00257, 0.0549, 5.145, 0,
               { R: 1.16e-5, vr: 0.02, color: "#c9ccd3", parent: "Earth" });
        planet(L, "Sun", "Mars", 3.227e-7, 1.5237, 0.0934, 1.85, 140, { R: 2.27e-5, vr: 0.045, color: "#ff6a3d" });
        planet(L, "Sun", "Jupiter", 9.546e-4, 5.2028, 0.0484, 1.3, 300, { R: 4.78e-4, vr: 0.13, color: "#d9a066" });
        return L;
      },
    },
    binary: {
      title: "Binary star with two planets",
      view: 3.0,
      build() {
        const mA = 1.0, mB = 0.5, sep = 0.6;
        const vRel = Math.sqrt(G * (mA + mB) / sep);
        const L = [
          body({ name: "Star A", m: mA, R: 0.00465, vr: 0.09, color: "#ffd25a", star: true,
                 x: [-sep * mB / (mA + mB), 0, 0], v: [0, -vRel * mB / (mA + mB), 0] }),
          body({ name: "Star B", m: mB, R: 0.003, vr: 0.07, color: "#ff8a5c", star: true,
                 x: [sep * mA / (mA + mB), 0, 0], v: [0, vRel * mA / (mA + mB), 0] }),
        ];
        // Orbits around the pair's centre of mass (a fake body at the barycentre with the total mass).
        const centre = { m: mA + mB, x: [0, 0, 0], v: [0, 0, 0] };
        for (const [name, a, angle, color] of [["Outer world", 2.3, 30, "#5fd3a8"], ["Inner world", 1.05, 200, "#8ab4ff"]]) {
          const s = onOrbit(centre, a, 0.0, 2, angle, M_EARTH);
          L.push(body({ name, m: M_EARTH, R: 4.26e-5, vr: 0.035, color, x: s.x, v: s.v }));
        }
        return L;
      },
    },
    figure8: {
      title: "Three stars: the figure-eight orbit",
      view: 1.5,
      build() {
        // Chenciner & Montgomery (2000), in units G = m = 1, scaled to 1 Msun stars and 1 AU.
        const vu = Math.sqrt(G);            // velocity unit = 1 AU / sqrt(AU^3 / (G Msun))
        const p = [0.97000436, -0.24308753], v3 = [-0.93240737, -0.86473146];
        return [
          body({ name: "Star 1", m: 1, R: 0.00465, vr: 0.07, color: "#ffd25a", star: true,
                 x: [p[0], p[1], 0], v: [-v3[0] / 2 * vu, -v3[1] / 2 * vu, 0] }),
          body({ name: "Star 2", m: 1, R: 0.00465, vr: 0.07, color: "#7fd8ff", star: true,
                 x: [-p[0], -p[1], 0], v: [-v3[0] / 2 * vu, -v3[1] / 2 * vu, 0] }),
          body({ name: "Star 3", m: 1, R: 0.00465, vr: 0.07, color: "#ff7ab6", star: true,
                 x: [0, 0, 0], v: [v3[0] * vu, v3[1] * vu, 0] }),
        ];
      },
    },
  };

  /* ---------------------------------------------------------------- the system */

  class System {
    constructor() {
      this.bodies = [];
      this.t = 0;              // days
      this.events = [];        // messages for the screen ("Earth crashed into the Sun")
      this.substepBudget = 20000;
    }

    load(presetName) {
      const preset = PRESETS[presetName] || PRESETS.solar;
      this.preset = PRESETS[presetName] ? presetName : "solar";
      this.bodies = preset.build();
      this.t = 0;
      this.events = [];
      this.recentre();
      this.computeAccelerations();
      return this;
    }

    alive() { return this.bodies.filter(b => b.alive); }
    find(name) { return this.bodies.find(b => b.alive && b.name === name) || null; }

    // Move to the centre-of-mass frame so the whole system does not drift off the screen.
    recentre() {
      const L = this.alive();
      let M = 0; const P = vec(), X = vec();
      for (const b of L) for (let k = 0; k < 3; k++) { P[k] += b.m * b.v[k]; X[k] += b.m * b.x[k]; }
      for (const b of L) M += b.m;
      for (const b of L) for (let k = 0; k < 3; k++) { b.v[k] -= P[k] / M; b.x[k] -= X[k] / M; }
    }

    computeAccelerations() {
      const L = this.alive();
      for (const b of L) { b.a[0] = 0; b.a[1] = 0; b.a[2] = 0; }
      for (let i = 0; i < L.length; i++) {
        const bi = L[i];
        for (let j = i + 1; j < L.length; j++) {
          const bj = L[j];
          const dx = bj.x[0] - bi.x[0], dy = bj.x[1] - bi.x[1], dz = bj.x[2] - bi.x[2];
          const r2 = dx * dx + dy * dy + dz * dz;
          const inv = 1 / (r2 * Math.sqrt(r2));
          const si = G * bj.m * inv, sj = G * bi.m * inv;
          bi.a[0] += dx * si; bi.a[1] += dy * si; bi.a[2] += dz * si;
          bj.a[0] -= dx * sj; bj.a[1] -= dy * sj; bj.a[2] -= dz * sj;
        }
      }
    }

    // Step size: a small fraction of the shortest orbital / fly-by timescale of any pair.
    timestep() {
      const L = this.alive();
      let tau = Infinity;
      for (let i = 0; i < L.length; i++) {
        for (let j = i + 1; j < L.length; j++) {
          const a = L[i], b = L[j];
          const dx = b.x[0] - a.x[0], dy = b.x[1] - a.x[1], dz = b.x[2] - a.x[2];
          const dvx = b.v[0] - a.v[0], dvy = b.v[1] - a.v[1], dvz = b.v[2] - a.v[2];
          const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const v = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
          tau = Math.min(tau, Math.sqrt(r * r * r / (G * (a.m + b.m))));
          if (v > 0) tau = Math.min(tau, r / v);
        }
      }
      return Math.min(DT_MAX, Math.max(DT_MIN, ETA * tau));
    }

    step(dt) {
      const L = this.alive();
      for (const b of L) {
        if (b.kinematic) continue;
        b.v[0] += 0.5 * dt * b.a[0]; b.v[1] += 0.5 * dt * b.a[1]; b.v[2] += 0.5 * dt * b.a[2];
        b.x[0] += dt * b.v[0]; b.x[1] += dt * b.v[1]; b.x[2] += dt * b.v[2];
      }
      this.computeAccelerations();
      for (const b of L) {
        if (b.kinematic) continue;
        b.v[0] += 0.5 * dt * b.a[0]; b.v[1] += 0.5 * dt * b.a[1]; b.v[2] += 0.5 * dt * b.a[2];
      }
      this.t += dt;
      this.collide();
    }

    // Advance by `days`, in as many adaptive steps as needed (at most `substepBudget`).
    // Returns the days actually simulated (less than asked only during an extreme close encounter).
    advance(days) {
      let done = 0, steps = 0;
      this.computeAccelerations();   // positions may have been changed by dragging
      while (done < days && steps < this.substepBudget) {
        const dt = Math.min(this.timestep(), days - done);
        this.step(dt);
        done += dt;
        steps++;
      }
      this.lastSteps = steps;
      return done;
    }

    // Bodies that touch merge: the heavier one survives with the combined mass and momentum.
    collide() {
      const L = this.alive();
      for (let i = 0; i < L.length; i++) {
        for (let j = i + 1; j < L.length; j++) {
          const a = L[i], b = L[j];
          if (!a.alive || !b.alive) continue;
          const dx = b.x[0] - a.x[0], dy = b.x[1] - a.x[1], dz = b.x[2] - a.x[2];
          if (dx * dx + dy * dy + dz * dz > (a.R + b.R) * (a.R + b.R)) continue;
          const [big, small] = a.m >= b.m ? [a, b] : [b, a];
          const M = big.m + small.m;
          if (!big.kinematic) {         // a dragged survivor stays where the mouse holds it
            for (let k = 0; k < 3; k++) {
              big.v[k] = (big.m * big.v[k] + small.m * small.v[k]) / M;
              big.x[k] = (big.m * big.x[k] + small.m * small.x[k]) / M;
            }
          }
          big.m = M;
          big.R = Math.cbrt(big.R ** 3 + small.R ** 3);
          small.alive = false;
          for (const c of this.bodies) if (c.parent === small.name) c.parent = null;
          this.events.push(`${called(small)} crashed into ${called(big)}`);
          this.computeAccelerations();
        }
      }
    }

    energy() {
      const L = this.alive();
      let E = 0;
      for (let i = 0; i < L.length; i++) {
        const a = L[i];
        E += 0.5 * a.m * (a.v[0] ** 2 + a.v[1] ** 2 + a.v[2] ** 2);
        for (let j = i + 1; j < L.length; j++) {
          const b = L[j];
          E -= G * a.m * b.m / Math.hypot(b.x[0] - a.x[0], b.x[1] - a.x[1], b.x[2] - a.x[2]);
        }
      }
      return E;
    }

    momentum() {
      const P = vec();
      for (const b of this.alive()) for (let k = 0; k < 3; k++) P[k] += b.m * b.v[k];
      return P;
    }

    totalMass() { return this.alive().reduce((s, b) => s + b.m, 0); }

    // What `b` is orbiting: the closest heavier body it is gravitationally bound to (or null).
    primaryOf(b) {
      let best = null, bestR = Infinity;
      for (const p of this.alive()) {
        if (p === b || p.m <= b.m) continue;
        const r = Math.hypot(b.x[0] - p.x[0], b.x[1] - p.x[1], b.x[2] - p.x[2]);
        const v2 = (b.v[0] - p.v[0]) ** 2 + (b.v[1] - p.v[1]) ** 2 + (b.v[2] - p.v[2]) ** 2;
        if (0.5 * v2 - G * (p.m + b.m) / r < 0 && r < bestR) { best = p; bestR = r; }
      }
      return best;
    }

    // The body pulling hardest on `b` (for "give it a circular orbit" on release).
    strongestPull(b) {
      let best = null, bestF = 0;
      for (const p of this.alive()) {
        if (p === b) continue;
        const r2 = (b.x[0] - p.x[0]) ** 2 + (b.x[1] - p.x[1]) ** 2 + (b.x[2] - p.x[2]) ** 2;
        if (p.m / r2 > bestF) { best = p; bestF = p.m / r2; }
      }
      return best;
    }

    // Velocity for a circular orbit around `p` from b's current position, in the plane closest to the ecliptic.
    circularVelocity(b, p) {
      const d = [b.x[0] - p.x[0], b.x[1] - p.x[1], b.x[2] - p.x[2]];
      const r = Math.hypot(d[0], d[1], d[2]);
      const speed = Math.sqrt(G * (p.m + b.m) / r);
      let t = [-d[1], d[0], 0];                      // counter-clockwise seen from above
      let n = Math.hypot(t[0], t[1], t[2]);
      if (n < 1e-12) { t = [1, 0, 0]; n = 1; }
      return [p.v[0] + speed * t[0] / n, p.v[1] + speed * t[1] / n, p.v[2] + speed * t[2] / n];
    }
  }

  global.GravityPhysics = { G, AU_KM, KMS_PER_AU_DAY, M_EARTH, PRESETS, System, called };
})(typeof window !== "undefined" ? window : globalThis);
