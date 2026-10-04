// lois/goldfish — the goldfish school (D-114): per-world cold readers on the bus.
//
// A goldfish is a fresh reader who receives one outbound message knowing ONLY
// what its real recipient would know. It answers literally: what is happening,
// when, what am I being asked to do — and lists everything the message assumes
// it knows but it doesn't. If it can't answer without inventing, the draft
// SINKS for that reader.
//
// The SCHOOL is per world, and derived from the world — never authored: each
// fish's priors are assembled mechanically from vault facts (how many of these
// gatherings this recipient actually attended), plus one stranger fish with no
// priors at all (the noun-swap test made into a reader). A world of regulars
// gets a regulars-heavy school; a cold-prospect world is all strangers.
//
// This is different from the critic on purpose: the critic judges the WRITING
// against the voice evidence; the goldfish tests COMPREHENSION against the
// reader's priors. A draft can be perfectly in voice and still sink for a
// first-timer who was never told where the table is.
//
// Advisory (soft in the loop, D-111). One swim per unique (body x priors) —
// digest dedupe, mechanical, legitimate. Verdicts land on the trace.

import type { AgentSpec } from "./registry.js";
import type { LoisModel } from "./model.js";
import { parseJsonLoose } from "./model.js";
import { aggregateReturning } from "./plan.js";

const FISH_CONTRACT = [
  "You are a person reading one message you just received. You know ONLY what is listed under",
  "PRIORS — nothing else about the sender, the event, or any history. Read the message literally.",
  "Return STRICT JSON only:",
  '{',
  '  "what": "<what is happening, as far as the words alone tell you>",',
  '  "when_where": "<when and where, or empty if you cannot tell>",',
  '  "ask": "<what you are being asked to do>",',
  '  "assumed": [<things the message assumes you know but you do not>],',
  '  "verdict": "swims" | "sinks"',
  '}',
  "Verdict rule: sinks if you cannot tell what is happening, or what to do, or enough to act",
  "(a real reader would have to guess or write back asking). Otherwise swims, even if small",
  "details are missing.",
].join("\n");

/** A fish = a reader shape, with priors derived from vault facts. */
interface Fish {
  name: string;
  priors: string;
}

export interface GoldfishSchoolOptions {
  /** Product default keeps the actual recipient and the stranger noun-swap. */
  readers?: "recipient-and-stranger" | "recipient-only";
  /** Smoke-only selection: ignore drafts not addressed to this exact first/name token. */
  recipient?: string;
  /** Hard cap on fresh model reads for this school instance. */
  maxReads?: number;
}

/** Derive the school for this world from who is actually in the room. */
function school(
  loyaltyOf: Map<string, number>,
  to: string | undefined,
  readers: GoldfishSchoolOptions["readers"] = "recipient-and-stranger",
): Fish[] {
  const fish: Fish[] = [];
  // The actual recipient's shape, when the draft names one we can find.
  const loyalty = to !== undefined ? loyaltyOf.get(to.toLowerCase()) : undefined;
  if (loyalty !== undefined) {
    fish.push({
      name: `recipient (${loyalty} prior dinner${loyalty === 1 ? "" : "s"})`,
      priors: `You have attended ${loyalty} of this sender's dinners before. That is all you know.`,
    });
  }
  // The stranger swims in every school: if the message only works on priors,
  // the stranger is who finds out.
  if (readers === "recipient-and-stranger") {
    fish.push({ name: "stranger", priors: "You have never heard of this sender or this event. You know nothing." });
  }
  return fish;
}

export function goldfishSchool(model: LoisModel | null, opts: GoldfishSchoolOptions = {}): AgentSpec {
  const swum = new Map<string, number>(); // digest x fish -> verdict event seq
  let reads = 0;
  const selectedRecipient = opts.recipient?.trim().toLowerCase();
  return {
    name: "goldfish",
    role: "worker",
    purpose: "cold-read every draft as its real recipient would (priors from the vault) plus a stranger",
    triggersOn: (event) => {
      if (event.kind !== "proposed" || (event.detail?.kind as string | undefined) !== "draft") return false;
      if (!selectedRecipient) return true;
      return String(event.detail?.to ?? "").trim().toLowerCase() === selectedRecipient;
    },
    run: async (ctx, event) => {
      const body = (event.detail?.body as string | undefined) ?? "";
      const subject = (event.detail?.subject as string | undefined) ?? "";
      const to = event.detail?.to as string | undefined;
      if (!body) return;
      if (!model) {
        ctx.trace.append({ actor: "goldfish", kind: "note", label: "no model connected; the school cannot swim (drafts UNTESTED)", refs: [event.seq] });
        return;
      }
      const text = [subject, body].filter(Boolean).join("\n");
      const dg = (event.detail?.digest as string | undefined) ?? text;

      // Reader shapes come from the world: loyalty by first name, mechanically.
      const upcoming = ctx.world.gatherings.find((g) => g.upcoming);
      const loyaltyOf = new Map<string, number>();
      if (upcoming) {
        for (const g of aggregateReturning(ctx.world, upcoming.id)) loyaltyOf.set(g.firstName.toLowerCase(), g.loyalty);
      }

      for (const fish of school(loyaltyOf, to, opts.readers)) {
        if (opts.maxReads !== undefined && reads >= opts.maxReads) {
          ctx.trace.append({
            actor: "goldfish",
            kind: "note",
            label: `school read cap (${opts.maxReads}) reached; later drafts remain UNTESTED`,
            refs: [event.seq],
          });
          return;
        }
        const key = `${dg}::${fish.priors}`;
        const prior = swum.get(key);
        if (prior !== undefined) {
          ctx.trace.append({ actor: "goldfish", kind: "note", label: `${fish.name}: same words already swum; verdict at #${prior} stands`, refs: [event.seq, prior] });
          continue;
        }
        reads += 1;
        try {
          const raw = await model.complete({
            system: FISH_CONTRACT,
            user: `PRIORS: ${fish.priors}\n\nThe message:\n${text}`,
            json: true,
          });
          const parsed = parseJsonLoose(raw) as Record<string, unknown> | undefined;
          const verdict = parsed && typeof parsed.verdict === "string" ? parsed.verdict : "unreadable";
          const assumed = parsed && Array.isArray(parsed.assumed) ? parsed.assumed.filter((a): a is string => typeof a === "string") : [];
          const v = ctx.trace.append({
            actor: "goldfish",
            kind: "note",
            label: `${fish.name}: ${verdict}${assumed.length > 0 ? ` — assumes: ${assumed.join("; ")}` : ""}`,
            detail: { fish: fish.name, verdict, reading: parsed },
            refs: [event.seq],
          });
          swum.set(key, v.seq);
        } catch (err) {
          ctx.trace.append({
            actor: "goldfish",
            kind: "note",
            label: `${fish.name}: could not swim (${err instanceof Error ? err.message : String(err)})`,
            refs: [event.seq],
          });
        }
      }
    },
  };
}
