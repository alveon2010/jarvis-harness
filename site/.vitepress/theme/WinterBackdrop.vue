<script setup lang="ts">
import { useData } from "vitepress";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

/**
 * A winter mountain range behind the home page, in greys: four ridges from far and pale to near and
 * dark, mist drifting between them, snow falling in front. Drawn from a fixed seed, so it is the same
 * range on every visit; still when the reader asks for less motion.
 */
const { frontmatter } = useData();
const home = computed(() => frontmatter.value.layout === "home");

const W = 1600;
const H = 900;

// a small seeded generator: the same ridges every time
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * A ridge: a few peaks as cones with slightly concave flanks, a fine jagged edge on top. Far ridges
 * get tall narrow peaks, near ones low wide shoulders.
 */
function ridge(seed: number, base: number, height: number, peaks: number, jag: number): string {
  const rand = rng(seed);
  const cones = Array.from({ length: peaks }, () => ({
    c: rand() * W,
    h: height * (0.45 + rand() * 0.55),
    w: (W / peaks) * (0.55 + rand() * 0.6),
  }));
  const n = 160;
  const fine = Array.from({ length: n + 1 }, () => (rand() - 0.5) * jag);
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) {
    const x = (i / n) * W;
    let top = 0;
    for (const k of cones) {
      const d = Math.abs(x - k.c) / k.w;
      if (d < 1) top = Math.max(top, k.h * (1 - d) ** 1.35);
    }
    const y = base - top - (fine[i] as number) * (0.4 + top / height);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return `M0,${H} L${pts.join(" L")} L${W},${H} Z`;
}

const layers = [
  { d: ridge(7, 560, 420, 5, 14), cap: 300 },
  { d: ridge(19, 640, 300, 6, 12), cap: 420 },
  { d: ridge(41, 720, 200, 7, 9), cap: 0 },
  { d: ridge(83, 820, 120, 5, 6), cap: 0 },
];

// snow: a canvas in front of the range
const canvas = ref<HTMLCanvasElement | null>(null);
let frame = 0;
let stop = () => {};

function snow(el: HTMLCanvasElement) {
  const ctx = el.getContext("2d");
  if (!ctx) return () => {};
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = 0;
  let h = 0;
  const resize = () => {
    w = el.clientWidth;
    h = el.clientHeight;
    el.width = w * dpr;
    el.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  const rand = rng(5);
  const flakes = Array.from({ length: Math.round(Math.min(160, (w * h) / 9000)) }, () => ({
    x: rand() * w,
    y: rand() * h,
    r: 0.6 + rand() * 1.8,
    v: 0.25 + rand() * 0.7,
    sway: rand() * Math.PI * 2,
  }));
  const color = () => getComputedStyle(el).getPropertyValue("--snow").trim() || "rgba(255,255,255,.8)";
  let fill = color();
  const draw = (t: number) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = fill;
    for (const f of flakes) {
      if (!still) {
        f.y += f.v;
        f.x += Math.sin(t / 1600 + f.sway) * 0.35;
        if (f.y > h + 4) {
          f.y = -4;
          f.x = rand() * w;
        }
      }
      ctx.globalAlpha = 0.35 + f.r / 3.5;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!still) frame = requestAnimationFrame(draw);
  };
  frame = requestAnimationFrame(draw);
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  const recolor = () => {
    fill = color();
  };
  const observer = new MutationObserver(recolor);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  scheme.addEventListener("change", recolor);
  window.addEventListener("resize", resize);
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    scheme.removeEventListener("change", recolor);
    window.removeEventListener("resize", resize);
  };
}

const start = () => {
  stop();
  if (home.value && canvas.value) stop = snow(canvas.value);
};
onMounted(start);
watch(home, () => requestAnimationFrame(start));
onBeforeUnmount(() => stop());
</script>

<template>
  <div v-if="home" class="winter" aria-hidden="true">
    <svg class="range" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="xMidYMax slice">
      <defs>
        <linearGradient id="winter-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" class="sky-top" />
          <stop offset="1" class="sky-low" />
        </linearGradient>
        <linearGradient id="winter-mist" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" class="mist-a" />
          <stop offset="1" class="mist-b" />
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#winter-sky)" />
      <clipPath id="winter-c1"><path :d="layers[0]!.d" /></clipPath>
      <clipPath id="winter-c2"><path :d="layers[1]!.d" /></clipPath>
      <path :d="layers[0]!.d" class="r1" />
      <rect class="cap" x="0" y="0" :width="W" :height="layers[0]!.cap" clip-path="url(#winter-c1)" />
      <rect class="mist m1" x="-400" y="470" width="2400" height="170" fill="url(#winter-mist)" />
      <path :d="layers[1]!.d" class="r2" />
      <rect class="cap" x="0" y="0" :width="W" :height="layers[1]!.cap" clip-path="url(#winter-c2)" />
      <rect class="mist m2" x="-400" y="600" width="2400" height="150" fill="url(#winter-mist)" />
      <path :d="layers[2]!.d" class="r3" />
      <path :d="layers[3]!.d" class="r4" />
    </svg>
    <canvas ref="canvas" class="snow" />
    <div class="fade" />
  </div>
</template>

<style>
/* the palette, in both themes (unscoped: the theme class sits on <html>) */
.winter {
  --sky-top: #e9ecef;
  --sky-low: #f7f8f9;
  --r1: #cfd4d9;
  --r2: #b4bac1;
  --r3: #8e959d;
  --r4: #5d636a;
  --mist: rgba(247, 248, 249, 0.75);
  --snow: rgba(120, 128, 136, 0.55);
  --cap: rgba(255, 255, 255, 0.55);
}
.dark .winter {
  --sky-top: #0f1114;
  --sky-low: #1b1d21;
  --r1: #2a2e33;
  --r2: #34383e;
  --r3: #24272b;
  --r4: #16181b;
  --mist: rgba(27, 29, 33, 0.7);
  --snow: rgba(235, 238, 242, 0.75);
  --cap: rgba(210, 216, 222, 0.16);
}
</style>

<style scoped>
.winter {
  position: absolute;
  inset: 0 0 auto 0;
  height: min(100vh, 900px);
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
}
.range {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.sky-top {
  stop-color: var(--sky-top);
}
.sky-low {
  stop-color: var(--sky-low);
}
.mist-a {
  stop-color: var(--mist);
  stop-opacity: 0;
}
.mist-b {
  stop-color: var(--mist);
}
.r1 {
  fill: var(--r1);
}
.r2 {
  fill: var(--r2);
}
.r3 {
  fill: var(--r3);
}
.r4 {
  fill: var(--r4);
}
.cap {
  fill: var(--cap);
}
.mist {
  animation: drift 60s ease-in-out infinite alternate;
}
.m2 {
  animation-duration: 80s;
  animation-direction: alternate-reverse;
}
@keyframes drift {
  from {
    transform: translateX(-120px);
  }
  to {
    transform: translateX(120px);
  }
}
.snow {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
/* the range fades into the page where the features begin */
.fade {
  position: absolute;
  inset: auto 0 0 0;
  height: 30%;
  background: linear-gradient(to bottom, transparent, var(--vp-c-bg));
}
@media (prefers-reduced-motion: reduce) {
  .mist {
    animation: none;
  }
}
</style>
