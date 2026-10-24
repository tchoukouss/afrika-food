-- CreateEnum
CREATE TYPE "InvoiceSource" AS ENUM ('ORDER', 'SALE', 'MANUAL');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'DISPUTED', 'CANCELLED');


-- DropForeignKey
ALTER TABLE "customer_refunds" DROP CONSTRAINT "customer_refunds_deposit_id_fkey";

-- AlterTable
ALTER TABLE "payment_allocations" ADD COLUMN     "invoice_id" UUID;

-- AlterTable
ALTER TABLE "customer_refunds" ADD COLUMN     "credit_note_id" UUID,
ALTER COLUMN "deposit_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "number" TEXT,
    "client_request_id" UUID,
    "source" "InvoiceSource" NOT NULL,
    "order_id" UUID,
    "sale_id" UUID,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "total" BIGINT NOT NULL,
    "tax_total" BIGINT NOT NULL,
    "pos_paid_amount" BIGINT NOT NULL DEFAULT 0,
    "payment_term_days" INTEGER,
    "issued_at" TIMESTAMPTZ(3),
    "issued_by_id" UUID,
    "due_date" DATE,
    "notes" TEXT,
    "disputed_at" TIMESTAMPTZ(3),
    "dispute_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "cancel_reason" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "DocumentLineKind" NOT NULL,
    "product_id" UUID,
    "product_code" TEXT,
    "label" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_price" BIGINT NOT NULL,
    "tax_rate" DECIMAL(5,2) NOT NULL,
    "line_total" BIGINT NOT NULL,
    "tax_amount" BIGINT NOT NULL,
    "note" TEXT,
    "order_line_id" UUID,
    "sale_item_id" UUID,
    "delivery_id" UUID,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_notes" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "client_request_id" UUID,
    "total" BIGINT NOT NULL,
    "tax_total" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "reduced_due" BIGINT NOT NULL,
    "customer_credit" BIGINT NOT NULL,
    "refund_amount" BIGINT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_note_lines" (
    "id" UUID NOT NULL,
    "credit_note_id" UUID NOT NULL,
    "invoice_line_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "quantity" DECIMAL(18,4),
    "amount" BIGINT NOT NULL,
    "tax_rate" DECIMAL(5,2) NOT NULL,
    "tax_amount" BIGINT NOT NULL,

    CONSTRAINT "credit_note_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoices_customer_id_idx" ON "invoices"("customer_id");

-- CreateIndex
CREATE INDEX "invoices_establishment_id_status_idx" ON "invoices"("establishment_id", "status");

-- CreateIndex
CREATE INDEX "invoices_order_id_idx" ON "invoices"("order_id");

-- CreateIndex
CREATE INDEX "invoices_sale_id_idx" ON "invoices"("sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_company_id_number_key" ON "invoices"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_company_id_client_request_id_key" ON "invoices"("company_id", "client_request_id");

-- CreateIndex
CREATE INDEX "invoice_lines_invoice_id_idx" ON "invoice_lines"("invoice_id");

-- CreateIndex
CREATE INDEX "credit_notes_invoice_id_idx" ON "credit_notes"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_company_id_number_key" ON "credit_notes"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "credit_notes_company_id_client_request_id_key" ON "credit_notes"("company_id", "client_request_id");

-- CreateIndex
CREATE INDEX "credit_note_lines_credit_note_id_idx" ON "credit_note_lines"("credit_note_id");

-- CreateIndex
CREATE INDEX "credit_note_lines_invoice_line_id_idx" ON "credit_note_lines"("invoice_line_id");

-- CreateIndex
CREATE INDEX "payment_allocations_invoice_id_idx" ON "payment_allocations"("invoice_id");

-- CreateIndex
CREATE INDEX "customer_refunds_credit_note_id_idx" ON "customer_refunds"("credit_note_id");

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_refunds" ADD CONSTRAINT "customer_refunds_deposit_id_fkey" FOREIGN KEY ("deposit_id") REFERENCES "deposits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_refunds" ADD CONSTRAINT "customer_refunds_credit_note_id_fkey" FOREIGN KEY ("credit_note_id") REFERENCES "credit_notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "customer_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_credit_note_id_fkey" FOREIGN KEY ("credit_note_id") REFERENCES "credit_notes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_invoice_line_id_fkey" FOREIGN KEY ("invoice_line_id") REFERENCES "invoice_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Compléments manuels du module 7, étape 5 (non exprimables dans le schéma Prisma).
-- ===========================================================================

-- Clés étrangères vers les tables des modules 1, 2 et 5.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id");
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_establishment_fk" FOREIGN KEY ("establishment_id") REFERENCES "establishments"("id");
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_sale_fk" FOREIGN KEY ("sale_id") REFERENCES "sales"("id");
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id");
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issued_by_fk" FOREIGN KEY ("issued_by_id") REFERENCES "users"("id");
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_cancelled_by_fk" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id");
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_product_fk" FOREIGN KEY ("product_id") REFERENCES "products"("id");
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_order_line_fk" FOREIGN KEY ("order_line_id") REFERENCES "customer_order_lines"("id");
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_sale_item_fk" FOREIGN KEY ("sale_item_id") REFERENCES "sale_items"("id");
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_delivery_fk" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id");
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_company_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id");
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_establishment_fk" FOREIGN KEY ("establishment_id") REFERENCES "establishments"("id");
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_customer_fk" FOREIGN KEY ("customer_id") REFERENCES "customers"("id");
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id");

-- Cohérence des factures : numéro à l'émission seulement, origine unique, états enregistrés.
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_chk"
  CHECK ("total" >= 0 AND "tax_total" >= 0 AND "tax_total" <= "total"
         AND "pos_paid_amount" >= 0 AND "pos_paid_amount" <= "total"
         AND (("number" IS NULL) = ("issued_at" IS NULL))
         AND ("status" <> 'DRAFT' OR "number" IS NULL)
         AND ("status" NOT IN ('ISSUED', 'DISPUTED') OR ("number" IS NOT NULL AND "due_date" IS NOT NULL AND "payment_term_days" IS NOT NULL))
         AND (("source" = 'ORDER') = ("order_id" IS NOT NULL))
         AND (("source" = 'SALE') = ("sale_id" IS NOT NULL))
         AND ("source" = 'SALE' OR "pos_paid_amount" = 0)
         AND ("status" <> 'DISPUTED' OR "dispute_reason" IS NOT NULL)
         AND (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL AND "cancel_reason" IS NOT NULL)));
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_chk"
  CHECK ("quantity" > 0 AND "unit_price" >= 0 AND "line_total" >= 0 AND "tax_amount" >= 0 AND "tax_amount" <= "line_total"
         AND "tax_rate" >= 0 AND "tax_rate" <= 100 AND length(trim("label")) > 0
         AND (("kind" = 'PRODUCT') = ("product_id" IS NOT NULL)));
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_chk"
  CHECK ("total" > 0 AND "tax_total" >= 0 AND "tax_total" <= "total" AND length(trim("reason")) >= 3
         AND "reduced_due" >= 0 AND "customer_credit" >= 0 AND "refund_amount" >= 0
         AND "reduced_due" + "customer_credit" + "refund_amount" = "total");
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_chk"
  CHECK ("amount" > 0 AND "tax_amount" >= 0 AND "tax_amount" <= "amount" AND ("quantity" IS NULL OR "quantity" > 0));

-- Une seule facture par ticket (un brouillon abandonné ne compte pas) ; une seule facture en cours par commande.
CREATE UNIQUE INDEX "invoices_one_per_sale" ON "invoices" ("sale_id")
  WHERE "sale_id" IS NOT NULL AND ("status" <> 'CANCELLED' OR "number" IS NOT NULL);
CREATE UNIQUE INDEX "invoices_one_active_per_order" ON "invoices" ("order_id")
  WHERE "order_id" IS NOT NULL AND "status" IN ('DRAFT', 'ISSUED', 'DISPUTED');

-- Répartitions : acompte financé, ou facture (avec l'acompte d'origine éventuel).
ALTER TABLE "payment_allocations" DROP CONSTRAINT "payment_allocations_chk";
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_chk"
  CHECK ("amount" > 0
         AND (("target" = 'DEPOSIT') = ("invoice_id" IS NULL))
         AND ("target" <> 'DEPOSIT' OR "deposit_id" IS NOT NULL)
         AND (("released_at" IS NULL) = ("release_reason" IS NULL)));

-- Remboursement : d'un acompte ou d'un avoir, jamais des deux.
ALTER TABLE "customer_refunds" DROP CONSTRAINT "customer_refunds_chk";
ALTER TABLE "customer_refunds" ADD CONSTRAINT "customer_refunds_chk"
  CHECK ("amount" > 0 AND length(trim("reason")) >= 3
         AND (("deposit_id" IS NULL) <> ("credit_note_id" IS NULL))
         AND (("method" IN ('BANK_TRANSFER', 'CHEQUE')) = ("session_id" IS NULL))
         AND (("session_id" IS NULL) = ("cash_movement_id" IS NULL)));

-- Dernier rempart : répartitions actives jamais au-delà du paiement, de l'acompte, ni de la facture
-- (montant déjà réglé à la caisse compris).
CREATE OR REPLACE FUNCTION payment_allocations_within() RETURNS trigger AS $$
DECLARE paid bigint; used bigint;
BEGIN
  SELECT amount INTO paid FROM customer_payments WHERE id = NEW.payment_id;
  SELECT coalesce(sum(amount), 0) INTO used FROM payment_allocations WHERE payment_id = NEW.payment_id AND released_at IS NULL;
  IF used > paid THEN
    RAISE EXCEPTION 'Repartition superieure au paiement (% > %)', used, paid;
  END IF;
  IF NEW.deposit_id IS NOT NULL THEN
    SELECT amount INTO paid FROM deposits WHERE id = NEW.deposit_id;
    SELECT coalesce(sum(amount), 0) INTO used FROM payment_allocations WHERE deposit_id = NEW.deposit_id AND released_at IS NULL;
    IF used > paid THEN
      RAISE EXCEPTION 'Repartition superieure a l acompte (% > %)', used, paid;
    END IF;
  END IF;
  IF NEW.invoice_id IS NOT NULL THEN
    SELECT total - pos_paid_amount INTO paid FROM invoices WHERE id = NEW.invoice_id;
    SELECT coalesce(sum(amount), 0) INTO used FROM payment_allocations WHERE invoice_id = NEW.invoice_id AND released_at IS NULL;
    IF used > paid THEN
      RAISE EXCEPTION 'Repartition superieure a la facture (% > %)', used, paid;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Avoirs : jamais au-delà de la facture, ni d'une ligne.
CREATE OR REPLACE FUNCTION credit_notes_within() RETURNS trigger AS $$
DECLARE cap bigint; used bigint;
BEGIN
  IF TG_TABLE_NAME = 'credit_notes' THEN
    SELECT total INTO cap FROM invoices WHERE id = NEW.invoice_id;
    SELECT coalesce(sum(total), 0) INTO used FROM credit_notes WHERE invoice_id = NEW.invoice_id;
  ELSE
    SELECT line_total INTO cap FROM invoice_lines WHERE id = NEW.invoice_line_id;
    SELECT coalesce(sum(amount), 0) INTO used FROM credit_note_lines WHERE invoice_line_id = NEW.invoice_line_id;
  END IF;
  IF used > cap THEN
    RAISE EXCEPTION 'Avoir superieur au montant corrigeable (% > %)', used, cap;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER credit_notes_within AFTER INSERT ON "credit_notes"
  FOR EACH ROW EXECUTE FUNCTION credit_notes_within();
CREATE TRIGGER credit_note_lines_within AFTER INSERT ON "credit_note_lines"
  FOR EACH ROW EXECUTE FUNCTION credit_notes_within();

-- Facture émise : seules les colonnes d'état changent ; lignes figées ; rien ne se supprime.
CREATE TRIGGER invoices_guard BEFORE UPDATE OR DELETE ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION m7_frozen_after_draft('status', 'disputed_at', 'dispute_reason', 'cancelled_at', 'cancelled_by_id', 'cancel_reason', 'updated_at');
CREATE TRIGGER invoice_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "invoice_lines"
  FOR EACH ROW EXECUTE FUNCTION m7_lines_guard('invoices', 'invoice_id');
CREATE TRIGGER credit_notes_append_only BEFORE UPDATE OR DELETE ON "credit_notes"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER credit_note_lines_append_only BEFORE UPDATE OR DELETE ON "credit_note_lines"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

-- Module 5 : un ticket facturé ne s'annule ni ne se rembourse plus en caisse
-- (correction par avoir, décision D3) : aucun double remboursement possible.
CREATE OR REPLACE FUNCTION sale_returns_not_invoiced() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM invoices WHERE sale_id = NEW.sale_id AND number IS NOT NULL) THEN
    RAISE EXCEPTION 'Ticket facture : correction par avoir uniquement';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER sale_returns_not_invoiced BEFORE INSERT ON "sale_returns"
  FOR EACH ROW EXECUTE FUNCTION sale_returns_not_invoiced();
