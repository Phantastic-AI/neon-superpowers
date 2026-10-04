// Curated, locale-diverse plausible-name pools for the crowd cast.
// Evalkit law (D-021): never real people, never placeholder names
// ("Test Person", "Foo Bar", "John Doe"). Every combination is checked
// against BLOCKED_FULL_NAMES before use; a collision is re-drawn.
//
// These lists are invented combinations of common given/family names across
// several naming traditions. None is drawn from, or intended to reference,
// any real, identifiable individual.

import { Rng, pick } from "./rng.js";

export const FIRST_NAMES: readonly string[] = [
  // East Asian
  "Wei", "Mei", "Jun", "Ling", "Haruto", "Yuki", "Sora", "Aiko",
  "Minjun", "Soojin", "Jisoo", "Daehyun",
  // South Asian
  "Priya", "Arjun", "Ananya", "Rohan", "Divya", "Kavya", "Ishaan", "Neha",
  // Middle Eastern / North African
  "Omar", "Layla", "Zainab", "Karim", "Yusuf", "Amira", "Tariq", "Farah",
  // African
  "Kwame", "Amara", "Chidi", "Zola", "Tendai", "Nia", "Kofi", "Abena",
  // Hispanic / Latin American
  "Mateo", "Camila", "Diego", "Valentina", "Santiago", "Isabela", "Lucia",
  "Andres",
  // European / Anglo
  "Emma", "Oliver", "Sarah", "David", "Emily", "James", "Sophie", "Daniel",
  "Claire", "Henrik", "Ingrid", "Marco", "Elena", "Anders", "Freya",
  // Slavic
  "Mila", "Ivan", "Katarina", "Dmitri", "Anastasia", "Pavel",
];

export const LAST_NAMES: readonly string[] = [
  "Chen", "Wang", "Kim", "Park", "Nakamura", "Suzuki", "Lin", "Zhao",
  "Patel", "Sharma", "Gupta", "Reddy", "Nair", "Iyer", "Rao", "Verma",
  "Hassan", "Khalil", "Farouk", "Aziz", "Rahman", "Malik",
  "Okafor", "Mensah", "Diallo", "Abara", "Nkomo", "Adeyemi",
  "Garcia", "Martinez", "Rodriguez", "Hernandez", "Torres", "Flores",
  "Nguyen", "Zhang", "Liang", "Osei", "Reyes", "Vasan",
  "Smith", "Johnson", "Brown", "Taylor", "Anderson", "Clark", "Bennett",
  "Larsen", "Bergstrom", "Rossi", "Novak", "Petrov", "Kowalski",
];

/** Well-known real people and stock placeholder names — never generated. */
export const BLOCKLIST = new Set<string>([
  "Elon Musk", "Barack Obama", "Taylor Swift", "Steve Jobs", "Bill Gates",
  "Mark Zuckerberg", "Sam Altman", "Satya Nadella", "Jeff Bezos",
  "John Doe", "Jane Doe", "Foo Bar", "Test User", "Test Person",
  "Lorem Ipsum", "John Smith", "Jane Smith",
]);

/** Draws a plausible full name deterministically, re-drawing on any
 * blocklist collision (real people or stock placeholders). */
export function drawName(rng: Rng, used: Set<string>): string {
  for (let attempt = 0; attempt < 200; attempt++) {
    const first = pick(rng, FIRST_NAMES);
    const last = pick(rng, LAST_NAMES);
    const full = `${first} ${last}`;
    if (BLOCKLIST.has(full) || used.has(full)) continue;
    used.add(full);
    return full;
  }
  throw new Error("drawName: exhausted attempts without a unique, unblocked name");
}
