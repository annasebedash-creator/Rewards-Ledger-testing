import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { Ledger, type LedgerEvent } from "../src/ledger";

/**
 * Property-based tests: instead of hand-picking scenarios, generate thousands of
 * random event sequences and assert invariants that must hold for ALL of them.
 * This is how you catch the edge case nobody thought to write a test for.
 */

const t0 = new Date("2026-08-16T12:00:00Z");

// Random earn/spend/refund sequences over a small purchase-ID space (to force collisions/dedup).
const eventArb = fc.oneof(
  fc.record({
    type: fc.constant<"earn">("earn"),
    purchaseId: fc.constantFrom("a", "b", "c", "d"),
    source: fc.constantFrom<"receipt" | "card">("receipt", "card"),
    amountCents: fc.integer({ min: 0, max: 50_000 }),
    status: fc.constantFrom<"pending" | "booked">("pending", "booked"),
    offsetDays: fc.integer({ min: 0, max: 30 }),
  }),
  fc.record({
    type: fc.constant<"spend">("spend"),
    points: fc.integer({ min: 0, max: 100 }),
    offsetDays: fc.integer({ min: 0, max: 30 }),
  }),
  fc.record({
    type: fc.constant<"refund">("refund"),
    purchaseId: fc.constantFrom("a", "b", "c", "d", "ghost"),
    offsetDays: fc.integer({ min: 0, max: 30 }),
  })
);

type GenEvent =
  | { type: "earn"; purchaseId: string; source: "receipt" | "card"; amountCents: number; status: "pending" | "booked"; offsetDays: number }
  | { type: "spend"; points: number; offsetDays: number }
  | { type: "refund"; purchaseId: string; offsetDays: number };

function replay(l: Ledger, events: GenEvent[]): Date {
  let last = t0;
  for (const e of events) {
    const when = new Date(t0.getTime() + e.offsetDays * 86_400_000);
    if (when > last) last = when;
    const event: LedgerEvent =
      e.type === "earn"
        ? { type: "earn", purchaseId: e.purchaseId, source: e.source, amountCents: e.amountCents, status: e.status, at: when }
        : e.type === "spend"
          ? { type: "spend", points: e.points, at: when }
          : { type: "refund", purchaseId: e.purchaseId, at: when };
    try {
      l.apply(event);
    } catch {
      // over-spends are rejected by design; sequences containing them are still valid tests
    }
  }
  return last;
}

describe("invariants over random event sequences", () => {
  it("re-reporting any purchase never increases the balance", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 40 }), (events) => {
        const l = new Ledger();
        const last = replay(l, events);
        const before = l.balance(last);
        // Replay every earn event again — dedup must make this a no-op or a decrease (booked override).
        for (const e of events) {
          if (e.type === "earn") {
            const again = { ...e, offsetDays: 30 };
            try {
              replay(l, [again]);
            } catch {}
          }
        }
        expect(l.balance(last)).toBeLessThanOrEqual(before);
      }), { numRuns: 1000 }
    );
  });

  it("balance never exceeds total booked euros earned", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 40 }), (events) => {
        const l = new Ledger();
        const last = replay(l, events);
        const maxPossible = events
          .filter((e): e is Extract<typeof e, { type: "earn" }> => e.type === "earn")
          .reduce((sum, e) => sum + Math.floor(e.amountCents / 100), 0);
        expect(l.balance(last)).toBeLessThanOrEqual(maxPossible);
      }), { numRuns: 1000 }
    );
  });

  it("spending alone can never drive the balance negative", () => {
    fc.assert(
      fc.property(fc.array(eventArb.filter((e) => e.type !== "refund"), { maxLength: 40 }), (events) => {
        const l = new Ledger();
        const last = replay(l, events);
        expect(l.balance(last)).toBeGreaterThanOrEqual(0);
      }), { numRuns: 1000 }
    );
  });
});
