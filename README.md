# Testing the Money Path — a rewards-points ledger and its edge cases

Loyalty and rewards apps (receipt scanning, card-linked points, gift-card redemption) have an unusual QA profile: **the bugs that matter are rarely crashes — they're trust failures.** Points that don't arrive, purchases credited twice, balances that expire when they shouldn't. Each one is either leaked money for the business or a one-star review from the user.

This project is a deliberately small reference implementation of that "money path" — a points ledger — plus the test suite that tries to break it. The ledger is ~100 lines; the tests are the point.

## The edge cases under test

Derived from studying real rewards products and their public user complaints:

| Failure mode | Why it's commercially critical | Tests |
|---|---|---|
| **Same purchase credited twice** (receipt photo + card feed, or duplicate receipt submission) | Direct money leak; the #1 exploit surface when receipt scanning and card-linked feeds coexist | dedup suite + property test: *re-reporting any purchase never increases the balance* |
| **Pending vs. booked card amounts** (authorization ≠ settlement) | Double-crediting or wrong-amount points on every partial return | booked-overrides-pending tests |
| **Inactivity expiry boundaries** (e.g. 180 days) | Expiry logic touches *every* user's balance; off-by-one at the boundary = mass support tickets | millisecond-boundary tests, activity-clock reset, "refunds are not user activity" |
| **Refund claw-backs** | Refund feeds replay; claw-back must fire exactly once, even after points were spent | double-refund, unknown-purchase replay, deficit-carry-forward |
| **Rounding** (1 point per euro) | `round()` instead of `floor()` leaks points at scale | floor test on €19.99 |
| **Over-spend** | Balance must never go negative from spending alone | guard test + property test over random sequences |

## Two testing styles, on purpose

- **Example-based tests** (20) — each named for the business rule it protects, readable as a specification.
- **Property-based tests** (3, via fast-check, 1,000 runs each) — thousands of random earn/spend/refund sequences asserting invariants that must hold for *all* histories: re-reporting never increases balance; balance never exceeds booked earnings; spending alone never goes negative. This is how you find the edge case nobody thought to write an example for.

## Run it

```bash
npm install
npm test        # 23 tests
npx tsc --noEmit
```

Tests run in CI on every push.

## What 1,000 runs found that 100 didn't

Raising fast-check from its default 100 runs to 1,000 immediately surfaced a real bug: points earned from a *pending* card authorization could be spent before settlement — and when the booked amount came in lower, the balance went negative with no refund involved. fast-check shrank it to a minimal counterexample in 130 steps. The fix (pending points aren't spendable) is in the ledger, and the counterexample lives on as a named regression test. That's the whole argument for property-based testing in one commit.

## Honest scope

This is a study of *test design for rewards mechanics*, not a production ledger — there's no persistence, no concurrency, no currency handling. Those would each bring their own failure modes (idempotency keys, transactional writes, multi-currency rounding) and their own tests.

## Author

**Anna Sebedach** — [portfolio](https://anna-sebedach-portfolio.lovable.app/) · [GitHub](https://github.com/annasebedash-creator)
