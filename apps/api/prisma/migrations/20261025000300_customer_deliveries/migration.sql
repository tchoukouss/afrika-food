-- Module 7 — étape 3 : réservations, production à la demande, sorties de stock et livraisons.
-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('TO_PREPARE', 'READY', 'OUT', 'DELIVERED', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "quote_lines" ADD COLUMN     "made_to_order" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "customer_order_lines" ADD COLUMN     "made_to_order" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "customer_order_line_issues" (
    "id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "delivery_id" UUID,
    "product_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_cost" DECIMAL(18,4) NOT NULL,
    "value" DECIMAL(18,2) NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_order_line_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliveries" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "client_request_id" UUID,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'TO_PREPARE',
    "driver_id" UUID,
    "address" TEXT NOT NULL,
    "phone" TEXT,
    "scheduled_at" TIMESTAMPTZ(3),
    "fee" BIGINT NOT NULL DEFAULT 0,
    "fee_label" TEXT,
    "notes" TEXT,
    "failed_reason" TEXT,
    "cancel_reason" TEXT,
    "delivered_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_status_history" (
    "id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "from_status" "DeliveryStatus",
    "to_status" "DeliveryStatus" NOT NULL,
    "reason" TEXT,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_order_line_issues_line_id_idx" ON "customer_order_line_issues"("line_id");

-- CreateIndex
CREATE INDEX "customer_order_line_issues_lot_id_idx" ON "customer_order_line_issues"("lot_id");

-- CreateIndex
CREATE INDEX "deliveries_establishment_id_status_idx" ON "deliveries"("establishment_id", "status");

-- CreateIndex
CREATE INDEX "deliveries_driver_id_status_idx" ON "deliveries"("driver_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_company_id_number_key" ON "deliveries"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_company_id_client_request_id_key" ON "deliveries"("company_id", "client_request_id");

-- CreateIndex
CREATE INDEX "delivery_status_history_delivery_id_idx" ON "delivery_status_history"("delivery_id");

-- AddForeignKey
ALTER TABLE "customer_order_line_issues" ADD CONSTRAINT "customer_order_line_issues_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "customer_order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_order_line_issues" ADD CONSTRAINT "customer_order_line_issues_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "customer_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_status_history" ADD CONSTRAINT "delivery_status_history_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- Compléments manuels du module 7, étape 3 (non exprimables dans le schéma Prisma).
-- ===========================================================================

-- Clés étrangères vers les tables des modules 1 à 3.
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_company_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id");
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_establishment_fk" FOREIGN KEY ("establishment_id") REFERENCES "establishments"("id");
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_driver_fk" FOREIGN KEY ("driver_id") REFERENCES "users"("id");
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id");
ALTER TABLE "delivery_status_history" ADD CONSTRAINT "delivery_status_history_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
ALTER TABLE "customer_order_line_issues" ADD CONSTRAINT "customer_order_line_issues_product_fk" FOREIGN KEY ("product_id") REFERENCES "products"("id");
ALTER TABLE "customer_order_line_issues" ADD CONSTRAINT "customer_order_line_issues_lot_fk" FOREIGN KEY ("lot_id") REFERENCES "stock_lots"("id");
ALTER TABLE "customer_order_line_issues" ADD CONSTRAINT "customer_order_line_issues_location_fk" FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id");
ALTER TABLE "customer_order_line_issues" ADD CONSTRAINT "customer_order_line_issues_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id");

-- Cohérence des données.
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_made_to_order_chk" CHECK (NOT "made_to_order" OR "kind" = 'PRODUCT');
ALTER TABLE "customer_order_lines" ADD CONSTRAINT "customer_order_lines_made_to_order_chk"
  CHECK ((NOT "made_to_order" OR "kind" = 'PRODUCT') AND ("production_order_id" IS NULL OR "made_to_order"));
ALTER TABLE "customer_order_line_issues" ADD CONSTRAINT "customer_order_line_issues_chk" CHECK ("quantity" > 0 AND "unit_cost" >= 0 AND "value" >= 0);
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_chk"
  CHECK (length(trim("address")) >= 3 AND "fee" >= 0
         AND (("status" = 'FAILED') = ("failed_reason" IS NOT NULL))
         AND (("status" = 'CANCELLED') = ("cancel_reason" IS NOT NULL))
         AND (("status" = 'DELIVERED') = ("delivered_at" IS NOT NULL)));

-- Une seule livraison active par commande ; un ordre de production ne sert qu'une ligne.
CREATE UNIQUE INDEX "deliveries_one_active_per_order" ON "deliveries" ("order_id") WHERE "status" IN ('TO_PREPARE', 'READY', 'OUT');
CREATE UNIQUE INDEX "customer_order_lines_production_key" ON "customer_order_lines" ("production_order_id") WHERE "production_order_id" IS NOT NULL;

-- Une réservation ne change que par sa libération (déjà jamais supprimée).
CREATE TRIGGER order_reservations_guard BEFORE UPDATE ON "order_reservations"
  FOR EACH ROW EXECUTE FUNCTION only_columns_update('released_at');

-- Sorties, historique : en ajout seul ; une livraison ne se supprime jamais.
CREATE TRIGGER customer_order_line_issues_append_only BEFORE UPDATE OR DELETE ON "customer_order_line_issues"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER delivery_status_history_append_only BEFORE UPDATE OR DELETE ON "delivery_status_history"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER deliveries_no_delete BEFORE DELETE ON "deliveries"
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
