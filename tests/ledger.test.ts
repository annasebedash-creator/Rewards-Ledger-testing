import { describe, it, expect } from "vitest";
import { Ledger, EXPIRY_DAYS } from "../src/ledger";

const DAY = 24 * 60 * 60 * 1000;
const t0 = new Date("2026-08-16T12:00:00Z");
const at = (days: number, extraMs = 0) => new Date(t0.getTime() + days * DAY + extraMs);

const receipt = (purchaseId: string, amountCents: number, when = t0) =>
  ({ type: "earn", purchaseId, source: "receipt", amountCents, at: when }) as const;
const card = (purchaseId: string, amountCents: number, status: "pending" | "booked", when = t0) =>
  ({ type: "earn", purchaseId, source: "card", amountCents, status, at: when }) as const;

describe("basic earning", () => {
  it("credits 1 point per full euro (floor, not round)", () => {
    const l = new Ledger();
    l.apply(receipt("p1", 1999)); // 19.99 €
    expect(l.balance(t0)).toBe(19); // not 20 — rounding up would leak points at scale
  });

  it("zero-amount purchase earns zero without erroring", () => {
    const l = new Ledger();
    l.apply(receipt("p1", 0));
    expect(l.balance(t0)).toBe(0);
  });

  it("rejects negative amounts", () => {
    const l = new Ledger();
    expect(() => l.apply(receipt("p1", -500))).toThrow();
  });
});

describe("deduplication — the same purchase must never pay twice", () => {
  it("same receipt submitted twice credits once", () => {
    const l = new Ledger();
    l.apply(receipt("p1", 5000));
    l.apply(receipt("p1", 5000));
    expect(l.balance(t0)).toBe(50);
  });

  it("receipt photo + card feed for the same purchase credits once", () => {
    const l = new Ledger();
    l.apply(receipt("p1", 5000));
    l.apply(card("p1", 5000, "booked"));
    expect(l.balance(t0)).toBe(50);
  });

  it("card feed then receipt for the same purchase credits once", () => {
    const l = new Ledger();
    l.apply(card("p1", 5000, "booked"));
    l.apply(receipt("p1", 5000));
    expect(l.balance(t0)).toBe(50);
  });
});

describe("pending vs. booked — settled amounts win", () => {
  it("booked amount overrides the pending authorization amount", () => {
    const l = new Ledger();
    l.apply(card("p1", 10000, "pending")); // authorized 100 €
    l.apply(card("p1", 8750, "booked")); // settled 87.50 € (partial return at till)
    expect(l.balance(t0)).toBe(87);
  });

  it("a second booked report does not double-credit", () => {
    const l = new Ledger();
    l.apply(card("p1", 8750, "booked"));
    l.apply(card("p1", 8750, "booked")); // feed replay
    expect(l.balance(t0)).toBe(87);
  });
});

describe("spending", () => {
  it("cannot spend more than the balance", () => {
    const l = new Ledger();
    l.apply(receipt("p1", 3000));
    expect(() => l.apply({ type: "spend", points: 31, at: t0 })).toThrow();
  });

  it("can spend exactly the full balance", () => {
    const l = new Ledger();
    l.apply(receipt("p1", 3000));
    l.apply({ type: "spend", points: 30, at: t0 });
    expect(l.balance(t0)).toBe(0);
  });
});

describe("refund claw-backs", () => {
  it("refund removes the points earned by that purchase", () => {
    const l = new Ledger();
    l.apply(receipt("p1", 5000));
    l.apply(receipt("p2", 2000));
    l.apply({ type: "refund", purchaseId: "p1", at: at(1) });
    expect(l.balance(at(1))).toBe(20);
  });

  it("refund after the points were spent creates a deficit (not an error)", () => {
    const l = new Ledger();
    l.apply(receipt("p1", 5000));
    l.apply({ type: "spend", points: 50, at: t0 });
    l.apply({ type: "refund", purchaseId: "p1", at: at(1) });
    expect(l.balance(at(1))).toBe(-50); // documented business rule: deficit carries forward
  });

  it("double refund of the same purchase claws back only once", () => {
    const l = new Ledger();
    l.apply(receipt("p1", 5000));
    l.apply(receipt("p2", 1000));
    l.apply({ type: "refund", purchaseId: "p1", at: at(1) });
    l.apply({ type: "refund", purchaseId: "p1", at: at(2) });
    expect(l.balance(at(2))).toBe(10);
  });

  it("refund of an unknown purchase is ignored (feed replay safety)", () => {
    const l = new Ledger();
    l.apply(receipt("p1", 1000));
    l.apply({ type: "refund", purchaseId: "ghost", at: t0 });
    expect(l.balance(t0)).toBe(10);
  });
});

describe("180-day inactivity expiry — boundary dates are where the bugs live", () => {
  it("balance survives up to the last millisecond before the boundary", () => {
    const l = new Ledger();
    l.apply(receipt("p1", 10000));
    expect(l.balance(at(EXPIRY_DAYS, -1))).toBe(100);
  });

  it("balance expires exactly at the 180-day boundary", () => {
    const l = new Ledger();
    l.apply(receipt("p1", 10000));
    expect(l.balance(at(EXPIRY_DAYS))).toBe(0);
    expect(l.isExpired(at(EXPIRY_DAYS))).toBe(true);
  });

  it("any activity resets the inactivity clock", () => {
    const l = new Ledger();
    l.apply(receipt("p1", 10000));
    l.apply({ type: "spend", points: 1, at: at(100) }); // activity on day 100
    expect(l.balance(at(EXPIRY_DAYS + 50))).toBe(99); // 180 days from day 100 not yet reached
    expect(l.balance(at(100 + EXPIRY_DAYS))).toBe(0); // ...but day 280 is
  });

  it("expiry is permanent — later events do not resurrect the old balance", () => {
    const l = new Ledger();
    l.apply(receipt("p1", 10000));
    expect(l.balance(at(EXPIRY_DAYS + 10))).toBe(0);
    expect(l.isExpired(at(EXPIRY_DAYS + 10))).toBe(true);
  });

  it("refunds do NOT count as activity (user did nothing)", () => {
    const l = new Ledger();
    l.apply(receipt("p1", 10000));
    l.apply(receipt("p2", 1000));
    l.apply({ type: "refund", purchaseId: "p2", at: at(179) }); // merchant-side event
    expect(l.balance(at(EXPIRY_DAYS))).toBe(0); // still expires on day 180
  });
});
