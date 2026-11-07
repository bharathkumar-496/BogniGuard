"use strict";

const $ = (id) => document.getElementById(id);
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
const fine = matchMedia("(pointer: fine)").matches;
const API = window.BG_API || "";
const PUBLIC = !!window.BG_PUBLIC;
const MAX_MB = PUBLIC ? 10 : 25;
const state = { file: null, job: null, events: null, testEvents: null, testJob: null, painted: false };
const easeOut = (t) => 1 - (1 - t) ** 3;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/* ---------- The Guard mark: every instance has four separately animated lobes ---------- */
document.querySelectorAll("[data-mark]").forEach((svg) => {
  svg.setAttribute("viewBox", window.GUARD_MARK.viewBox);
  svg.innerHTML = window.GUARD_MARK.lobes.map((d, i) => `<path class="lobe l${i}" d="${d}"/>`).join("");
});

function splitWords(el) {
  const words = [];
  el.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) node.textContent.split(/\s+/).filter(Boolean).forEach((w) => words.push(w));
    else words.push(node.outerHTML);
  });
  el.innerHTML = words.map((w, i) => `<span class="w"><span style="--w:${(.05 + i * .06).toFixed(2)}s">${w}</span></span>`).join(" ");
}
splitWords($("headline"));
document.querySelectorAll("[data-split]").forEach(splitWords);

/* ---------- Opening sting: gather, name, then cobalt fills from the mark ---------- */
(function sting() {
  const el = $("sting");
  let played = false;
  try { played = sessionStorage.getItem("bg-sting") === "1"; } catch { /* storage may be blocked */ }
  const ready = () => {
    document.body.classList.add("ready");
    setTimeout(() => document.body.classList.add("settled"), 2400);
  };
  if (calm || played) { el.remove(); ready(); return; }
  try { sessionStorage.setItem("bg-sting", "1"); } catch { /* fine */ }
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    el.classList.add("out");
    ready();
    setTimeout(() => el.remove(), 400);
  };
  setTimeout(() => el.classList.add("fill"), 1750);
  setTimeout(finish, 2350);
  el.addEventListener("click", finish);
})();

/* ---------- Background: dust that gathers to the cursor and connects ---------- */
const field = (() => {
  const canvas = $("field");
  const ctx = canvas.getContext("2d");
  const mouse = { x: -9999, y: -9999 };
  let w, h, dpr, dots = [], focus = null;
  const seed = () => {
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = canvas.width = innerWidth * dpr;
    h = canvas.height = innerHeight * dpr;
    const n = Math.min(170, Math.floor(innerWidth * innerHeight / 8500));
    dots = Array.from({ length: n }, () => {
      const x = Math.random() * w, y = Math.random() * h;
      return { x, y, hx: x, hy: y, vx: 0, vy: 0, r: (.6 + Math.random() * 1.3) * dpr, a: .14 + Math.random() * .4, ph: Math.random() * 6.28 };
    });
  };
  function frame(t) {
    ctx.clearRect(0, 0, w, h);
    const reach = 190 * dpr, link = 96 * dpr, near = [];
    for (const d of dots) {
      d.hx = (d.hx + Math.cos(d.ph + t * .00018) * .14 * dpr + w) % w;
      d.hy = (d.hy + Math.sin(d.ph + t * .00014) * .14 * dpr + h) % h;
      let tx = d.hx, ty = d.hy, pull = .012;
      if (focus) {
        // Gather into a loose ring around the photo while it is being protected.
        const a = Math.atan2(d.hy - focus.y, d.hx - focus.x) + t * .00008;
        const ring = focus.r * (1 + Math.sin(d.ph) * .14);
        tx = focus.x + Math.cos(a) * ring;
        ty = focus.y + Math.sin(a) * ring;
        pull = .02;
      }
      const mx = mouse.x - d.x, my = mouse.y - d.y, dist = Math.hypot(mx, my);
      if (dist < reach) {
        const f = (1 - dist / reach) * .05;
        d.vx += mx * f * .1;
        d.vy += my * f * .1;
        near.push(d);
      }
      d.vx = (d.vx + (tx - d.x) * pull) * .88;
      d.vy = (d.vy + (ty - d.y) * pull) * .88;
      d.x += d.vx;
      d.y += d.vy;
      ctx.fillStyle = `rgba(116,164,255,${near.at(-1) === d ? .9 : d.a})`;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, 6.29);
      ctx.fill();
    }
    ctx.lineWidth = dpr * .7;
    for (let i = 0; i < near.length; i++) {
      for (let j = i + 1; j < near.length; j++) {
        const a = near[i], b = near[j], gap = Math.hypot(a.x - b.x, a.y - b.y);
        if (gap < link) {
          ctx.strokeStyle = `rgba(116,164,255,${(1 - gap / link) * .42})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
    if (!calm) requestAnimationFrame(frame);
  }
  addEventListener("resize", () => { seed(); if (calm) frame(0); });
  if (fine) addEventListener("pointermove", (e) => { mouse.x = e.clientX * dpr; mouse.y = e.clientY * dpr; });
  seed();
  requestAnimationFrame(frame);
  return {
    gather(el) {
      const r = el.getBoundingClientRect();
      focus = { x: (r.left + r.width / 2) * dpr, y: (r.top + r.height / 2) * dpr, r: Math.max(r.width, r.height) * .62 * dpr };
    },
    release(burst) {
      if (burst && focus) {
        dots.forEach((d) => {
          const a = Math.atan2(d.y - focus.y, d.x - focus.x);
          d.vx += Math.cos(a) * 16 * dpr;
          d.vy += Math.sin(a) * 16 * dpr;
        });
      }
      focus = null;
    },
  };
})();

/* ---------- Hero: follow the pointer, otherwise sweep on its own ---------- */
(function hero() {
  const demo = $("heroDemo");
  let target = null, sweep = 55, rx = 0, ry = 0, tx = 0, ty = 0;
  if (fine) {
    demo.addEventListener("pointermove", (e) => {
      const r = demo.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
      target = px * 100;
      ry = (px - .5) * 7;
      rx = (.5 - py) * 7;
    });
    demo.addEventListener("pointerleave", () => { target = null; rx = ry = 0; });
  }
  (function loop(t) {
    const goal = target ?? 50 + Math.sin(t * .0007) * 34;
    sweep = lerp(sweep, goal, .09);
    tx = lerp(tx, rx, .08);
    ty = lerp(ty, ry, .08);
    demo.style.setProperty("--sweep", sweep.toFixed(2) + "%");
    demo.style.setProperty("--rx", tx.toFixed(2) + "deg");
    demo.style.setProperty("--ry", ty.toFixed(2) + "deg");
    if (!calm) requestAnimationFrame(loop);
  })(0);
})();

/* ---------- Scroll: progress bar, parallax, reveals ---------- */
(function scroll() {
  const bar = $("progress"), ghost = document.querySelector(".ghost-mark");
  let queued = false;
  const update = () => {
    queued = false;
    const max = document.documentElement.scrollHeight - innerHeight;
    bar.style.transform = `scaleX(${max > 0 ? scrollY / max : 0})`;
    if (ghost && !calm) ghost.style.setProperty("--scroll", scrollY * .14 + "px");
  };
  addEventListener("scroll", () => { if (!queued) { queued = true; requestAnimationFrame(update); } }, { passive: true });
})();

const reveal = new IntersectionObserver((entries) => entries.forEach((e) => {
  if (!e.isIntersecting) return;
  e.target.classList.add("seen");
  reveal.unobserve(e.target);
  // Never leave content hidden if a transition stalls.
  setTimeout(() => e.target.classList.add("done"), 3200);
}), { threshold: .15, rootMargin: "0px 0px -6% 0px" });
document.querySelectorAll("[data-reveal]").forEach((el) => reveal.observe(el));

/* ---------- Small interactions ---------- */
document.addEventListener("pointermove", (e) => {
  if (!fine) return;
  const spot = e.target.closest?.(".spot");
  if (spot) {
    const r = spot.getBoundingClientRect();
    spot.style.setProperty("--mx", e.clientX - r.left + "px");
    spot.style.setProperty("--my", e.clientY - r.top + "px");
  }
  const btn = e.target.closest?.(".primary");
  if (btn) {
    const r = btn.getBoundingClientRect();
    btn.style.setProperty("--mx", e.clientX - r.left + "px");
    btn.style.setProperty("--my", e.clientY - r.top + "px");
    if (!calm) {
      btn.style.setProperty("--tx", (e.clientX - r.left - r.width / 2) * .08 + "px");
      btn.style.setProperty("--ty", (e.clientY - r.top - r.height / 2) * .14 - 1 + "px");
    }
  }
});
document.addEventListener("pointerout", (e) => {
  const btn = e.target.closest?.(".primary");
  if (btn && !btn.contains(e.relatedTarget)) { btn.style.setProperty("--tx", "0px"); btn.style.setProperty("--ty", "0px"); }
});

/* ---------- How-it-works diagrams, drawn from the real sample ---------- */
(function diagrams() {
  const load = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; });
  const tiles = (img, n) => {
    const c = document.createElement("canvas");
    c.width = c.height = n;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, 0, 0, n, n);
    const d = x.getImageData(0, 0, n, n).data;
    return Array.from({ length: n * n }, (_, i) => [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]);
  };
  const loop = (t, secs) => (t / 1000 / secs) % 1;
  const brand = (t) => 1 - (1 - t) ** 4;

  Promise.all(["sample.jpg", "proof-original.jpg", "proof-protected.jpg"].map(load)).then(([sample, before, after]) => {
    if (!sample || !before || !after) return;
    const big = tiles(sample, 7);
    const draw = {
      encode(x, t) {
        const p = loop(t, 5), n = 7;
        x.drawImage(sample, 40, 40, 280, 280);
        for (let i = 0; i < n * n; i++) {
          const cx = i % n, cy = Math.floor(i / n);
          const start = (cx + cy) * .018;
          const q = brand(clamp01((p - .12 - start) / .4));
          const from = 280 / n, to = 26;
          const size = lerp(from, to, q) - 1;
          const sx = 40 + cx * from, sy = 40 + cy * from;
          const ex = 412 + cx * to, ey = 89 + cy * to;
          x.fillStyle = `rgb(${big[i]})`;
          x.fillRect(lerp(sx, ex, q), lerp(sy, ey, q), size, size);
        }
      },
      poison(x, t) {
        const p = loop(t, 5), n = 7, size = 44, ox = 166, oy = 26;
        for (let i = 0; i < n * n; i++) {
          const cx = i % n, cy = Math.floor(i / n);
          const q = brand(clamp01((p * 1.5 - .1 - (cx + cy) * .05)));
          const c = big[i].map((v) => Math.round(lerp(v, 128, q)));
          x.fillStyle = `rgb(${c})`;
          x.fillRect(ox + cx * size, oy + cy * size, size - 2, size - 2);
        }
        const line = oy + clamp01(p * 1.5) * n * size;
        x.fillStyle = "#74a4ff";
        x.fillRect(ox - 12, line - 1, n * size + 22, 2);
      },
      seam(x, t) {
        const p = loop(t, 6);
        const s = 40 + brand(p < .5 ? p * 2 : 2 - p * 2) * 560;
        const crop = 512 * 360 / 640;
        x.drawImage(before, 0, (512 - crop) / 2, 512, crop, 0, 0, 640, 360);
        x.save();
        x.beginPath();
        x.rect(s, 0, 640 - s, 360);
        x.clip();
        x.drawImage(after, 0, (512 - crop) / 2, 512, crop, 0, 0, 640, 360);
        x.restore();
        x.fillStyle = "#fff";
        x.fillRect(s - 1, 0, 2, 360);
      },
    };
    document.querySelectorAll(".viz").forEach((canvas) => {
      const x = canvas.getContext("2d"), fn = draw[canvas.dataset.viz];
      let on = false;
      const tick = (t) => {
        if (!on) return;
        x.clearRect(0, 0, 640, 360);
        fn(x, t);
        requestAnimationFrame(tick);
      };
      fn(x, calm ? 3000 : 1200);
      if (calm) return;
      new IntersectionObserver(([e]) => {
        const was = on;
        on = e.isIntersecting;
        if (on && !was) requestAnimationFrame(tick);
      }).observe(canvas);
    });
  });
})();

/* ---------- Helpers ---------- */
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 6000);
}

async function api(path, options) {
  let res;
  try {
    res = await fetch(API + path, options);
  } catch {
    throw new Error("Can't reach the BogniGuard server. Is it still running?");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = body.detail;
    throw new Error(typeof d === "string" ? d : "Something went wrong. Please try again.");
  }
  return body;
}

/** One cobalt blob grows from a corner, the scene swaps behind it, then it clears. */
function blobWipe(swap) {
  if (calm) { swap(); return; }
  const el = $("wipe");
  el.classList.remove("out");
  el.classList.add("in");
  setTimeout(() => {
    swap();
    el.classList.remove("in");
    el.classList.add("out");
    setTimeout(() => el.classList.remove("out"), 360);
  }, 430);
}

function placeStepPill() {
  const list = $("steps"), now = list.querySelector("li.now");
  if (!now) return;
  list.style.setProperty("--px", now.offsetLeft + "px");
  list.style.setProperty("--pw", now.offsetWidth + "px");
}
addEventListener("resize", placeStepPill);

function setStep(name) {
  document.querySelectorAll("[data-panel]").forEach((p) => {
    p.hidden = p.dataset.panel !== name;
    // Entrance only: a stalled animation must never leave a working screen dimmed.
    p.style.animation = "";
    if (!p.hidden) setTimeout(() => { p.style.animation = "none"; }, 900);
  });
  const order = ["compose", "forge", "result"];
  document.querySelectorAll("#steps li").forEach((li) => {
    const diff = order.indexOf(li.dataset.s) - order.indexOf(name);
    li.classList.toggle("now", diff === 0);
    li.classList.toggle("past", diff < 0);
  });
  placeStepPill();
  scrollTo({ top: 0 });
  if (name === "forge") requestAnimationFrame(() => field.gather($("forgeStage")));
}

function countUp(el, value, decimals = 0, suffix = "") {
  if (calm) { el.textContent = value.toFixed(decimals) + suffix; return; }
  const start = performance.now();
  (function tick(now) {
    const p = Math.min(1, (now - start) / 1100);
    el.textContent = (value * easeOut(p)).toFixed(decimals) + suffix;
    if (p < 1) requestAnimationFrame(tick);
  })(start);
}

/* ---------- Status ---------- */
if (PUBLIC) {
  // Never call the API on page load: that would wake, and bill, the GPU.
  const el = $("device");
  el.classList.add("on");
  el.querySelector("span").textContent = "Cloud GPU on demand";
  document.querySelectorAll("[data-public-text]").forEach((n) => { n.textContent = n.dataset.publicText; });
  $("dropHint").textContent = `or click to choose. JPG, PNG or WebP, up to ${MAX_MB} MB`;
  $("consentRow").hidden = false;
  // Light rarely breaks an edit visibly, which would make the shield look like it failed.
  document.querySelector("input[name=strength][value=light]").closest(".card").remove();
  $("privacyLink").hidden = false;
  $("warnLead").textContent = "Download it now, and keep it as a PNG.";
  $("promptLabel").textContent = "Choose a scene";
  $("prompt").hidden = true;
  $("prompt").required = false;
  $("preset").hidden = false;
  Object.entries(window.BG_PRESETS).forEach(([id, text]) => $("preset").add(new Option(text, id)));
} else {
  api("/api/status").then((s) => {
    const el = $("device");
    el.classList.add("on");
    el.querySelector("span").textContent = { mps: "Apple GPU ready", cuda: "NVIDIA GPU ready", cpu: "CPU only, will be slow" }[s.device];
  }).catch(() => {
    const el = $("device");
    el.classList.add("off");
    el.querySelector("span").textContent = "Server offline";
  });
}

/* ---------- Choosing a photo ---------- */
const photoCtx = $("photo").getContext("2d");
const paintCtx = $("paint").getContext("2d");
const PAINT = "#74a4ff";

async function loadFile(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) return toast("That file isn't an image.");
  if (file.size > MAX_MB * 1024 * 1024) return toast(`That image is over ${MAX_MB} MB.`);
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return toast("This browser can't read that image. Try a JPG or PNG.");
  }
  state.file = file;
  const side = Math.min(bitmap.width, bitmap.height);
  photoCtx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 512, 512);
  bitmap.close();
  starterOval();
  blobWipe(() => {
    document.body.dataset.view = "studio";
    $("studio").hidden = false;
    setStep("compose");
  });
}

function clearPaint() {
  paintCtx.clearRect(0, 0, 512, 512);
  state.painted = false;
}

function starterOval() {
  clearPaint();
  paintCtx.fillStyle = PAINT;
  paintCtx.beginPath();
  paintCtx.ellipse(256, 256, 154, 215, 0, 0, Math.PI * 2);
  paintCtx.fill();
  state.painted = true;
}

$("file").addEventListener("change", (e) => { loadFile(e.target.files[0]); e.target.value = ""; });
const drop = $("drop");
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file").click(); } });
["dragenter", "dragover"].forEach((t) => addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
addEventListener("drop", (e) => loadFile(e.dataTransfer.files[0]));

$("sample").addEventListener("click", async () => {
  try {
    const blob = await (await fetch("sample.jpg")).blob();
    loadFile(new File([blob], "sample.jpg", { type: "image/jpeg" }));
  } catch { toast("Couldn't load the sample."); }
});

function restart() {
  // Free the GPU rather than leaving an abandoned edit running.
  if (state.testJob) fetch(`${API}/api/jobs/${state.testJob}/cancel`, { method: "POST" });
  closeStreams();
  attackDone();
  field.release();
  state.file = null;
  state.job = null;
  blobWipe(() => {
    document.body.dataset.view = "landing";
    $("studio").hidden = true;
    scrollTo({ top: 0 });
  });
}
$("restart").addEventListener("click", restart);
$("again").addEventListener("click", restart);

/* ---------- Painting the protected area ---------- */
const stage = $("stage");
const modeInputs = document.querySelectorAll("input[name=mode]");
const paintMode = () => document.querySelector("input[name=mode]:checked").value === "area";

function syncMode() {
  const on = paintMode();
  $("brushRow").hidden = !on;
  $("stageNote").hidden = !on;
  stage.classList.toggle("painting", on);
  $("paint").hidden = !on;
  $("modeHint").textContent = on
    ? "Strongest in our tests. Cover the person or subject you want to keep from being faked."
    : "Covers everything, but held up less well in our inpainting tests.";
}
modeInputs.forEach((i) => i.addEventListener("change", syncMode));
syncMode();
$("clearPaint").addEventListener("click", clearPaint);

(function painter() {
  let down = false, last = null;
  const point = (e) => {
    const r = stage.getBoundingClientRect();
    return { x: (e.clientX - r.left) * 512 / r.width, y: (e.clientY - r.top) * 512 / r.height, r };
  };
  const stroke = (a, b) => {
    paintCtx.strokeStyle = PAINT;
    paintCtx.lineCap = "round";
    paintCtx.lineWidth = +$("brush").value;
    paintCtx.beginPath();
    paintCtx.moveTo(a.x, a.y);
    paintCtx.lineTo(b.x + .01, b.y);
    paintCtx.stroke();
    state.painted = true;
  };
  stage.addEventListener("pointerdown", (e) => {
    if (!paintMode()) return;
    down = true; last = point(e); stroke(last, last);
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", (e) => {
    if (!paintMode()) return;
    const p = point(e), size = +$("brush").value * p.r.width / 512, cursor = $("brushCursor");
    cursor.style.width = cursor.style.height = size + "px";
    cursor.style.transform = `translate(${e.clientX - p.r.left - size / 2}px,${e.clientY - p.r.top - size / 2}px)`;
    if (down) { stroke(last, p); last = p; }
  });
  ["pointerup", "pointercancel"].forEach((t) => stage.addEventListener(t, () => { down = false; }));
})();

/* ---------- Forging ---------- */
function closeStreams() {
  state.events?.close();
  state.testEvents?.close();
  state.events = state.testEvents = null;
}

// The shield builds up from its point, lobe by lobe, as the steps complete.
const lobeOrder = [3, 2, 1, 0];
function setForgeMark(pct) {
  const lobes = $("forgeMark").querySelectorAll(".lobe");
  lobeOrder.forEach((index, i) => lobes[index].classList.toggle("on", pct >= (i + 1) / 4 - .2));
  $("forgeMark").classList.toggle("done", pct >= 1);
}

function resetForge() {
  $("forgeTitle").textContent = "Waking the model…";
  $("forgeSub").textContent = PUBLIC ? "Starting the GPU. This can take a minute or two if it has been asleep." : "The first run loads about 2 GB into memory.";
  $("meter").firstElementChild.style.transform = "scaleX(0)";
  $("rIter").textContent = "0 / 0";
  $("rEta").textContent = "–";
  $("sparkPath").setAttribute("d", "");
  $("forgeNoise").hidden = true;
  $("forgeStage").style.setProperty("--noise", 0);
  $("forgeMark").querySelectorAll(".lobe").forEach((l) => l.classList.remove("on"));
  $("forgeMark").classList.remove("done");
}

$("forge").addEventListener("click", async () => {
  const usePaint = paintMode();
  if (usePaint && !state.painted) return toast("Paint the area to protect first, or switch to Whole photo.");
  if (PUBLIC && !$("consent").checked) return toast("Please confirm you have the right to use this photo.");
  const form = new FormData();
  if (PUBLIC) form.append("consent", "yes");
  form.append("image", state.file);
  form.append("strength", document.querySelector("input[name=strength]:checked").value);
  if (usePaint) {
    form.append("mask", await new Promise((ok) => $("paint").toBlob(ok, "image/png")), "mask.png");
  }
  resetForge();
  $("forgeBase").src = $("photo").toDataURL("image/jpeg", .9);
  blobWipe(() => setStep("forge"));
  try {
    const { job } = await api("/api/protect", { method: "POST", body: form });
    state.job = job;
    watchForge(job, usePaint);
  } catch (err) {
    field.release();
    blobWipe(() => setStep("compose"));
    toast(err.message);
  }
});

function backToCompose(message) {
  field.release();
  blobWipe(() => setStep("compose"));
  if (message) toast(message);
}

function watchForge(job, usePaint) {
  const losses = [];
  let started = null;
  const es = state.events = new EventSource(`${API}/api/jobs/${job}/events`);
  es.onmessage = (msg) => {
    const e = JSON.parse(msg.data);
    if (e.stage === "protecting") {
      started ??= performance.now();
      $("forgeTitle").textContent = "Forging your shield";
      $("forgeSub").textContent = "Each step nudges the pixels a little further from what the model expects.";
      const pct = e.iter / e.total;
      $("meter").firstElementChild.style.transform = `scaleX(${pct})`;
      $("meter").setAttribute("aria-valuenow", Math.round(pct * 100));
      $("rIter").textContent = `${e.iter} / ${e.total}`;
      setForgeMark(pct);
      if (e.iter > 3) {
        const left = (performance.now() - started) / e.iter * (e.total - e.iter) / 1000;
        $("rEta").textContent = left >= 60 ? `${Math.floor(left / 60)}m ${String(Math.round(left % 60)).padStart(2, "0")}s` : `${Math.round(left)}s`;
      }
      losses.push(e.loss);
      drawSpark(losses);
      if (e.preview) {
        const noise = $("forgeNoise");
        noise.src = e.preview;
        noise.hidden = false;
        $("forgeStage").style.setProperty("--noise", Math.min(.55, .15 + pct * .5));
      }
    } else if (e.stage === "done") {
      es.close();
      setForgeMark(1);
      field.release(true);
      // Keep the results in the browser, so they outlive the GPU going to sleep.
      fetchResults(job).then((urls) => blobWipe(() => showResult(job, urls, e.stats, usePaint)));
    } else if (e.stage === "cancelled") {
      es.close();
      backToCompose();
    } else if (e.stage === "error") {
      es.close();
      backToCompose(e.message);
    }
  };
  es.onerror = () => {
    es.close();
    backToCompose("Lost connection to the server.");
  };
}

function drawSpark(values) {
  const max = Math.max(...values), min = Math.min(...values), span = max - min || 1;
  const n = Math.max(values.length - 1, 1);
  $("sparkPath").setAttribute("d", values.map((v, i) =>
    `${i ? "L" : "M"}${(i / n * 320).toFixed(1)} ${(90 - (v - min) / span * 84).toFixed(1)}`).join(""));
}

$("cancelForge").addEventListener("click", () => {
  if (state.job) fetch(`${API}/api/jobs/${state.job}/cancel`, { method: "POST" });
});

/* ---------- Result ---------- */
async function fetchResults(job) {
  Object.values(state.urls || {}).forEach((u) => { if (u.startsWith("blob:")) URL.revokeObjectURL(u); });
  const urls = {};
  await Promise.all(["original", "protected", "noise"].map(async (name) => {
    const direct = `${API}/api/jobs/${job}/files/${name}.png`;
    try {
      const res = await fetch(direct);
      if (!res.ok) throw new Error();
      urls[name] = URL.createObjectURL(await res.blob());
    } catch {
      urls[name] = direct;
    }
  }));
  state.urls = urls;
  return urls;
}

function showResult(job, urls, stats, usePaint) {
  $("cOriginal").src = urls.original;
  $("cProtected").src = urls.protected;
  document.querySelector("input[name=view][value=compare]").checked = true;
  setView("compare");
  $("download").href = urls.protected;
  $("resultSub").textContent = usePaint
    ? "Only your painted area changed. Every other pixel is untouched."
    : "The pattern covers the whole photo.";
  $("attackSub").textContent = usePaint
    ? "Stable Diffusion will try to repaint everything you did not paint, on both versions, with the same prompt and seed."
    : "Stable Diffusion will try to repaint everything around a central oval, on both versions, with the same prompt and seed.";
  resetDuel();
  setStep("result");
  const compare = $("compare");
  compare.classList.remove("pulse");
  void compare.offsetWidth;
  compare.classList.add("pulse");
  countUp($("sPsnr"), stats.psnr, 1);
  countUp($("sMax"), stats.max_change);
  countUp($("sShift"), (1 - stats.loss_end / stats.loss_start) * 100, 0, "%");
  countUp($("sTime"), stats.seconds, 0, "s");
  $("sDevice").textContent = `Time taken, ${stats.iters} steps on ${{ mps: "Apple GPU", cuda: "NVIDIA GPU", cpu: "CPU" }[stats.device]}`;
  animateCompare();
}

function setView(view) {
  const compare = $("compare");
  compare.classList.toggle("pattern", view === "pattern");
  $("cProtected").src = view === "pattern" ? state.urls.noise : state.urls.protected;
}
document.querySelectorAll("input[name=view]").forEach((i) => i.addEventListener("change", () => setView(i.value)));

$("cRange").addEventListener("input", (e) => { $("compare").style.setProperty("--c", e.target.value + "%"); });

function animateCompare() {
  const compare = $("compare"), range = $("cRange");
  if (calm) return;
  const start = performance.now();
  (function tick(now) {
    const t = Math.min(1, (now - start) / 1900);
    const v = 50 + Math.sin(t * Math.PI * 2) * 34 * (1 - t);
    range.value = v;
    compare.style.setProperty("--c", v + "%");
    if (t < 1) requestAnimationFrame(tick);
  })(start);
}

/* ---------- Attack test ---------- */
const duel = { original: $("duelOriginal"), protected: $("duelProtected") };

function resetDuel() {
  Object.values(duel).forEach((fig) => {
    const frame = fig.querySelector(".duel-frame");
    frame.classList.remove("active");
    frame.querySelector("img")?.remove();
    frame.querySelector("p").textContent = "Waiting";
    frame.querySelector(".duel-bar i").style.width = 0;
  });
  $("duelNote").hidden = true;
}

function attackDone() {
  $("runAttack").firstElementChild.textContent = "Run attack";
  state.testJob = null;
}

$("attackForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (state.testJob) {
    $("runAttack").firstElementChild.textContent = "Stopping…";
    fetch(`${API}/api/jobs/${state.testJob}/cancel`, { method: "POST" });
    return;
  }
  resetDuel();
  try {
    const { job } = await api("/api/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job: state.job,
        seed: +$("seed").value || 0,
        ...(PUBLIC ? { preset: $("preset").value } : { prompt: $("prompt").value.trim() }),
      }),
    });
    state.testJob = job;
    $("runAttack").firstElementChild.textContent = "Stop";
    Object.values(duel).forEach((f) => { f.querySelector("p").textContent = "Queued"; });
    const es = state.testEvents = new EventSource(`${API}/api/jobs/${job}/events`);
    es.onmessage = (msg) => {
      const e = JSON.parse(msg.data);
      if (e.stage === "editing") {
        const frame = duel[e.which].querySelector(".duel-frame");
        frame.classList.add("active");
        frame.querySelector("p").textContent = `Step ${e.step} of ${e.total}`;
        frame.querySelector(".duel-bar i").style.width = `${e.step / e.total * 100}%`;
      } else if (e.stage === "edited") {
        const frame = duel[e.which].querySelector(".duel-frame");
        frame.classList.remove("active");
        const img = new Image();
        const scene = PUBLIC ? $("preset").selectedOptions[0].text : $("prompt").value;
        img.alt = `AI edit of the ${e.which} photo: ${scene}`;
        img.src = API + e.url;
        frame.append(img);
        frame.querySelector(".duel-bar i").style.width = 0;
      } else if (e.stage === "done") {
        es.close(); attackDone();
        $("duelNote").hidden = false;
      } else if (e.stage === "cancelled" || e.stage === "error") {
        es.close(); attackDone();
        if (e.message) toast(e.message);
        resetDuel();
      }
    };
    es.onerror = () => { es.close(); attackDone(); toast("Lost connection to the server."); };
  } catch (err) {
    toast(err.message);
  }
});
