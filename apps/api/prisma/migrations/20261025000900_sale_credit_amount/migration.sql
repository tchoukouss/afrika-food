-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "credit_amount" BIGINT NOT NULL DEFAULT 0;

-- ===========================================================================
-- Vente à crédit (H1-a) : la part non encaissée d'un ticket est portée par le
-- ticket, jamais par un paiement ni un mouvement de caisse. Les ventes
-- existantes valent 0 : la contrainte reste exactement la même pour elles.
-- ===========================================================================
ALTER TABLE "sales" DROP CONSTRAINT "sales_chk";
ALTER TABLE "sales" ADD CONSTRAINT "sales_chk"
  CHECK ("gross_total" >= 0 AND "line_discount_total" >= 0 AND "ticket_discount_amount" >= 0
         AND "total" = "gross_total" - "line_discount_total" - "ticket_discount_amount" AND "total" >= 0
         AND "tax_total" >= 0 AND "tax_total" <= "total"
         AND "credit_amount" >= 0 AND "credit_amount" <= "total"
         AND "paid_total" - "change_given" + "credit_amount" = "total" AND "change_given" >= 0
         AND ("credit_amount" = 0 OR "change_given" = 0)
         AND "cost_total" >= 0 AND "refunded_total" >= 0 AND "refunded_total" <= "total"
         AND ("ticket_discount_amount" = 0 OR "ticket_discount_reason" IS NOT NULL)
         AND (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)));
