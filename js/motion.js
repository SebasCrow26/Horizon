// Movimiento al estilo Apple: resortes definidos por "amortiguación" y "respuesta" (no por duración),
// interrumpibles (cada animación parte del valor ACTUAL y conserva la velocidad) y con proyección
// de impulso para los gestos. Sin librerías.
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const live = new Map(); // clave → { x, v, target, raf }

// damping 1 = sin rebote (por defecto); ~0,8 = con rebote, solo si el gesto traía impulso.
// response = segundos aproximados para llegar al destino (menor = más rápido).
export function spring(key, { from, to, response = 0.4, damping = 1, velocity = 0, onUpdate, onDone, eps = 0.0005 }) {
  const prev = live.get(key);
  let x = from, v = velocity;
  if (prev) { x = prev.x; v = prev.v; cancelAnimationFrame(prev.raf); } // interrupción: parte del valor y la velocidad actuales
  if (reduced()) { live.delete(key); onUpdate(to); onDone && onDone(); return; }
  const k = (2 * Math.PI / response) ** 2;         // rigidez
  const c = (4 * Math.PI * damping) / response;    // fricción
  const scale = Math.max(1, Math.abs(to - x));
  const st = { x, v, target: to, raf: 0 };
  live.set(key, st);
  let last = performance.now();
  const step = (now) => {
    let dt = Math.min(0.033, (now - last) / 1000); last = now;
    // subpasos para estabilidad con resortes rígidos
    const n = Math.ceil(dt / 0.004);
    const h = dt / n;
    for (let i = 0; i < n; i++) { const a = -k * (st.x - to) - c * st.v; st.v += a * h; st.x += st.v * h; }
    onUpdate(st.x);
    if (Math.abs(st.x - to) < eps * scale && Math.abs(st.v) < eps * 20 * scale) {
      onUpdate(to); live.delete(key); onDone && onDone();
    } else st.raf = requestAnimationFrame(step);
  };
  st.raf = requestAnimationFrame(step);
  return () => { cancelAnimationFrame(st.raf); live.delete(key); };
}

export const current = (key) => live.get(key)?.x;

// Hacia dónde "iría" un gesto soltado con velocidad v (px/s), igual que la desaceleración de un scroll.
export function project(v, rate = 0.998) { return ((v / 1000) * rate) / (1 - rate); }

// Resistencia progresiva en los bordes: cuanto más te pasas del límite, menos sigue el contenido.
export function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

// Historial corto de posición para estimar la velocidad al soltar
export function tracker() {
  const pts = [];
  return {
    add(x, t = performance.now()) { pts.push({ x, t }); while (pts.length > 2 && t - pts[0].t > 100) pts.shift(); },
    velocity() { if (pts.length < 2) return 0; const a = pts[0], b = pts[pts.length - 1]; return b.t > a.t ? ((b.x - a.x) / (b.t - a.t)) * 1000 : 0; },
    reset() { pts.length = 0; },
  };
}
