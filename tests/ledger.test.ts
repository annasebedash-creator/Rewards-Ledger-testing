import { describe, it, expect } from "vitest";
import { Ledger, EXPIRY_DAYS } from "../src/ledger";

const DAY = 24 * 60 * 60 * 1000;
const t0 = new Date("2026-01-15T12:00:00Z"); // arbitrary fixed epoch for reproducibility
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
  it("REGRESSION: pending card points are not spendable (found by 1000-run property test)", () => {
    // Counterexample found by fast-check at numRuns=1000 (missed at the default 100):
    // spend against a pending authorization, then the booked settlement comes in lower
    // → balance went negative without any refund. Fix: pending points aren't spendable.
    const l = new Ledger();
    l.apply(card("p1", 100, "pending")); // authorized 1.00 €
    expect(l.balance(t0)).toBe(0); // not spendable yet
    expect(() => l.apply({ type: "spend", points: 1, at: t0 })).toThrow();
    l.apply(card("p1", 100, "booked"));
    expect(l.balance(t0)).toBe(1); // spendable once settled
  });

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

  it("balance is forfeited exactly at the 180-day boundary", () => {
    const l = new Ledger();
    l.apply(receipt("p1", 10000));
    expect(l.balance(at(EXPIRY_DAYS))).toBe(0);
    expect(l.forfeitedPoints(at(EXPIRY_DAYS))).toBe(100);
  });

  it("any activity resets the inactivity clock", () => {
    const l = new Ledger();
    l.apply(receipt("p1", 10000));
    l.apply({ type: "spend", points: 1, at: at(100) }); // activity on day 100
    expect(l.balance(at(EXPIRY_DAYS + 50))).toBe(99); // 180 days from day 100 not yet reached
    expect(l.balance(at(100 + EXPIRY_DAYS))).toBe(0); // ...but day 280 is
  });

  it("forfeiture is permanent — the old balance does not come back", () => {
    const l = new Ledger();
    l.apply(receipt("p1", 10000));
    expect(l.balance(at(EXPIRY_DAYS + 10))).toBe(0);
    expect(l.forfeitedPoints(at(EXPIRY_DAYS + 10))).toBe(100);
  });

  it("REGRESSION: a returning user can earn again after expiry (account must not brick)", () => {
    // Found by critical review, missed by the original suite: the first implementation
    // used a permanent `expired` flag, so a user who came back on day 181 could scan
    // receipts forever and always see balance 0. Expiry must forfeit the old balance,
    // not disable the account.
    const l = new Ledger();
    l.apply(receipt("p1", 10000));
    expect(l.balance(at(EXPIRY_DAYS + 1))).toBe(0); // old 100 points forfeited
    l.apply(receipt("p2", 2500, at(EXPIRY_DAYS + 1))); // returning user scans a receipt
    expect(l.balance(at(EXPIRY_DAYS + 1))).toBe(25); // new points credit normally
    expect(l.forfeitedPoints(at(EXPIRY_DAYS + 1))).toBe(100);
  });

  it("repeated inactivity gaps forfeit repeatedly", () => {
    const l = new Ledger();
    l.apply(receipt("p1", 10000));
    l.apply(receipt("p2", 5000, at(EXPIRY_DAYS + 10))); // return after first forfeiture
    // second gap: no activity for another 180 days after day EXPIRY_DAYS+10
    expect(l.balance(at(EXPIRY_DAYS + 10 + EXPIRY_DAYS))).toBe(0);
    expect(l.forfeitedPoints(at(EXPIRY_DAYS + 10 + EXPIRY_DAYS))).toBe(150);
  });

  it("refunds do NOT count as activity (user did nothing)", () => {
    const l = new Ledger();
    l.apply(receipt("p1", 10000));
    l.apply(receipt("p2", 1000));
    l.apply({ type: "refund", purchaseId: "p2", at: at(179) }); // merchant-side event
    expect(l.balance(at(EXPIRY_DAYS))).toBe(0); // still forfeits on day 180
  });
});
