/**
 * A rewards-points ledger: the "money path" of a loyalty app.
 *
 * Rules implemented (typical of receipt-scanning / card-linked rewards products):
 *  - Points are earned from purchases, reported via RECEIPT scan and/or CARD transaction feed.
 *  - The same physical purchase must only be credited ONCE, however it is reported (dedup).
 *  - Card feeds report a purchase twice: first PENDING (authorized amount), later BOOKED
 *    (settled amount, which may differ). Only the booked amount may stand.
 *  - A refund claws back the points earned for that purchase.
 *  - Points expire after 180 days of account inactivity (any earn or spend counts as activity).
 *  - Spending never exceeds the available balance; balance never goes negative from spending.
 *
 * The implementation is deliberately small — it exists to be tested.
 */

export type PurchaseSource = "receipt" | "card";

export interface EarnEvent {
  type: "earn";
  /** Stable ID of the underlying purchase (e.g. merchant+datetime+total fingerprint). */
  purchaseId: string;
  source: PurchaseSource;
  /** Amount in cents; points = floor(amount / 100) (1 point per full euro). */
  amountCents: number;
  /** Card feed status; receipts are always "booked". */
  status?: "pending" | "booked";
  at: Date;
}

export interface SpendEvent {
  type: "spend";
  points: number;
  at: Date;
}

export interface RefundEvent {
  type: "refund";
  purchaseId: string;
  at: Date;
}

export type LedgerEvent = EarnEvent | SpendEvent | RefundEvent;

export const EXPIRY_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

interface PurchaseRecord {
  points: number;
  status: "pending" | "booked";
  refunded: boolean;
}

export class Ledger {
  private purchases = new Map<string, PurchaseRecord>();
  private spent = 0;
  private lastActivity: Date | null = null;
  private expired = false;

  /** Points from a purchase amount: 1 point per started euro is a classic off-by-one trap — we use full euros. */
  static pointsFor(amountCents: number): number {
    if (amountCents < 0) throw new Error("negative amount");
    return Math.floor(amountCents / 100);
  }

  apply(event: LedgerEvent): void {
    this.expireIfInactive(event.at);

    switch (event.type) {
      case "earn": {
        if (event.amountCents < 0) throw new Error("negative amount");
        const status = event.source === "receipt" ? "booked" : event.status ?? "pending";
        const existing = this.purchases.get(event.purchaseId);
        if (existing) {
          // Dedup: same purchase reported again (second receipt photo, receipt + card,
          // or card pending→booked). Never double-credit; booked overrides pending.
          if (existing.status === "pending" && status === "booked" && !existing.refunded) {
            existing.points = Ledger.pointsFor(event.amountCents); // settled amount wins
            existing.status = "booked";
          }
          // else: ignore duplicate report
        } else {
          this.purchases.set(event.purchaseId, {
            points: Ledger.pointsFor(event.amountCents),
            status,
            refunded: false,
          });
        }
        this.lastActivity = event.at;
        break;
      }
      case "spend": {
        if (event.points < 0) throw new Error("negative spend");
        if (event.points > this.balance(event.at)) throw new Error("insufficient balance");
        this.spent += event.points;
        this.lastActivity = event.at;
        break;
      }
      case "refund": {
        const rec = this.purchases.get(event.purchaseId);
        if (rec && !rec.refunded) {
          rec.refunded = true;
          // Claw-back may push the balance below zero if the points were already
          // spent — a business decision: the deficit reduces future earnings.
        }
        // Refund of an unknown purchase is ignored (feed replay safety).
        break;
      }
    }
  }

  /** Current balance as of `now` (expiry is evaluated lazily). */
  balance(now: Date): number {
    this.expireIfInactive(now);
    if (this.expired) return 0;
    let earned = 0;
    for (const rec of this.purchases.values()) {
      if (!rec.refunded) earned += rec.points;
    }
    return earned - this.spent;
  }

  private expireIfInactive(now: Date): void {
    if (this.expired || this.lastActivity === null) return;
    const inactiveMs = now.getTime() - this.lastActivity.getTime();
    if (inactiveMs >= EXPIRY_DAYS * DAY_MS) {
      // Full-balance expiry after 180 days of inactivity.
      this.expired = true;
    }
  }

  /** True if the whole balance has been expired for inactivity. */
  isExpired(now: Date): boolean {
    this.expireIfInactive(now);
    return this.expired;
  }
}
