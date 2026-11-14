/* Drawing and mouse/keyboard handling for the assistant's gravity simulation (physics lives in physics.js). */
(function () {
  "use strict";

  const { System, PRESETS, KMS_PER_AU_DAY, M_EARTH, AU_KM, called } = window.GravityPhysics;
  const Called = b => { const c = called(b); return c[0].toUpperCase() + c.slice(1); };
  const $ = id => document.getElementById(id);
  const query = new URLSearchParams(location.search.slice(1) + "&" + location.hash.slice(1));

  const canvas = $("sky");
  const ctx = canvas.getContext("2d");
  const sys = new System();

  const state = {
    preset: PRESETS[query.get("preset")] ? query.get("preset") : "solar",
    daysPerSec: 20, paused: false, trails: true, grid: true, labels: true, moonScale: true, help: true,
    massMult: 1, follow: null,
  };
  const cam = { target: [0, 0, 0], yaw: -Math.PI / 2, pitch: 0.55, dist: 6, fov: 50 * Math.PI / 180 };
  let W = 0, H = 0, DPR = 1, focal = 1;
  let B = null;                       // camera basis for this frame
  let drag = null;                    // {body, p0, n, samples} while a body is held
  let look = null;                    // {x, y, mode} while rotating / panning
  let hover = null;
  const screenPos = new Map();        // body -> {x, y, r} from the last frame, for picking
  const primaries = new Map();        // body -> name of what it orbits, for "no longer orbiting" messages

  /* ---------------------------------------------------------------- small vector helpers */
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const len = a => Math.hypot(a[0], a[1], a[2]);
  const norm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  /* ---------------------------------------------------------------- the Moon's drawn distance */
  // Real Moon-Earth distance (0.0026 AU) is smaller than Earth's dot, so a moon is drawn K times further
  // from its planet. Beyond D0 the stretch fades out smoothly (and stays monotonic), so a moon that breaks
  // free is drawn where it really is.
  const K = 30, D0 = 0.004, C = D0 * (K - 1), FADE = 0.17;
  const stretch = d => (d <= D0 ? K * d : d + C * Math.exp(-(d - D0) / FADE));
  function unstretch(s) {
    if (s <= K * D0) return s / K;
    let lo = D0, hi = s;
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (stretch(mid) < s) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  }
  function parentOf(b) { return state.moonScale && b.parent ? sys.find(b.parent) : null; }
  function displayPos(b) {
    const p = parentOf(b);
    if (!p) return b.x.slice();
    const rel = sub(b.x, p.x), r = len(rel);
    return r > 0 ? add(displayPos(p), mul(rel, stretch(r) / r)) : displayPos(p);
  }
  function physicalFromDisplay(b, D) {
    const p = parentOf(b);
    if (!p) return D.slice();
    const rel = sub(D, displayPos(p)), s = len(rel);
    return s > 0 ? add(p.x, mul(rel, unstretch(s) / s)) : p.x.slice();
  }

  /* ---------------------------------------------------------------- camera */
  function basis() {
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch), cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    const pos = [cam.target[0] + cam.dist * cp * cy, cam.target[1] + cam.dist * cp * sy, cam.target[2] + cam.dist * sp];
    const f = [-cp * cy, -cp * sy, -sp];
    const r = norm([f[1], -f[0], 0]);
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    return { pos, f, r, u };
  }
  function project(p) {
    const d = sub(p, B.pos), z = dot(d, B.f);
    if (z < 1e-3 * cam.dist) return null;
    return { x: W / 2 + dot(d, B.r) / z * focal, y: H / 2 - dot(d, B.u) / z * focal, z };
  }
  function rayAt(sx, sy) {
    const dx = (sx - W / 2) / focal, dy = -(sy - H / 2) / focal;
    return norm(add(B.f, add(mul(B.r, dx), mul(B.u, dy))));
  }
  function hitPlane(dir, p0, n) {
    const den = dot(dir, n);
    if (Math.abs(den) < 1e-6) return null;
    const t = dot(sub(p0, B.pos), n) / den;
    return t > 0 ? add(B.pos, mul(dir, t)) : null;
  }
  function frameScene() {
    const view = PRESETS[state.preset].view;
    cam.target = [0, 0, 0];
    cam.yaw = -Math.PI / 2;
    cam.pitch = 0.55;
    cam.dist = view / Math.tan(cam.fov / 2) * 1.15;
  }

  /* ---------------------------------------------------------------- scene setup */
  const stars = [];
  (function makeStars() {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 1400; i++) {
      const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - z * z);
      const tint = rnd();
      stars.push({ d: [s * Math.cos(a), s * Math.sin(a), z], b: 0.15 + 0.85 * rnd() ** 3,
                   c: tint < 0.12 ? "180,200,255" : tint > 0.92 ? "255,220,180" : "255,255,255" });
    }
  })();

  function load(preset) {
    state.preset = PRESETS[preset] ? preset : "solar";
    sys.load(state.preset);
    for (const b of sys.bodies) b.trail = [];
    state.massMult = 1;
    $("mass").value = "1";
    $("preset").value = state.preset;
    $("scene-title").textContent = PRESETS[state.preset].title;
    $("mass-name").textContent = state.preset === "solar" || state.preset === "inner" ? "Sun mass" : "Star masses";
    state.follow = null;
    primaries.clear();
    updateMassLabel();
    frameScene();
  }

  /* ---------------------------------------------------------------- drawing */
  function hexRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgba(hex, a, f = 1) {
    const [r, g, b] = hexRgb(hex).map(c => Math.max(0, Math.min(255, Math.round(f >= 1 ? c + (255 - c) * (f - 1) : c * f))));
    return `rgba(${r},${g},${b},${a})`;
  }

  function resize() {
    DPR = window.devicePixelRatio || 1;
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    focal = (H / 2) / Math.tan(cam.fov / 2);
  }

  function drawBackground() {
    const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.75);
    g.addColorStop(0, "#030a12"); g.addColorStop(1, "#000000");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    for (const s of stars) {
      const z = dot(s.d, B.f);
      if (z <= 0.05) continue;
      const x = W / 2 + dot(s.d, B.r) / z * focal, y = H / 2 - dot(s.d, B.u) / z * focal;
      if (x < 0 || y < 0 || x > W || y > H) continue;
      ctx.fillStyle = `rgba(${s.c},${s.b})`;
      ctx.fillRect(x, y, s.b > 0.7 ? 1.6 : 1, s.b > 0.7 ? 1.6 : 1);
    }
  }

  function polyline(points, close) {
    ctx.beginPath();
    let open = false;
    for (const p of points) {
      const q = project(p);
      if (!q) { open = false; continue; }
      if (open) ctx.lineTo(q.x, q.y); else { ctx.moveTo(q.x, q.y); open = true; }
    }
    if (close && open && points.length) { const q = project(points[0]); if (q) ctx.lineTo(q.x, q.y); }
    ctx.stroke();
  }

  function drawGrid() {
    const view = PRESETS[state.preset].view;
    const step = view > 4 ? 1 : 0.5;
    ctx.lineWidth = 1;
    for (let r = step; r <= view * 1.6; r += step) {
      const pts = [];
      for (let i = 0; i < 96; i++) { const a = i / 96 * Math.PI * 2; pts.push([r * Math.cos(a), r * Math.sin(a), 0]); }
      ctx.strokeStyle = Math.abs(r - Math.round(r)) < 1e-9 ? "rgba(42,143,108,0.30)" : "rgba(42,143,108,0.14)";
      polyline(pts, true);
      if (Math.abs(r - Math.round(r)) < 1e-9) {
        const q = project([r * Math.cos(-0.35), r * Math.sin(-0.35), 0]);
        if (q) { ctx.fillStyle = "rgba(47,156,118,0.55)"; ctx.font = "10px Consolas, monospace"; ctx.fillText(`${r} AU`, q.x + 3, q.y); }
      }
    }
    ctx.strokeStyle = "rgba(42,143,108,0.10)";
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2, R = view * 1.6;
      polyline([[0, 0, 0], [R * Math.cos(a), R * Math.sin(a), 0]]);
    }
  }

  function drawTrail(b) {
    const pts = b.trail, n = pts.length;
    if (n < 2) return;
    const proj = pts.map(project);
    const groups = Math.min(24, n - 1), per = Math.ceil((n - 1) / groups);
    ctx.lineWidth = b.star ? 1.8 : 1.4;
    ctx.strokeStyle = b.color;
    for (let g = 0; g < groups; g++) {
      const s = g * per, e = Math.min(n - 1, (g + 1) * per);
      if (s >= e) break;
      ctx.globalAlpha = 0.04 + 0.7 * Math.pow((g + 1) / groups, 1.6);
      ctx.beginPath();
      let open = false;
      for (let i = s; i <= e; i++) {
        const q = proj[i];
        if (!q) { open = false; continue; }
        if (open) ctx.lineTo(q.x, q.y); else { ctx.moveTo(q.x, q.y); open = true; }
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function nearestStar(b) {
    let best = null, bestD = Infinity;
    for (const s of sys.alive()) {
      if (!s.star || s === b) continue;
      const d = len(sub(s.x, b.x));
      if (d < bestD) { best = s; bestD = d; }
    }
    return best;
  }

  function drawBody(b, D, q) {
    const r = Math.max(b.star ? 3 : 1.8, b.vr * focal / q.z);
    screenPos.set(b, { x: q.x, y: q.y, r });
    if (b.star) {
      ctx.globalCompositeOperation = "lighter";
      const glow = ctx.createRadialGradient(q.x, q.y, r * 0.4, q.x, q.y, r * 4.5);
      glow.addColorStop(0, rgba(b.color, 0.5)); glow.addColorStop(0.35, rgba(b.color, 0.14)); glow.addColorStop(1, rgba(b.color, 0));
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(q.x, q.y, r * 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.globalCompositeOperation = "source-over";
      const core = ctx.createRadialGradient(q.x - r * 0.25, q.y - r * 0.25, r * 0.05, q.x, q.y, r);
      core.addColorStop(0, "#fffdf2"); core.addColorStop(0.55, rgba(b.color, 1, 1.1)); core.addColorStop(1, rgba(b.color, 1, 0.8));
      ctx.fillStyle = core;
    } else {
      // Lit from the nearest star: bright side faces it, and a planet behind the star shows mostly its night side.
      const s = nearestStar(b);
      let lx = -0.5, ly = -0.5, lit = 0.8;
      if (s) {
        const l = norm(sub(s.x, b.x));
        lx = dot(l, B.r); ly = -dot(l, B.u);
        const lz = dot(l, B.f);
        const m = Math.hypot(lx, ly) || 1;
        lx /= m; ly /= m;
        lit = 0.3 + 0.7 * (0.5 - 0.5 * lz);
      }
      const hx = q.x + lx * r * 0.5 * lit, hy = q.y + ly * r * 0.5 * lit;
      const shade = ctx.createRadialGradient(hx, hy, r * 0.05, q.x - lx * r * 0.2, q.y - ly * r * 0.2, r * 1.15);
      shade.addColorStop(0, rgba(b.color, 1, 1 + 0.35 * lit));
      shade.addColorStop(0.5, rgba(b.color, 1, 0.55 + 0.45 * lit));
      shade.addColorStop(1, rgba(b.color, 1, 0.12));
      ctx.fillStyle = shade;
    }
    ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2); ctx.fill();
    if (b === hover || (drag && drag.body === b) || state.follow === b.name) {
      ctx.strokeStyle = state.follow === b.name ? "rgba(245,200,76,0.9)" : "rgba(90,240,184,0.8)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(q.x, q.y, r + 5, 0, Math.PI * 2); ctx.stroke();
    }
    if (state.labels) labels.push({ text: b.name, x: q.x + r + 5, y: q.y - r * 0.4 - 3 });
  }

  const labels = [];
  function drawLabels() {
    ctx.fillStyle = "rgba(90,240,184,0.85)";
    ctx.font = "11px Consolas, monospace";
    const placed = [];
    labels.sort((a, b) => a.y - b.y);
    for (const l of labels) {
      const w = ctx.measureText(l.text).width;
      let y = l.y;
      for (let tries = 0; tries < 6; tries++) {
        const clash = placed.find(p => l.x < p.x + p.w && p.x < l.x + w && Math.abs(p.y - y) < 12);
        if (!clash) break;
        y = clash.y + 12;
      }
      placed.push({ x: l.x, y, w });
      ctx.fillText(l.text, l.x, y);
    }
    labels.length = 0;
  }

  function render() {
    B = basis();
    ctx.globalAlpha = 1;
    drawBackground();
    if (state.grid) drawGrid();
    const items = [];
    for (const b of sys.alive()) {
      const D = displayPos(b), q = project(D);
      if (q) items.push({ b, D, q });
    }
    if (state.trails) for (const b of sys.alive()) drawTrail(b);
    if (state.grid) {   // drop lines show how far above or below the ecliptic each body is
      ctx.strokeStyle = "rgba(90,240,184,0.18)"; ctx.lineWidth = 1;
      for (const { D } of items) if (Math.abs(D[2]) > 1e-4) polyline([D, [D[0], D[1], 0]]);
    }
    screenPos.clear();
    items.sort((a, b) => b.q.z - a.q.z);
    for (const { b, D, q } of items) drawBody(b, D, q);
    drawLabels();
  }

  /* ---------------------------------------------------------------- the readout panels */
  function fmtDistance(au) {
    return au < 0.05 ? `${Math.round(au * AU_KM).toLocaleString("en-US")} km` : `${au.toFixed(3)} AU`;
  }
  function fmtMass(m) { return m >= 0.01 ? `${m.toFixed(2)} Msun` : `${(m / M_EARTH).toFixed(m / M_EARTH < 0.1 ? 4 : 2)} Mearth`; }

  function updatePanels() {
    const years = sys.t / 365.25;
    $("clock").textContent = `Day ${Math.floor(sys.t).toLocaleString()}  ·  ${years.toFixed(2)} years` +
      (state.paused ? "  ·  PAUSED" : "");
    const rows = [];
    for (const b of sys.alive()) {
      const p = sys.primaryOf(b);
      let where = "-", dist = "", speed = "";
      if (p) {
        where = p.name;
        dist = fmtDistance(len(sub(b.x, p.x)));
        speed = `${(len(sub(b.v, p.v)) * KMS_PER_AU_DAY).toFixed(2)} km/s`;
      } else {
        const s = nearestStar(b);
        where = b.star ? (s ? "each other" : "-") : "flying free";
        if (s) dist = fmtDistance(len(sub(b.x, s.x)));
        speed = `${(len(b.v) * KMS_PER_AU_DAY).toFixed(2)} km/s`;
      }
      rows.push(`<tr title="${fmtMass(b.m)}"><td><span class="dot" style="background:${b.color}"></span>${b.name}</td>` +
                `<td>${where}</td><td class="num">${dist}</td><td class="num">${speed}</td></tr>`);
    }
    $("body-rows").innerHTML = rows.join("");
  }

  function checkOrbits() {
    for (const b of sys.alive()) {
      if (drag && drag.body === b) continue;
      const p = sys.primaryOf(b), now = p ? called(p) : null;
      if (primaries.has(b) && primaries.get(b) !== now) {
        const before = primaries.get(b);
        if (before && now) toast(`${Called(b)} now orbits ${now} instead of ${before}`);
        else if (before) toast(`${Called(b)} broke free of ${before}`);
        else if (now) toast(`${Called(b)} was captured by ${now}`);
      }
      primaries.set(b, now);
    }
  }

  function toast(text) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = text;
    $("toasts").appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; }, 3500);
    setTimeout(() => el.remove(), 4400);
    while ($("toasts").children.length > 4) $("toasts").firstChild.remove();
  }

  /* ---------------------------------------------------------------- controls */
  const SPEED_MIN = 0.5, SPEED_MAX = 400;
  const sliderToSpeed = v => SPEED_MIN * Math.pow(SPEED_MAX / SPEED_MIN, v / 100);
  const speedToSlider = s => 100 * Math.log(s / SPEED_MIN) / Math.log(SPEED_MAX / SPEED_MIN);
  function setSpeed(s) {
    state.daysPerSec = Math.max(SPEED_MIN, Math.min(SPEED_MAX, s));
    $("speed").value = String(Math.round(speedToSlider(state.daysPerSec)));
    $("speed-label").textContent = `${state.daysPerSec < 10 ? state.daysPerSec.toFixed(1) : Math.round(state.daysPerSec)} days/s`;
  }
  function updateMassLabel() { $("mass-label").textContent = `x${state.massMult.toFixed(2)}`; }
  function setMass(mult) {
    const ratio = mult / state.massMult;
    for (const b of sys.alive()) if (b.star) b.m *= ratio;
    state.massMult = mult;
    updateMassLabel();
  }
  function setPaused(p) { state.paused = p; $("btn-pause").textContent = p ? "Play" : "Pause"; updatePanels(); }
  function clearTrails() { for (const b of sys.bodies) b.trail = []; }
  function setOption(key, value) {
    state[key] = value;
    const box = { trails: "opt-trails", grid: "opt-grid", labels: "opt-labels" }[key];
    if (box) $(box).checked = value;
    if (key === "moonScale") {
      $("opt-truemoon").checked = !value;
      for (const b of sys.bodies) if (b.parent) b.trail = [];
    }
  }

  $("preset").addEventListener("change", e => load(e.target.value));
  $("speed").addEventListener("input", e => setSpeed(sliderToSpeed(+e.target.value)));
  $("mass").addEventListener("input", e => setMass(+e.target.value));
  $("opt-trails").addEventListener("change", e => setOption("trails", e.target.checked));
  $("opt-grid").addEventListener("change", e => setOption("grid", e.target.checked));
  $("opt-labels").addEventListener("change", e => setOption("labels", e.target.checked));
  $("opt-truemoon").addEventListener("change", e => setOption("moonScale", !e.target.checked));
  $("btn-pause").addEventListener("click", () => setPaused(!state.paused));
  $("btn-reset").addEventListener("click", () => load(state.preset));
  $("btn-clear").addEventListener("click", clearTrails);
  for (const el of document.querySelectorAll("select, button, input")) el.addEventListener("keydown", e => {
    if (e.key === " " || e.key.startsWith("Arrow")) e.preventDefault();
  });

  window.addEventListener("keydown", e => {
    if (e.target.tagName === "SELECT") return;
    const k = e.key.toLowerCase();
    if (k === " ") { setPaused(!state.paused); e.preventDefault(); }
    else if (k === "arrowup" || k === "+" || k === "=") setSpeed(state.daysPerSec * 1.5);
    else if (k === "arrowdown" || k === "-") setSpeed(state.daysPerSec / 1.5);
    else if (k === "r") load(state.preset);
    else if (k === "t") setOption("trails", !state.trails);
    else if (k === "g") setOption("grid", !state.grid);
    else if (k === "n") setOption("labels", !state.labels);
    else if (k === "m") setOption("moonScale", !state.moonScale);
    else if (k === "c") clearTrails();
    else if (k === "h") { state.help = !state.help; $("help").classList.toggle("hidden", !state.help); }
    else if (k === "escape") state.follow = null;
    else if ("1234".includes(k) && k.length === 1) load(["solar", "inner", "binary", "figure8"][+k - 1]);
  });

  /* ---------------------------------------------------------------- mouse */
  function bodyAt(x, y) {
    let best = null, bestD = Infinity;
    for (const [b, s] of screenPos) {
      const d = Math.hypot(x - s.x, y - s.y);
      if (d < Math.max(s.r, 7) + 6 && d < bestD) { best = b; bestD = d; }
    }
    return best;
  }

  canvas.addEventListener("contextmenu", e => e.preventDefault());
  canvas.addEventListener("pointerdown", e => {
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events have no real pointer */ }
    const b = e.button === 0 ? bodyAt(e.clientX, e.clientY) : null;
    if (b) {
      const D = displayPos(b);
      // Move it across the ecliptic plane through its position (or across the screen when seen edge-on).
      const n = Math.abs(B.f[2]) > 0.3 ? [0, 0, 1] : B.f.slice();
      drag = { body: b, p0: D, n, samples: [{ t: performance.now(), x: b.x.slice() }] };
      b.kinematic = true;
      b.v = [0, 0, 0];
      canvas.classList.add("dragging");
      $("draghint").style.display = "block";
    } else {
      look = { x: e.clientX, y: e.clientY, mode: e.button === 2 || e.button === 1 || e.shiftKey ? "pan" : "rotate" };
      canvas.classList.add("dragging");
    }
  });

  canvas.addEventListener("pointermove", e => {
    if (drag) {
      const b = drag.body;
      if (!b.alive) { endDrag(e); return; }
      const hit = hitPlane(rayAt(e.clientX, e.clientY), drag.p0, drag.n);
      if (hit) {
        b.x = physicalFromDisplay(b, hit);
        const now = performance.now();
        drag.samples.push({ t: now, x: b.x.slice() });
        while (drag.samples.length > 2 && now - drag.samples[0].t > 120) drag.samples.shift();
        b.v = throwVelocity(now);
      }
      $("draghint").style.left = `${e.clientX + 16}px`;
      $("draghint").style.top = `${e.clientY + 14}px`;
    } else if (look) {
      const dx = e.clientX - look.x, dy = e.clientY - look.y;
      look.x = e.clientX; look.y = e.clientY;
      if (look.mode === "rotate") {
        cam.yaw -= dx * 0.006;
        cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch + dy * 0.006));
      } else {
        const scale = cam.dist / focal;
        cam.target = add(cam.target, add(mul(B.r, -dx * scale), mul(B.u, dy * scale)));
        state.follow = null;
      }
    } else {
      hover = bodyAt(e.clientX, e.clientY);
      canvas.classList.toggle("over-body", !!hover);
    }
  });

  // Mouse speed over the last ~0.1 s, turned into simulated AU/day so a throw keeps the speed you see.
  function throwVelocity(now) {
    const recent = drag.samples.filter(s => now - s.t <= 100);
    if (recent.length < 2) return [0, 0, 0];
    const a = recent[0], z = recent[recent.length - 1];
    // Measured over at least 50 ms, so a single jerky mouse event cannot fling a star across the galaxy.
    const secs = Math.max(0.05, (z.t - a.t) / 1000);
    let v = mul(sub(z.x, a.x), 1 / secs / state.daysPerSec);
    const cap = 0.08;   // AU/day, about 140 km/s (Earth orbits at 30)
    if (len(v) > cap) v = mul(norm(v), cap);
    return v;
  }

  function endDrag(e) {
    const b = drag.body;
    if (b.alive) {
      const now = performance.now();
      if (e && e.shiftKey) {
        const p = sys.strongestPull(b);
        b.v = p ? sys.circularVelocity(b, p) : [0, 0, 0];
        if (p) toast(`${Called(b)}: round orbit around ${called(p)}`);
      } else {
        b.v = throwVelocity(now);
      }
      b.kinematic = false;
    }
    drag = null;
    $("draghint").style.display = "none";
  }

  canvas.addEventListener("pointerup", e => {
    if (drag) endDrag(e);
    look = null;
    canvas.classList.remove("dragging");
  });
  canvas.addEventListener("pointercancel", e => { if (drag) endDrag(e); look = null; canvas.classList.remove("dragging"); });

  canvas.addEventListener("dblclick", e => {
    const b = bodyAt(e.clientX, e.clientY);
    state.follow = b ? b.name : null;
    if (b) toast(`Following ${b.name} (Esc to stop)`);
  });

  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    const view = PRESETS[state.preset].view;
    cam.dist = Math.max(view * 0.05, Math.min(view * 40, cam.dist * Math.exp(e.deltaY * 0.0012)));
  }, { passive: false });

  window.addEventListener("resize", resize);

  /* ---------------------------------------------------------------- main loop */
  let last = performance.now(), lastPanel = 0, lastOrbitCheck = 0;
  function frame(now) {
    const realDt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    if (!state.paused) sys.advance(realDt * state.daysPerSec);
    while (sys.events.length) { const m = sys.events.shift(); toast(m[0].toUpperCase() + m.slice(1)); }
    if (drag && !drag.body.alive) endDrag(null);

    const minStep = cam.dist * 0.0007;
    for (const b of sys.alive()) {
      if (!b.trail) b.trail = [];
      const D = displayPos(b), lastPt = b.trail[b.trail.length - 1];
      if (!lastPt || len(sub(D, lastPt)) > minStep) {
        b.trail.push(D);
        const cap = parentOf(b) ? 90 : 1100;
        while (b.trail.length > cap) b.trail.shift();
      }
    }
    if (state.follow) {
      const b = sys.find(state.follow);
      if (b) cam.target = add(cam.target, mul(sub(displayPos(b), cam.target), 0.15));
      else state.follow = null;
    }
    render();
    if (now - lastPanel > 120) { updatePanels(); lastPanel = now; }
    if (now - lastOrbitCheck > 500) { checkOrbits(); lastOrbitCheck = now; }
    requestAnimationFrame(frame);
  }

  resize();
  load(state.preset);
  setSpeed(+(query.get("speed") || 20));
  B = basis();
  window.gravitySim = { sys, state, cam, load, setSpeed, setPaused, displayPos };
  requestAnimationFrame(frame);
})();
