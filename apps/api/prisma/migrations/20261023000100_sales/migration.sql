-- Module 5 — Caisse & ventes.
-- CreateEnum
CREATE TYPE "PrinterType" AS ENUM ('NETWORK', 'BROWSER', 'NONE');

-- CreateEnum
CREATE TYPE "CashSessionStatus" AS ENUM ('OPEN', 'CLOSED', 'VALIDATED');

-- CreateEnum
CREATE TYPE "CashMovementType" AS ENUM ('OPENING_FLOAT', 'SALE', 'SALE_CANCEL', 'REFUND', 'MANUAL_IN', 'MANUAL_OUT');

-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('COMPLETED', 'CANCELLED', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "SaleReturnKind" AS ENUM ('CANCEL', 'REFUND');

-- CreateEnum
CREATE TYPE "ReturnDisposition" AS ENUM ('RESTOCK', 'LOSS');

-- CreateEnum
CREATE TYPE "PrintJobKind" AS ENUM ('TICKET', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "PrintJobStatus" AS ENUM ('PENDING', 'PRINTED', 'BROWSER', 'FAILED');

-- CreateTable
CREATE TABLE "cash_registers" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stock_location_id" UUID NOT NULL,
    "printer_type" "PrinterType" NOT NULL DEFAULT 'BROWSER',
    "printer_host" TEXT,
    "printer_port" INTEGER NOT NULL DEFAULT 9100,
    "paper_width" INTEGER NOT NULL DEFAULT 80,
    "auto_print" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cash_registers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_sessions" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "register_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "client_request_id" UUID,
    "cashier_id" UUID NOT NULL,
    "status" "CashSessionStatus" NOT NULL DEFAULT 'OPEN',
    "opening_float" BIGINT NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),
    "closing_note" TEXT,
    "validated_by_id" UUID,
    "validated_at" TIMESTAMPTZ(3),
    "validation_note" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cash_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_movements" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "type" "CashMovementType" NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" BIGINT NOT NULL,
    "reason" TEXT,
    "sale_id" UUID,
    "return_id" UUID,
    "client_request_id" UUID,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_closures" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "expected" BIGINT NOT NULL,
    "counted" BIGINT NOT NULL,
    "difference" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_closures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "register_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "client_request_id" UUID,
    "status" "SaleStatus" NOT NULL DEFAULT 'COMPLETED',
    "cashier_id" UUID NOT NULL,
    "gross_total" BIGINT NOT NULL,
    "line_discount_total" BIGINT NOT NULL,
    "ticket_discount_amount" BIGINT NOT NULL,
    "ticket_discount_reason" TEXT,
    "total" BIGINT NOT NULL,
    "tax_total" BIGINT NOT NULL,
    "paid_total" BIGINT NOT NULL,
    "change_given" BIGINT NOT NULL,
    "cost_total" DECIMAL(18,2) NOT NULL,
    "refunded_total" BIGINT NOT NULL DEFAULT 0,
    "cancelled_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_items" (
    "id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "product_id" UUID NOT NULL,
    "product_code" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "is_menu" BOOLEAN NOT NULL DEFAULT false,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_price" BIGINT NOT NULL,
    "gross_amount" BIGINT NOT NULL,
    "discount_percent" DECIMAL(5,2),
    "line_discount" BIGINT NOT NULL DEFAULT 0,
    "discount_reason" TEXT,
    "ticket_discount" BIGINT NOT NULL DEFAULT 0,
    "line_total" BIGINT NOT NULL,
    "tax_rate" DECIMAL(5,2) NOT NULL,
    "tax_amount" BIGINT NOT NULL,
    "cost_total" DECIMAL(18,2) NOT NULL,
    "refunded_quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,

    CONSTRAINT "sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_item_lots" (
    "id" UUID NOT NULL,
    "sale_item_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_cost" DECIMAL(18,4) NOT NULL,
    "returned_quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,

    CONSTRAINT "sale_item_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_payments" (
    "id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" BIGINT NOT NULL,
    "reference" TEXT,
    "provider" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_returns" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "client_request_id" UUID,
    "kind" "SaleReturnKind" NOT NULL,
    "method" "PaymentMethod",
    "total" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_return_items" (
    "id" UUID NOT NULL,
    "return_id" UUID NOT NULL,
    "sale_item_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "amount" BIGINT NOT NULL,
    "disposition" "ReturnDisposition" NOT NULL,

    CONSTRAINT "sale_return_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_return_lots" (
    "id" UUID NOT NULL,
    "return_item_id" UUID NOT NULL,
    "sale_item_lot_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "disposition" "ReturnDisposition" NOT NULL,
    "stock_loss_id" UUID,

    CONSTRAINT "sale_return_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "print_jobs" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "register_id" UUID,
    "sale_id" UUID NOT NULL,
    "kind" "PrintJobKind" NOT NULL,
    "status" "PrintJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "requested_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "printed_at" TIMESTAMPTZ(3),

    CONSTRAINT "print_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cash_registers_establishment_id_code_key" ON "cash_registers"("establishment_id", "code");

-- CreateIndex
CREATE INDEX "cash_sessions_establishment_id_status_idx" ON "cash_sessions"("establishment_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "cash_sessions_company_id_number_key" ON "cash_sessions"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "cash_sessions_company_id_client_request_id_key" ON "cash_sessions"("company_id", "client_request_id");

-- CreateIndex
CREATE INDEX "cash_movements_session_id_idx" ON "cash_movements"("session_id");

-- CreateIndex
CREATE INDEX "cash_movements_sale_id_idx" ON "cash_movements"("sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_movements_company_id_client_request_id_key" ON "cash_movements"("company_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_closures_session_id_method_key" ON "cash_closures"("session_id", "method");

-- CreateIndex
CREATE INDEX "sales_establishment_id_created_at_idx" ON "sales"("establishment_id", "created_at");

-- CreateIndex
CREATE INDEX "sales_session_id_idx" ON "sales"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_company_id_number_key" ON "sales"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "sales_company_id_client_request_id_key" ON "sales"("company_id", "client_request_id");

-- CreateIndex
CREATE INDEX "sale_items_sale_id_idx" ON "sale_items"("sale_id");

-- CreateIndex
CREATE INDEX "sale_items_product_id_idx" ON "sale_items"("product_id");

-- CreateIndex
CREATE INDEX "sale_item_lots_sale_item_id_idx" ON "sale_item_lots"("sale_item_id");

-- CreateIndex
CREATE INDEX "sale_item_lots_lot_id_idx" ON "sale_item_lots"("lot_id");

-- CreateIndex
CREATE INDEX "sale_payments_sale_id_idx" ON "sale_payments"("sale_id");

-- CreateIndex
CREATE INDEX "sale_returns_sale_id_idx" ON "sale_returns"("sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_returns_company_id_number_key" ON "sale_returns"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "sale_returns_company_id_client_request_id_key" ON "sale_returns"("company_id", "client_request_id");

-- CreateIndex
CREATE INDEX "sale_return_items_return_id_idx" ON "sale_return_items"("return_id");

-- CreateIndex
CREATE INDEX "sale_return_lots_return_item_id_idx" ON "sale_return_lots"("return_item_id");

-- CreateIndex
CREATE INDEX "sale_return_lots_lot_id_idx" ON "sale_return_lots"("lot_id");

-- CreateIndex
CREATE INDEX "print_jobs_sale_id_idx" ON "print_jobs"("sale_id");

-- AddForeignKey
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_register_id_fkey" FOREIGN KEY ("register_id") REFERENCES "cash_registers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "cash_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_closures" ADD CONSTRAINT "cash_closures_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "cash_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_item_lots" ADD CONSTRAINT "sale_item_lots_sale_item_id_fkey" FOREIGN KEY ("sale_item_id") REFERENCES "sale_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "sale_returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_return_lots" ADD CONSTRAINT "sale_return_lots_return_item_id_fkey" FOREIGN KEY ("return_item_id") REFERENCES "sale_return_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- Compléments manuels du module 5 (non exprimables dans le schéma Prisma).
-- ===========================================================================

-- Clés étrangères vers les tables des modules 1, 2 et 3.
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_company_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id");
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_establishment_fk" FOREIGN KEY ("establishment_id") REFERENCES "establishments"("id");
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_location_fk" FOREIGN KEY ("stock_location_id") REFERENCES "stock_locations"("id");

ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_company_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id");
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_establishment_fk" FOREIGN KEY ("establishment_id") REFERENCES "establishments"("id");
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_cashier_fk" FOREIGN KEY ("cashier_id") REFERENCES "users"("id");
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_validated_by_fk" FOREIGN KEY ("validated_by_id") REFERENCES "users"("id");

ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_company_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id");
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_establishment_fk" FOREIGN KEY ("establishment_id") REFERENCES "establishments"("id");
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_sale_fk" FOREIGN KEY ("sale_id") REFERENCES "sales"("id");
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_return_fk" FOREIGN KEY ("return_id") REFERENCES "sale_returns"("id");
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");

ALTER TABLE "sales" ADD CONSTRAINT "sales_company_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id");
ALTER TABLE "sales" ADD CONSTRAINT "sales_establishment_fk" FOREIGN KEY ("establishment_id") REFERENCES "establishments"("id");
ALTER TABLE "sales" ADD CONSTRAINT "sales_register_fk" FOREIGN KEY ("register_id") REFERENCES "cash_registers"("id");
ALTER TABLE "sales" ADD CONSTRAINT "sales_session_fk" FOREIGN KEY ("session_id") REFERENCES "cash_sessions"("id");
ALTER TABLE "sales" ADD CONSTRAINT "sales_cashier_fk" FOREIGN KEY ("cashier_id") REFERENCES "users"("id");
ALTER TABLE "sales" ADD CONSTRAINT "sales_cancelled_by_fk" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id");
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_product_fk" FOREIGN KEY ("product_id") REFERENCES "products"("id");
ALTER TABLE "sale_item_lots" ADD CONSTRAINT "sale_item_lots_product_fk" FOREIGN KEY ("product_id") REFERENCES "products"("id");
ALTER TABLE "sale_item_lots" ADD CONSTRAINT "sale_item_lots_lot_fk" FOREIGN KEY ("lot_id") REFERENCES "stock_lots"("id");
ALTER TABLE "sale_item_lots" ADD CONSTRAINT "sale_item_lots_location_fk" FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id");

ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_company_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id");
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_establishment_fk" FOREIGN KEY ("establishment_id") REFERENCES "establishments"("id");
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_session_fk" FOREIGN KEY ("session_id") REFERENCES "cash_sessions"("id");
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id");
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_sale_item_fk" FOREIGN KEY ("sale_item_id") REFERENCES "sale_items"("id");
ALTER TABLE "sale_return_lots" ADD CONSTRAINT "sale_return_lots_sale_item_lot_fk" FOREIGN KEY ("sale_item_lot_id") REFERENCES "sale_item_lots"("id");
ALTER TABLE "sale_return_lots" ADD CONSTRAINT "sale_return_lots_product_fk" FOREIGN KEY ("product_id") REFERENCES "products"("id");
ALTER TABLE "sale_return_lots" ADD CONSTRAINT "sale_return_lots_lot_fk" FOREIGN KEY ("lot_id") REFERENCES "stock_lots"("id");
ALTER TABLE "sale_return_lots" ADD CONSTRAINT "sale_return_lots_location_fk" FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id");
ALTER TABLE "sale_return_lots" ADD CONSTRAINT "sale_return_lots_stock_loss_fk" FOREIGN KEY ("stock_loss_id") REFERENCES "stock_losses"("id");

ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_company_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id");
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_establishment_fk" FOREIGN KEY ("establishment_id") REFERENCES "establishments"("id");
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_register_fk" FOREIGN KEY ("register_id") REFERENCES "cash_registers"("id");
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_requested_by_fk" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id");

-- Cohérence des données.
ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_chk"
  CHECK ("paper_width" IN (58, 80) AND "printer_port" BETWEEN 1 AND 65535
         AND ("printer_type" <> 'NETWORK' OR "printer_host" IS NOT NULL));
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_chk"
  CHECK ("opening_float" >= 0 AND (("status" = 'OPEN') = ("closed_at" IS NULL))
         AND (("status" = 'VALIDATED') = ("validated_at" IS NOT NULL)));
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_chk"
  CHECK ("amount" <> 0
         AND (("type" IN ('OPENING_FLOAT', 'SALE', 'MANUAL_IN')) = ("amount" > 0))
         AND ("type" NOT IN ('MANUAL_IN', 'MANUAL_OUT') OR "reason" IS NOT NULL)
         AND ("type" NOT IN ('SALE', 'SALE_CANCEL', 'REFUND') OR "sale_id" IS NOT NULL));
ALTER TABLE "cash_closures" ADD CONSTRAINT "cash_closures_chk"
  CHECK ("counted" >= 0 AND "difference" = "counted" - "expected");
ALTER TABLE "sales" ADD CONSTRAINT "sales_chk"
  CHECK ("gross_total" >= 0 AND "line_discount_total" >= 0 AND "ticket_discount_amount" >= 0
         AND "total" = "gross_total" - "line_discount_total" - "ticket_discount_amount" AND "total" >= 0
         AND "tax_total" >= 0 AND "tax_total" <= "total"
         AND "paid_total" - "change_given" = "total" AND "change_given" >= 0
         AND "cost_total" >= 0 AND "refunded_total" >= 0 AND "refunded_total" <= "total"
         AND ("ticket_discount_amount" = 0 OR "ticket_discount_reason" IS NOT NULL)
         AND (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)));
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_chk"
  CHECK ("quantity" > 0 AND "unit_price" >= 0 AND "gross_amount" >= 0 AND "line_discount" >= 0
         AND "ticket_discount" >= 0 AND "line_total" = "gross_amount" - "line_discount" - "ticket_discount"
         AND "line_total" >= 0 AND "tax_amount" >= 0 AND "cost_total" >= 0
         AND "refunded_quantity" >= 0 AND "refunded_quantity" <= "quantity"
         AND ("line_discount" = 0 OR "discount_reason" IS NOT NULL));
ALTER TABLE "sale_item_lots" ADD CONSTRAINT "sale_item_lots_chk"
  CHECK ("quantity" > 0 AND "unit_cost" >= 0 AND "returned_quantity" >= 0 AND "returned_quantity" <= "quantity");
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_chk" CHECK ("amount" > 0);
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_chk" CHECK ("total" >= 0 AND length(trim("reason")) > 0);
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_chk" CHECK ("quantity" > 0 AND "amount" >= 0);
ALTER TABLE "sale_return_lots" ADD CONSTRAINT "sale_return_lots_chk"
  CHECK ("quantity" > 0 AND (("disposition" = 'LOSS') = ("stock_loss_id" IS NOT NULL)));
ALTER TABLE "print_jobs" ADD CONSTRAINT "print_jobs_chk" CHECK ("attempts" >= 0);

-- Une position par ligne de vente (ordre du ticket).
CREATE UNIQUE INDEX "sale_items_sale_id_position_key" ON "sale_items" ("sale_id", "position");

-- Une seule session ouverte par caisse et par caissier.
CREATE UNIQUE INDEX "cash_sessions_one_open_per_register" ON "cash_sessions" ("register_id") WHERE "status" = 'OPEN';
CREATE UNIQUE INDEX "cash_sessions_one_open_per_cashier" ON "cash_sessions" ("cashier_id") WHERE "status" = 'OPEN';

-- Mise à jour limitée aux colonnes passées en arguments du trigger ; suppression interdite.
CREATE OR REPLACE FUNCTION only_columns_update() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'La table % ne permet aucune suppression', TG_TABLE_NAME;
  END IF;
  IF (to_jsonb(NEW) - TG_ARGV) IS DISTINCT FROM (to_jsonb(OLD) - TG_ARGV) THEN
    RAISE EXCEPTION 'Table % : seules les colonnes % sont modifiables', TG_TABLE_NAME, array_to_string(TG_ARGV, ', ');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sales_guard BEFORE UPDATE OR DELETE ON "sales"
  FOR EACH ROW EXECUTE FUNCTION only_columns_update('status', 'refunded_total', 'cancelled_by_id', 'cancelled_at', 'cancel_reason');
CREATE TRIGGER sale_items_guard BEFORE UPDATE OR DELETE ON "sale_items"
  FOR EACH ROW EXECUTE FUNCTION only_columns_update('refunded_quantity');
CREATE TRIGGER sale_item_lots_guard BEFORE UPDATE OR DELETE ON "sale_item_lots"
  FOR EACH ROW EXECUTE FUNCTION only_columns_update('returned_quantity');
CREATE TRIGGER cash_sessions_guard BEFORE UPDATE OR DELETE ON "cash_sessions"
  FOR EACH ROW EXECUTE FUNCTION only_columns_update('status', 'closed_at', 'closing_note', 'validated_by_id', 'validated_at', 'validation_note', 'updated_at');
CREATE TRIGGER print_jobs_guard BEFORE UPDATE OR DELETE ON "print_jobs"
  FOR EACH ROW EXECUTE FUNCTION only_columns_update('status', 'attempts', 'last_error', 'printed_at');

-- Paiements, mouvements de caisse, clôtures et retours : en ajout seul.
CREATE TRIGGER sale_payments_append_only BEFORE UPDATE OR DELETE ON "sale_payments"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER cash_movements_append_only BEFORE UPDATE OR DELETE ON "cash_movements"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER cash_closures_append_only BEFORE UPDATE OR DELETE ON "cash_closures"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER sale_returns_append_only BEFORE UPDATE OR DELETE ON "sale_returns"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER sale_return_items_append_only BEFORE UPDATE OR DELETE ON "sale_return_items"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER sale_return_lots_append_only BEFORE UPDATE OR DELETE ON "sale_return_lots"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
-- Les caisses se désactivent, elles ne se suppriment pas.
CREATE TRIGGER cash_registers_no_delete BEFORE DELETE ON "cash_registers"
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
