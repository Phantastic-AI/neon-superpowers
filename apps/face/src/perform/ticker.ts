// Performance 1 — the wire ticker, lifted from the approved motion sketches.
// Progress is prose in the wire register, not a spinner. Triggered by
// meaning: the sweep is reading a guest list. Under reduced motion the
// still final frame (all lines, done) IS the performance (D-035).

export interface TickerLine {
  t: string;
  land?: boolean;
}

export interface TickerHandle {
  cancel: () => void;
}

export function playTicker(
  host: HTMLElement,
  lines: TickerLine[],
  opts: {
    reduced: boolean;
    /** Fires when line `i` has finished typing. */
    onLine?: (i: number) => void;
    onDone: () => void;
  },
): TickerHandle {
  const timers: number[] = [];
  let cancelled = false;
  const later = (fn: () => void, ms: number) => {
    timers.push(window.setTimeout(() => {
      if (!cancelled) fn();
    }, ms));
  };

  function finalFrame(): void {
    host.innerHTML = "";
    lines.forEach((l) => {
      const d = document.createElement("div");
      d.className = "tline done" + (l.land ? " tline--land" : "");
      d.textContent = l.t;
      host.appendChild(d);
    });
  }

  if (opts.reduced) {
    finalFrame();
    later(() => {
      lines.forEach((_, i) => opts.onLine?.(i));
      opts.onDone();
    }, 0);
    return { cancel: () => { cancelled = true; timers.forEach(clearTimeout); } };
  }

  host.innerHTML = "";
  let li = 0;
  function nextLine(): void {
    if (li >= lines.length) return;
    const spec = lines[li];
    const d = document.createElement("div");
    d.className = "tline" + (spec.land ? " tline--land" : "");
    const txt = document.createElement("span");
    const cur = document.createElement("span");
    cur.className = "cursor";
    d.appendChild(txt);
    d.appendChild(cur);
    host.appendChild(d);
    let ci = 0;
    function typeChar(): void {
      txt.textContent = spec.t.slice(0, ++ci);
      if (ci < spec.t.length) {
        later(typeChar, 14 + Math.random() * 26);
      } else {
        later(() => {
          d.classList.add("done");
          const finished = li;
          opts.onLine?.(finished);
          li++;
          if (li >= lines.length) {
            opts.onDone();
          } else {
            later(nextLine, li === lines.length - 1 ? 420 : 190);
          }
        }, 240);
      }
    }
    typeChar();
  }
  nextLine();

  return { cancel: () => { cancelled = true; timers.forEach(clearTimeout); } };
}
