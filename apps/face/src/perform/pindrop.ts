// Performance 2 — the pin drop, lifted from the approved motion sketches and
// batched: on first arrival from the cold open the counts roll up and the
// rows land in one fast cascade (<= 1.5s total). Triggered by meaning — the
// import just ran — never decorative. Under reduced motion the still final
// frame IS the performance (D-035).

/** Roll a count up to `final` through a short interpolated strip (the odometer). */
export function rollCount(el: HTMLElement, final: number, reduced: boolean): void {
  if (reduced || final === 0) {
    el.textContent = String(final);
    return;
  }
  const steps: number[] = [];
  for (const v of [0, Math.round(final / 3), Math.round((2 * final) / 3), final]) {
    if (steps[steps.length - 1] !== v) steps.push(v);
  }
  const odo = document.createElement("span");
  odo.className = "odo";
  const strip = document.createElement("span");
  strip.className = "odo__strip";
  for (const v of steps) {
    const s = document.createElement("span");
    s.textContent = String(v);
    strip.appendChild(s);
  }
  odo.appendChild(strip);
  el.textContent = "";
  el.appendChild(odo);
  let idx = 0;
  const step = () => {
    idx++;
    strip.style.transform = `translateY(${-1.3 * idx}em)`;
    if (idx < steps.length - 1) window.setTimeout(step, 180);
  };
  window.setTimeout(step, 120);
}

/**
 * Land guest rows in a batched cascade. Rows must carry class "guest--new"
 * (visibility hidden until landing). Total budget ~1.4s for any row count.
 */
export function cascadeRows(rows: HTMLElement[], reduced: boolean): void {
  if (reduced) {
    rows.forEach((r) => r.classList.remove("guest--new"));
    return;
  }
  const stepMs = Math.min(12, 900 / Math.max(rows.length, 1));
  rows.forEach((row, i) => {
    const d = Math.round(i * stepMs);
    row.style.animationDelay = `${d}ms`;
    const pin = row.querySelector<HTMLElement>(".pin");
    if (pin) pin.style.animationDelay = `${d + 180}ms`;
    row.classList.add("landing");
  });
}
