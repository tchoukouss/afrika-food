-- CreateEnum
CREATE TYPE "CustomerPaymentStatus" AS ENUM ('RECORDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AllocationTarget" AS ENUM ('DEPOSIT');

-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('RECEIVED', 'CUSTOMER_CREDIT', 'REFUNDED', 'CANCELLED');

-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.



-- CreateTable
CREATE TABLE "customer_payments" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "client_request_id" UUID,
    "status" "CustomerPaymentStatus" NOT NULL DEFAULT 'RECORDED',
    "method" "PaymentMethod" NOT NULL,
    "amount" BIGINT NOT NULL,
    "reference" TEXT,
    "provider" TEXT NOT NULL,
    "session_id" UUID,
    "cash_movement_id" UUID,
    "reversal_movement_id" UUID,
    "notes" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "cancel_reason" TEXT,

    CONSTRAINT "customer_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "target" "AllocationTarget" NOT NULL,
    "deposit_id" UUID,
    "amount" BIGINT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ(3),
    "released_by_id" UUID,
    "release_reason" TEXT,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposits" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "order_id" UUID,
    "number" TEXT NOT NULL,
    "client_request_id" UUID,
    "status" "DepositStatus" NOT NULL DEFAULT 'RECEIVED',
    "amount" BIGINT NOT NULL,
    "refunded_amount" BIGINT NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "credited_at" TIMESTAMPTZ(3),
    "credit_reason" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "cancel_reason" TEXT,

    CONSTRAINT "deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_refunds" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "deposit_id" UUID NOT NULL,
    "client_request_id" UUID,
    "method" "PaymentMethod" NOT NULL,
    "amount" BIGINT NOT NULL,
    "reference" TEXT,
    "provider" TEXT NOT NULL,
    "session_id" UUID,
    "cash_movement_id" UUID,
    "reason" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_payments_cash_movement_id_key" ON "customer_payments"("cash_movement_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_payments_reversal_movement_id_key" ON "customer_payments"("reversal_movement_id");

-- CreateIndex
CREATE INDEX "customer_payments_customer_id_idx" ON "customer_payments"("customer_id");

-- CreateIndex
CREATE INDEX "customer_payments_establishment_id_created_at_idx" ON "customer_payments"("establishment_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "customer_payments_company_id_number_key" ON "customer_payments"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "customer_payments_company_id_client_request_id_key" ON "customer_payments"("company_id", "client_request_id");

-- CreateIndex
CREATE INDEX "payment_allocations_payment_id_idx" ON "payment_allocations"("payment_id");

-- CreateIndex
CREATE INDEX "payment_allocations_deposit_id_idx" ON "payment_allocations"("deposit_id");

-- CreateIndex
CREATE INDEX "deposits_customer_id_idx" ON "deposits"("customer_id");

-- CreateIndex
CREATE INDEX "deposits_order_id_idx" ON "deposits"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "deposits_company_id_number_key" ON "deposits"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "deposits_company_id_client_request_id_key" ON "deposits"("company_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_refunds_cash_movement_id_key" ON "customer_refunds"("cash_movement_id");

-- CreateIndex
CREATE INDEX "customer_refunds_deposit_id_idx" ON "customer_refunds"("deposit_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_refunds_company_id_client_request_id_key" ON "customer_refunds"("company_id", "client_request_id");

-- AddForeignKey
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "customer_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_deposit_id_fkey" FOREIGN KEY ("deposit_id") REFERENCES "deposits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "customer_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_refunds" ADD CONSTRAINT "customer_refunds_deposit_id_fkey" FOREIGN KEY ("deposit_id") REFERENCES "deposits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- Compléments manuels du module 7, étape 4 (non exprimables dans le schéma Prisma).
-- ===========================================================================

-- Module 5 : signe des nouveaux mouvements de caisse (paiement client > 0, remboursement < 0, motif obligatoire).
ALTER TABLE "cash_movements" DROP CONSTRAINT "cash_movements_chk";
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_chk"
  CHECK ("amount" <> 0
         AND (("type" IN ('OPENING_FLOAT', 'SALE', 'MANUAL_IN', 'CUSTOMER_PAYMENT')) = ("amount" > 0))
         AND ("type" NOT IN ('MANUAL_IN', 'MANUAL_OUT', 'CUSTOMER_REFUND') OR "reason" IS NOT NULL)
         AND ("type" NOT IN ('SALE', 'SALE_CANCEL', 'REFUND') OR "sale_id" IS NOT NULL));

-- Clés étrangères vers les tables des modules 1 et 5.
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_company_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id");
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_establishment_fk" FOREIGN KEY ("establishment_id") REFERENCES "establishments"("id");
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_session_fk" FOREIGN KEY ("session_id") REFERENCES "cash_sessions"("id");
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_movement_fk" FOREIGN KEY ("cash_movement_id") REFERENCES "cash_movements"("id");
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_reversal_fk" FOREIGN KEY ("reversal_movement_id") REFERENCES "cash_movements"("id");
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id");
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_cancelled_by_fk" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id");
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id");
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_released_by_fk" FOREIGN KEY ("released_by_id") REFERENCES "users"("id");
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_company_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id");
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_establishment_fk" FOREIGN KEY ("establishment_id") REFERENCES "establishments"("id");
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id");
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_cancelled_by_fk" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id");
ALTER TABLE "customer_refunds" ADD CONSTRAINT "customer_refunds_company_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id");
ALTER TABLE "customer_refunds" ADD CONSTRAINT "customer_refunds_establishment_fk" FOREIGN KEY ("establishment_id") REFERENCES "establishments"("id");
ALTER TABLE "customer_refunds" ADD CONSTRAINT "customer_refunds_customer_fk" FOREIGN KEY ("customer_id") REFERENCES "customers"("id");
ALTER TABLE "customer_refunds" ADD CONSTRAINT "customer_refunds_session_fk" FOREIGN KEY ("session_id") REFERENCES "cash_sessions"("id");
ALTER TABLE "customer_refunds" ADD CONSTRAINT "customer_refunds_movement_fk" FOREIGN KEY ("cash_movement_id") REFERENCES "cash_movements"("id");
ALTER TABLE "customer_refunds" ADD CONSTRAINT "customer_refunds_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id");

-- Cohérence : montants positifs ; caisse pour espèces, mobile money, carte et autre ; virement et chèque hors caisse.
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_chk"
  CHECK ("amount" > 0
         AND (("method" IN ('BANK_TRANSFER', 'CHEQUE')) = ("session_id" IS NULL))
         AND (("session_id" IS NULL) = ("cash_movement_id" IS NULL))
         AND (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL AND "cancel_reason" IS NOT NULL))
         AND ("reversal_movement_id" IS NULL OR "status" = 'CANCELLED'));
ALTER TABLE "customer_refunds" ADD CONSTRAINT "customer_refunds_chk"
  CHECK ("amount" > 0 AND length(trim("reason")) >= 3
         AND (("method" IN ('BANK_TRANSFER', 'CHEQUE')) = ("session_id" IS NULL))
         AND (("session_id" IS NULL) = ("cash_movement_id" IS NULL)));
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_chk"
  CHECK ("amount" > 0 AND (("target" = 'DEPOSIT') = ("deposit_id" IS NOT NULL))
         AND (("released_at" IS NULL) = ("release_reason" IS NULL)));
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_chk"
  CHECK ("amount" > 0 AND "refunded_amount" >= 0 AND "refunded_amount" <= "amount"
         AND (("status" = 'REFUNDED') = ("refunded_amount" = "amount"))
         AND (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL AND "cancel_reason" IS NOT NULL))
         AND ("status" <> 'CANCELLED' OR "refunded_amount" = 0)
         AND ("status" <> 'CUSTOMER_CREDIT' OR "credit_reason" IS NOT NULL));

-- Dernier rempart : la somme des répartitions actives ne dépasse jamais le paiement, ni l'acompte.
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
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER payment_allocations_within AFTER INSERT OR UPDATE ON "payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION payment_allocations_within();

-- Écritures financières : seules les colonnes d'état changent ; rien ne se supprime.
CREATE TRIGGER customer_payments_guard BEFORE UPDATE OR DELETE ON "customer_payments"
  FOR EACH ROW EXECUTE FUNCTION only_columns_update('status', 'reversal_movement_id', 'cancelled_at', 'cancelled_by_id', 'cancel_reason');
CREATE TRIGGER payment_allocations_guard BEFORE UPDATE OR DELETE ON "payment_allocations"
  FOR EACH ROW EXECUTE FUNCTION only_columns_update('released_at', 'released_by_id', 'release_reason');
CREATE TRIGGER deposits_guard BEFORE UPDATE OR DELETE ON "deposits"
  FOR EACH ROW EXECUTE FUNCTION only_columns_update('status', 'refunded_amount', 'updated_at', 'credited_at', 'credit_reason', 'cancelled_at', 'cancelled_by_id', 'cancel_reason');
CREATE TRIGGER customer_refunds_append_only BEFORE UPDATE OR DELETE ON "customer_refunds"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
