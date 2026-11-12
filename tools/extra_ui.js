// ---------- movimiento e interacción (Apple Design) ----------
// Indicador de los controles segmentados: resorte interrumpible (parte del valor y la velocidad actuales)
function moveInd(seg, key) {
  const ind = $(".ind", seg), on = $("a.on", seg);
  if (!ind || !on) return;
  const tx = on.offsetLeft - 4, w = on.offsetWidth;
  if (!ind.dataset.ready) { ind.style.width = w + "px"; ind.style.transform = `translateX(${tx}px)`; ind.dataset.x = tx; ind.dataset.w = w; ind.dataset.ready = "1"; return; }
  spring(key + "x", { from: +ind.dataset.x, to: tx, response: 0.42, damping: 0.9, onUpdate: (x) => { ind.style.transform = `translateX(${x}px)`; ind.dataset.x = x; } });
  spring(key + "w", { from: +ind.dataset.w, to: w, response: 0.42, damping: 0.9, onUpdate: (x) => { ind.style.width = x + "px"; ind.dataset.w = x; } });
}

// Aviso con acción "Deshacer" (retroalimentación de estado + perdón de errores)
const toastEl = document.createElement("div");
toastEl.className = "glass toast"; toastEl.setAttribute("role", "status"); toastEl.setAttribute("aria-live", "polite");
document.body.append(toastEl);
let toastT = 0;
function hideToast() {
  toastEl.classList.remove("on");
  spring("toast", { from: 0, to: 80, response: 0.4, onUpdate: (y) => { toastEl.style.transform = `translate(-50%, ${y}px)`; } });
}
function toast(msg, action) {
  toastEl.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="undo">${esc(action.label)}</button>` : ""}`;
  toastEl.classList.add("on");
  spring("toast", { from: 70, to: 0, response: 0.45, onUpdate: (y) => { toastEl.style.transform = `translate(-50%, ${y}px)`; } });
  const undo = $(".undo", toastEl);
  if (undo) undo.onclick = () => { clearTimeout(toastT); hideToast(); action.fn(); };
  clearTimeout(toastT); toastT = setTimeout(hideToast, 5200);
}

// Medidores: la perilla llega al valor con un resorte casi crítico
let gid = 0;
function animateGauges(root) {
  for (const g of $$(".gauge:not([data-anim])", root)) {
    g.dataset.anim = "1";
    const th = $(".thumb", g), to = ((+g.dataset.v + 1) / 2) * 100, key = "g" + ++gid;
    th.style.left = "50%";
    spring(key, { from: 50, to, response: 0.75, damping: 0.88, onUpdate: (p) => { th.style.left = p + "%"; } });
  }
}
// Tarjetas navegables: accesibles con teclado
function a11yLinks(root) { for (const el of $$("[data-href]:not([tabindex])", root)) { el.tabIndex = 0; el.setAttribute("role", "link"); } }
new MutationObserver(() => { animateGauges(view); a11yLinks(view); }).observe(view, { childList: true, subtree: true });
document.addEventListener("keydown", (e) => {
  const el = e.target;
  if ((e.key === "Enter" || e.key === " ") && el.matches?.("[data-href]")) { e.preventDefault(); location.hash = el.dataset.href; }
});

// Deslizar entre modelos: sigue al dedo 1:1, con resistencia en los bordes y proyección del impulso al soltar
function bindSwipe(p, getI, count, goTo) {
  let id = null, sx = 0, sy = 0, drag = false, x = 0;
  const tr = tracker();
  p.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" || e.target.closest("svg.chart")) return;
    id = e.pointerId; sx = e.clientX; sy = e.clientY; drag = false; tr.reset(); tr.add(e.clientX);
  });
  p.addEventListener("pointermove", (e) => {
    if (e.pointerId !== id) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!drag) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) { drag = true; try { p.setPointerCapture(id); } catch (_) { /* sin captura */ } }
      else return;
    }
    tr.add(e.clientX);
    const i = getI(), edge = (dx > 0 && i === 0) || (dx < 0 && i === count - 1);
    x = edge ? rubberband(dx, p.offsetWidth) : dx;
    p.style.animation = "none"; p.style.transform = `translateX(${x}px)`; p.style.opacity = String(1 - Math.min(0.5, Math.abs(x) / p.offsetWidth));
  });
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    if (!drag) return;
    drag = false;
    const v = tr.velocity(), i = getI(), proj = x + project(v, 0.99);
    const dirn = proj < 0 ? 1 : -1, to = i + dirn;
    if (Math.abs(proj) > p.offsetWidth * 0.3 && to >= 0 && to < count) {
      p.style.transform = ""; p.style.opacity = "";
      goTo(to, dirn, dirn * Math.min(160, p.offsetWidth * 0.3)); // el nuevo panel entra desde el lado del gesto
    } else {
      spring("panel-x", { from: x, to: 0, velocity: v, response: 0.35, damping: 0.85, onUpdate: (xx) => { p.style.transform = `translateX(${xx}px)`; p.style.opacity = String(1 - Math.min(0.5, Math.abs(xx) / p.offsetWidth)); }, onDone: () => { p.style.transform = ""; p.style.opacity = ""; } });
    }
  };
  p.addEventListener("pointerup", end); p.addEventListener("pointercancel", end);
}

