import * as THREE from "./vendor/three.module.min.js";

/*
 * One specimen, one scene: the sample photo as a cloud of points. Scrolling walks it
 * through the real pipeline. All imagery is real output from BogniGuard.
 */
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
const small = () => innerWidth <= 860;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

/* Copy reveal works with or without WebGL. */
const seen = new IntersectionObserver((entries) => entries.forEach((e) => {
  if (e.isIntersecting) { e.target.classList.add("seen"); seen.unobserve(e.target); }
}), { threshold: .12 });
document.querySelectorAll(".copy").forEach((el) => seen.observe(el));

const amp = document.getElementById("amp");
const ampOut = document.getElementById("ampOut");
amp.addEventListener("input", () => {
  const v = +amp.value;
  ampOut.textContent = v <= 1 ? "×1, what you actually get" : `×${v.toFixed(1)} stronger than real`;
});

/* Where the specimen sits and what it is doing in each act. x/y are stage offsets. */
const STATES = {
  hero:    { x: .7, y: 0,    rx: -.1,  ry: -.46, zoom: 1,    depth: 0,   latent: 0, gray: 0, edit: 0, fake: 0, wave: 0, peel: 0, seam: 0 },
  numbers: { x: .62, y: 0,    rx: -.32, ry: -.8,  zoom: 1.05, depth: 1,   latent: 0, gray: 0, edit: 0, fake: 0, wave: 0, peel: 0, seam: 0 },
  latent:  { x: -.62, y: 0,   rx: .36,  ry: .72,  zoom: 1.2,  depth: .2,  latent: 1, gray: 0, edit: 0, fake: 0, wave: 0, peel: 0, seam: 0 },
  edit:    { x: .6,  y: 0,    rx: 0,    ry: -.26, zoom: 1.05, depth: 0,   latent: 0, gray: 0, edit: 1, fake: 0, wave: 0, peel: 0, seam: 0 },
  shield:  { x: -.74, y: 0,    rx: -.18, ry: .5,   zoom: 1.08, depth: 0,   latent: 0, gray: 0, edit: 0, fake: 0, wave: 1, peel: 0, seam: 0 },
  drift:   { x: .62, y: 0,    rx: .36,  ry: -.72, zoom: 1.2,  depth: .2,  latent: 1, gray: 1, edit: 0, fake: 0, wave: 1, peel: 0, seam: 0 },
  fakeA:   { x: -.6, y: 0,    rx: 0,    ry: .22,  zoom: 1.05, depth: 0,   latent: 0, gray: 0, edit: 0, fake: 1, wave: 0, peel: 0, seam: 0 },
  fakeB:   { x: .36, y: .06,  rx: -.16, ry: -.42, zoom: 1.08, depth: 0,   latent: 0, gray: 0, edit: 0, fake: 1, wave: 0, peel: 1, seam: 1 },
  sober:   { x: -.8, y: 0,    rx: 0,    ry: .4,   zoom: .92,  depth: 0,   latent: 0, gray: 0, edit: 0, fake: 1, wave: 0, peel: .12, seam: .4 },
  close:   { x: .82, y: 0,    rx: -.06, ry: -.42, zoom: .96,  depth: 0,   latent: 0, gray: 0, edit: 0, fake: 0, wave: 0, peel: 0, seam: 0 },
};
const KEYS = Object.keys(STATES.hero);
const acts = [...document.querySelectorAll("[data-state]")];

/** Blend between acts, holding each one around its centre so its state reads clearly. */
function stateAt() {
  const mid = scrollY + innerHeight / 2;
  const anchors = acts.map((el) => {
    const r = el.getBoundingClientRect();
    return { y: scrollY + r.top + Math.min(r.height, innerHeight * 1.2) / 2 + Math.max(0, r.height - innerHeight * 1.2) * .5, s: STATES[el.dataset.state] };
  });
  let i = 0;
  while (i < anchors.length - 2 && mid > anchors[i + 1].y) i++;
  const a = anchors[i], b = anchors[i + 1];
  const t = smooth(clamp((clamp((mid - a.y) / (b.y - a.y)) - .18) / .64));
  const out = {};
  KEYS.forEach((k) => { out[k] = lerp(a.s[k], b.s[k], t); });
  return out;
}

const vertex = /* glsl */`
  precision highp float;
  in vec3 position;
  in vec3 aRand;
  uniform mat4 modelViewMatrix, projectionMatrix;
  uniform sampler2D uPhoto, uEdit, uFake, uPattern;
  uniform float uSize, uTime, uGather, uDepth, uLatent, uGray, uEditMix, uFakeMix, uWave, uAmp, uPeel, uAspectFix;
  out vec3 vColor;
  out float vAlpha;

  const float LOD = 3.0;
  void main() {
    vec2 uv = position.xy;
    vec3 flatPos = vec3((uv - .5) * 2.0, 0.0);

    // Colours: photo, the AI edit, or the edit of the protected photo.
    vec3 photo = texture(uPhoto, uv).rgb;
    vec3 col = mix(photo, texture(uEdit, uv).rgb, uEditMix);
    col = mix(col, texture(uFake, uv).rgb, uFakeMix);

    // The real pattern. Its full range is the real change of 15/255 in either direction.
    vec3 delta = (texture(uPattern, uv).rgb - .5) * 2.0 * (15.0 / 255.0);
    float front = uWave * 2.6 - .8;
    float swept = smoothstep(front + .25, front - .25, uv.x + uv.y * .6);
    float luma = dot(photo, vec3(.3, .59, .11));
    col += delta * uAmp * swept;
    vec3 pos = flatPos;
    pos.z += (luma - .4) * .55 * uDepth;
    pos.z += dot(delta, vec3(.333)) * uAmp * swept * .9;

    // The latent: a real 4-channel block, shown as a lattice of 16 x 16 x 4 cells.
    vec2 cell = (floor(uv * 16.0) + .5) / 16.0;
    float layer = floor(aRand.x * 4.0);
    vec3 cube = vec3((cell - .5) * 1.25, (layer - 1.5) * .3);
    cube += (aRand - .5) * .052;
    vec3 summary = textureLod(uPhoto, cell, 4.0).rgb;
    float g = smoothstep(0.0, 1.0, uGray * 1.6 - (cell.x + cell.y) * .3);
    summary = mix(summary, vec3(.5), g);
    float stagger = smoothstep(aRand.y * .35, .65 + aRand.y * .35, uLatent);
    pos = mix(pos, cube, stagger);
    col = mix(col, summary, stagger);

    // The seam: the painted area peels away from the protected oval.
    vec2 c = (uv - .5) / vec2(.3, .42);
    float r = length(c);
    float outside = smoothstep(.97, 1.03, r);
    vec2 away = normalize(flatPos.xy + 1e-4);
    float drift = uPeel * outside * (.62 + aRand.z * .38);
    pos.xy += away * drift * .3;
    pos.z -= drift * (.55 + aRand.x * .45);
    pos.z += uPeel * (1.0 - outside) * .34;

    // Gather: points arrive from a scattered cloud.
    vec3 scatter = (aRand - .5) * vec3(7.0, 5.0, 5.0);
    pos = mix(pos, scatter, (1.0 - uGather) * (.55 + aRand.y * .45));
    pos.xy += sin(uTime * .5 + aRand.xy * 6.28) * .004 * (1.0 - stagger * .4);

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * mix(1.0, .78, stagger) / -mv.z;
    vColor = clamp(col, 0.0, 1.0);
    vAlpha = 1.0 - uPeel * outside * .22;
  }
`;

const fragment = /* glsl */`
  precision highp float;
  in vec3 vColor;
  in float vAlpha;
  out vec4 outColor;
  void main() { outColor = vec4(vColor, vAlpha); }
`;

function loadTexture(url) {
  return new Promise((ok, fail) => new THREE.TextureLoader().load(url, (t) => {
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    ok(t);
  }, undefined, fail));
}

async function start() {
  const canvas = document.getElementById("stage");
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: "high-performance" });
    if (!renderer.capabilities.isWebGL2) throw new Error("WebGL2 unavailable");
  } catch {
    document.documentElement.classList.add("no3d");
    return;
  }
  const [photo, edit, fake, pattern] = await Promise.all(
    ["img/sample.jpg", "img/proof-original.jpg", "img/proof-protected.jpg", "img/sample-pattern.png"].map(loadTexture),
  );
  pattern.colorSpace = THREE.NoColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, .1, 40);
  camera.position.z = 5.2;

  const N = small() ? 190 : 340;
  const positions = new Float32Array(N * N * 3);
  const randoms = new Float32Array(N * N * 3);
  for (let i = 0; i < N * N; i++) {
    positions[i * 3] = (i % N + .5) / N;
    positions[i * 3 + 1] = (Math.floor(i / N) + .5) / N;
    randoms.set([Math.random(), Math.random(), Math.random()], i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aRand", new THREE.BufferAttribute(randoms, 3));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 12);

  const uniforms = {
    uPhoto: { value: photo }, uEdit: { value: edit }, uFake: { value: fake }, uPattern: { value: pattern },
    uSize: { value: 1 }, uTime: { value: 0 }, uGather: { value: calm ? 1 : 0 }, uDepth: { value: 0 },
    uLatent: { value: 0 }, uGray: { value: 0 }, uEditMix: { value: 0 }, uFakeMix: { value: 0 },
    uWave: { value: 0 }, uAmp: { value: 1 }, uPeel: { value: 0 }, uAspectFix: { value: 1 },
  };
  const material = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: vertex, fragmentShader: fragment, uniforms, transparent: true });
  const specimen = new THREE.Group();
  const points = new THREE.Points(geometry, material);
  specimen.add(points);
  scene.add(specimen);

  // The real seam: an oval matching the protected area of the real output.
  const curve = new THREE.EllipseCurve(0, 0, .6, .84, 0, Math.PI * 2);
  const seamMaterial = new THREE.LineBasicMaterial({ color: 0x74a4ff, transparent: true, opacity: 0 });
  const seam = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(curve.getPoints(160)), seamMaterial);
  specimen.add(seam);

  const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
  if (matchMedia("(pointer: fine)").matches) {
    addEventListener("pointermove", (e) => {
      pointer.x = e.clientX / innerWidth - .5;
      pointer.y = e.clientY / innerHeight - .5;
    }, { passive: true });
  }

  let width, height;
  function resize() {
    width = innerWidth; height = innerHeight;
    const dpr = Math.min(devicePixelRatio || 1, small() ? 1.5 : 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    // Point size that closes the gaps between neighbours at the rest distance.
    const worldToPx = (height * dpr) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    uniforms.uSize.value = (2 / N) * worldToPx * 1.85;
  }
  addEventListener("resize", resize);
  resize();

  const bar = document.getElementById("bar");
  const current = stateAt();
  const started = performance.now();

  function frame(now) {
    const target = stateAt();
    const follow = calm ? 1 : .085;
    KEYS.forEach((k) => { current[k] = lerp(current[k], target[k], follow); });

    const portrait = small();
    const scale = portrait ? Math.min(.8, width / height * 1.16) : 1;
    specimen.position.set(portrait ? 0 : current.x * Math.max(1, camera.aspect) * .92, portrait ? .68 + current.y * .12 : current.y * .5, 0);
    specimen.scale.setScalar((portrait ? 1 : current.zoom) * scale);
    pointer.sx = lerp(pointer.sx, pointer.x, .06);
    pointer.sy = lerp(pointer.sy, pointer.y, .06);
    const idle = calm ? 0 : Math.sin(now * .00035) * .035;
    specimen.rotation.set(current.rx + pointer.sy * .22, current.ry + pointer.sx * .34 + idle, 0);

    uniforms.uTime.value = calm ? 0 : now * .001;
    uniforms.uGather.value = calm ? 1 : smooth(clamp((now - started - 120) / 1700));
    uniforms.uDepth.value = current.depth;
    uniforms.uLatent.value = current.latent;
    uniforms.uGray.value = current.gray;
    uniforms.uEditMix.value = current.edit;
    uniforms.uFakeMix.value = current.fake;
    uniforms.uWave.value = current.wave;
    uniforms.uAmp.value = lerp(uniforms.uAmp.value, +amp.value, calm ? 1 : .12);
    uniforms.uPeel.value = current.peel;
    seam.position.z = current.peel * .34 + .01;
    seamMaterial.opacity = current.seam;
    seam.visible = current.seam > .01;

    const max = document.documentElement.scrollHeight - innerHeight;
    bar.style.transform = `scaleX(${max > 0 ? scrollY / max : 0})`;
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

start().catch(() => document.documentElement.classList.add("no3d"));
