// Performance 3 — the stamp, lifted from the approved motion sketches:
// the falling seal, the paper squash, the turbulence imprint. Approval is
// rendered as the stamp coming down — the seal IS the approve action's
// visual (design.md D-033; D-035 roster: the flagship performance, and it
// belongs to the queue). Triggered by meaning only: one stamp per
// release, never ambient. Under reduced motion the still final frame
// (imprint inked, status flipped) IS the performance.
//
// D-044 ledger note: the performance runs ~1.5s while the commit it
// dramatizes is instant in the clickable. The engine files
// performed-duration vs actual-work-duration into the run's receipts;
// the clickable has no receipts to write, which is exactly the gap the
// engine closes behind the same contract.

let seq = 0;

const SEAL_STROKE = "oklch(32% 0.10 28)"; // --color-accent, literal for the SVG

function ringDef(id: string): string {
  return `<path id="${id}" d="M100,100 m-76,0 a76,76 0 1,1 152,0 a76,76 0 1,1 -152,0"/>`;
}

function sealBody(ringId: string, strokeW: [number, number]): string {
  return (
    `<circle cx="100" cy="100" r="92" fill="none" stroke="${SEAL_STROKE}" stroke-width="${strokeW[0]}"/>` +
    `<circle cx="100" cy="100" r="62" fill="none" stroke="${SEAL_STROKE}" stroke-width="${strokeW[1]}"/>` +
    `<text font-family="IBM Plex Mono, monospace" font-size="13.5" letter-spacing="3.5" fill="${SEAL_STROKE}">` +
    `<textPath href="#${ringId}" startOffset="0">SUPERPOWERS · DO IT ONCE · SUPERPOWERS · DO IT ONCE ·</textPath></text>` +
    `<text x="100" y="130" text-anchor="middle" font-family="Playfair Display, Georgia, serif" ` +
    `font-weight="700" font-size="104" fill="${SEAL_STROKE}">s</text>`
  );
}

/** The hand-stamped imprint (−5° tilt, feTurbulence uneven ink) + the clean falling seal. */
function stampZoneMarkup(n: number): string {
  return (
    `<svg class="imprint" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<defs>${ringDef(`ring-a-${n}`)}` +
    `<filter id="ink-a-${n}" x="-10%" y="-10%" width="120%" height="120%">` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" result="n"/>` +
    `<feDisplacementMap in="SourceGraphic" in2="n" scale="2.2"/>` +
    `<feComponentTransfer><feFuncA type="table" tableValues="0 0.92"/></feComponentTransfer>` +
    `</filter></defs>` +
    `<g transform="rotate(-5 100 100)" filter="url(#ink-a-${n})">${sealBody(`ring-a-${n}`, [5, 2])}</g>` +
    `</svg>` +
    `<svg class="faller" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<defs>${ringDef(`ring-b-${n}`)}</defs>` +
    `<g>${sealBody(`ring-b-${n}`, [6, 2.5])}</g>` +
    `</svg>`
  );
}

export interface StampHandle {
  cancel: () => void;
}

/**
 * Play the stamp onto `paper` (the sheet that takes the hit). The zone is
 * created inside `paper` at its top right; `paper`'s nearest overflow-
 * hidden ancestor clips the fall so the seal enters from off the page.
 *
 *   onImprint — the ink lands: flip the status, roll the counts. This is
 *               the legal moment made visible.
 *   onDone    — the seal has lifted; the imprint stays.
 */
export function playStamp(
  paper: HTMLElement,
  opts: { reduced: boolean; onImprint: () => void; onDone: () => void },
): StampHandle {
  const zone = document.createElement("div");
  zone.className = "stampzone";
  zone.innerHTML = stampZoneMarkup(++seq);
  paper.appendChild(zone);
  const imprint = zone.querySelector<SVGElement>(".imprint")!;
  const faller = zone.querySelector<SVGElement>(".faller")!;

  const timers: number[] = [];
  let cancelled = false;
  const later = (fn: () => void, ms: number) => {
    timers.push(
      window.setTimeout(() => {
        if (!cancelled) fn();
      }, ms),
    );
  };

  if (opts.reduced) {
    imprint.classList.add("inked");
    later(() => {
      opts.onImprint();
      opts.onDone();
    }, 0);
    return { cancel: () => { cancelled = true; timers.forEach(clearTimeout); } };
  }

  later(() => {
    faller.classList.add("drop");
    later(() => {
      faller.classList.remove("drop");
      faller.classList.add("squash");
      imprint.classList.add("inked");
      paper.classList.add("shake");
      later(() => paper.classList.remove("shake"), 200);
      opts.onImprint();
      later(() => {
        faller.classList.remove("squash");
        faller.classList.add("lift");
        later(() => opts.onDone(), 520);
      }, 560);
    }, 245);
  }, 160);

  return { cancel: () => { cancelled = true; timers.forEach(clearTimeout); } };
}
