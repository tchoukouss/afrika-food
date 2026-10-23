-- Module 6 — Restaurant & commandes.
-- CreateEnum
CREATE TYPE "TableState" AS ENUM ('AVAILABLE', 'CLEANING', 'OUT_OF_SERVICE');

-- CreateEnum
CREATE TYPE "StationKind" AS ENUM ('KITCHEN', 'BAR');

-- CreateEnum
CREATE TYPE "PreparationMode" AS ENUM ('TO_ORDER', 'FROM_STOCK');

-- CreateEnum
CREATE TYPE "RestaurantOrderMode" AS ENUM ('TABLE', 'COUNTER', 'TAKEAWAY', 'PHONE', 'ONLINE', 'DELIVERY');

-- CreateEnum
CREATE TYPE "RestaurantOrderStatus" AS ENUM ('OPEN', 'PAID', 'CANCELLED', 'MERGED');

-- CreateEnum
CREATE TYPE "RestaurantItemStatus" AS ENUM ('DRAFT', 'REMOVED', 'NEW', 'IN_PREPARATION', 'READY', 'SERVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderConsumptionKind" AS ENUM ('CONSUMED', 'RETURNED', 'LOST');

-- CreateEnum
CREATE TYPE "RestaurantBillStatus" AS ENUM ('OPEN', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('CONFIRMED', 'SEATED', 'NO_SHOW', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RestaurantPrintKind" AS ENUM ('KITCHEN', 'BILL');

-- CreateTable
CREATE TABLE "restaurant_areas" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "restaurant_areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_tables" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "area_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "state" "TableState" NOT NULL DEFAULT 'AVAILABLE',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "restaurant_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_stations" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "StationKind" NOT NULL,
    "stock_location_id" UUID NOT NULL,
    "printer_type" "PrinterType" NOT NULL DEFAULT 'NONE',
    "printer_host" TEXT,
    "printer_port" INTEGER NOT NULL DEFAULT 9100,
    "paper_width" INTEGER NOT NULL DEFAULT 80,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "restaurant_stations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_menu_items" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "preparation" "PreparationMode" NOT NULL DEFAULT 'FROM_STOCK',
    "station_id" UUID,
    "is_supplement" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "restaurant_menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_options" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_orders" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "client_request_id" UUID,
    "mode" "RestaurantOrderMode" NOT NULL,
    "table_id" UUID,
    "reservation_id" UUID,
    "covers" INTEGER,
    "customer_name" TEXT,
    "customer_phone" TEXT,
    "delivery_address" TEXT,
    "expected_at" TIMESTAMPTZ(3),
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "status" "RestaurantOrderStatus" NOT NULL DEFAULT 'OPEN',
    "waiter_id" UUID NOT NULL,
    "merged_into_id" UUID,
    "paid_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "restaurant_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "request_id" UUID,
    "product_id" UUID NOT NULL,
    "product_code" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "is_menu" BOOLEAN NOT NULL DEFAULT false,
    "unit_price" BIGINT NOT NULL,
    "tax_rate" DECIMAL(5,2) NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "note" TEXT,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "parent_item_id" UUID,
    "preparation" "PreparationMode" NOT NULL,
    "station_id" UUID,
    "status" "RestaurantItemStatus" NOT NULL DEFAULT 'DRAFT',
    "kitchen_ticket_id" UUID,
    "cancelled_quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "cost_total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "bill_id" UUID,
    "created_by_id" UUID NOT NULL,
    "sent_by_id" UUID,
    "sent_at" TIMESTAMPTZ(3),
    "status_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status_changed_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "restaurant_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_kitchen_tickets" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "station_id" UUID,
    "number" TEXT NOT NULL,
    "request_id" UUID,
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "sent_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_kitchen_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_consumptions" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "kind" "OrderConsumptionKind" NOT NULL,
    "raw_material_id" UUID,
    "product_id" UUID,
    "lot_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_cost" DECIMAL(18,4) NOT NULL,
    "value" DECIMAL(18,2) NOT NULL,
    "cancellation_id" UUID,
    "stock_loss_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_consumptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_item_cancellations" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "client_request_id" UUID,
    "item_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "outcome" "ReturnDisposition" NOT NULL,
    "loss_cause" "LossCause",
    "reason" TEXT NOT NULL,
    "status_at_cancel" "RestaurantItemStatus" NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_item_cancellations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_bills" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "client_request_id" UUID,
    "status" "RestaurantBillStatus" NOT NULL DEFAULT 'OPEN',
    "total" BIGINT NOT NULL,
    "print_count" INTEGER NOT NULL DEFAULT 0,
    "sale_id" UUID,
    "paid_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "restaurant_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_bill_items" (
    "id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_price" BIGINT NOT NULL,
    "amount" BIGINT NOT NULL,

    CONSTRAINT "restaurant_bill_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_reservations" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "client_request_id" UUID,
    "table_id" UUID,
    "reserved_at" TIMESTAMPTZ(3) NOT NULL,
    "covers" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "note" TEXT,
    "status" "ReservationStatus" NOT NULL DEFAULT 'CONFIRMED',
    "created_by_id" UUID NOT NULL,
    "status_changed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "restaurant_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_print_jobs" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "kind" "RestaurantPrintKind" NOT NULL,
    "kitchen_ticket_id" UUID,
    "bill_id" UUID,
    "station_id" UUID,
    "register_id" UUID,
    "status" "PrintJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "requested_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "printed_at" TIMESTAMPTZ(3),

    CONSTRAINT "restaurant_print_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_areas_establishment_id_name_key" ON "restaurant_areas"("establishment_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_tables_establishment_id_code_key" ON "restaurant_tables"("establishment_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_stations_establishment_id_name_key" ON "restaurant_stations"("establishment_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_menu_items_establishment_id_product_id_key" ON "restaurant_menu_items"("establishment_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_options_establishment_id_product_id_label_key" ON "restaurant_options"("establishment_id", "product_id", "label");

-- CreateIndex
CREATE INDEX "restaurant_orders_establishment_id_status_idx" ON "restaurant_orders"("establishment_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_orders_company_id_number_key" ON "restaurant_orders"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_orders_company_id_client_request_id_key" ON "restaurant_orders"("company_id", "client_request_id");

-- CreateIndex
CREATE INDEX "restaurant_order_items_order_id_idx" ON "restaurant_order_items"("order_id");

-- CreateIndex
CREATE INDEX "restaurant_order_items_kitchen_ticket_id_idx" ON "restaurant_order_items"("kitchen_ticket_id");

-- CreateIndex
CREATE INDEX "restaurant_order_items_bill_id_idx" ON "restaurant_order_items"("bill_id");

-- CreateIndex
CREATE INDEX "restaurant_kitchen_tickets_establishment_id_created_at_idx" ON "restaurant_kitchen_tickets"("establishment_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_kitchen_tickets_company_id_number_key" ON "restaurant_kitchen_tickets"("company_id", "number");

-- CreateIndex
CREATE INDEX "restaurant_consumptions_item_id_idx" ON "restaurant_consumptions"("item_id");

-- CreateIndex
CREATE INDEX "restaurant_consumptions_lot_id_idx" ON "restaurant_consumptions"("lot_id");

-- CreateIndex
CREATE INDEX "restaurant_item_cancellations_item_id_idx" ON "restaurant_item_cancellations"("item_id");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_item_cancellations_company_id_client_request_id_key" ON "restaurant_item_cancellations"("company_id", "client_request_id");

-- CreateIndex
CREATE INDEX "restaurant_bills_order_id_idx" ON "restaurant_bills"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_bills_company_id_number_key" ON "restaurant_bills"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_bills_company_id_client_request_id_key" ON "restaurant_bills"("company_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_bills_sale_id_key" ON "restaurant_bills"("sale_id");

-- CreateIndex
CREATE INDEX "restaurant_bill_items_bill_id_idx" ON "restaurant_bill_items"("bill_id");

-- CreateIndex
CREATE INDEX "restaurant_bill_items_item_id_idx" ON "restaurant_bill_items"("item_id");

-- CreateIndex
CREATE INDEX "restaurant_reservations_establishment_id_reserved_at_idx" ON "restaurant_reservations"("establishment_id", "reserved_at");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_reservations_company_id_client_request_id_key" ON "restaurant_reservations"("company_id", "client_request_id");

-- CreateIndex
CREATE INDEX "restaurant_print_jobs_kitchen_ticket_id_idx" ON "restaurant_print_jobs"("kitchen_ticket_id");

-- CreateIndex
CREATE INDEX "restaurant_print_jobs_bill_id_idx" ON "restaurant_print_jobs"("bill_id");

-- AddForeignKey
ALTER TABLE "restaurant_tables" ADD CONSTRAINT "restaurant_tables_area_id_fkey" FOREIGN KEY ("area_id") REFERENCES "restaurant_areas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_order_items" ADD CONSTRAINT "restaurant_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "restaurant_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_kitchen_tickets" ADD CONSTRAINT "restaurant_kitchen_tickets_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "restaurant_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_consumptions" ADD CONSTRAINT "restaurant_consumptions_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "restaurant_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_bills" ADD CONSTRAINT "restaurant_bills_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "restaurant_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_bill_items" ADD CONSTRAINT "restaurant_bill_items_bill_id_fkey" FOREIGN KEY ("bill_id") REFERENCES "restaurant_bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- Compléments manuels du module 6 (non exprimables dans le schéma Prisma).
-- ===========================================================================

-- Clés étrangères vers les tables des modules 1 à 5.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['restaurant_areas','restaurant_tables','restaurant_stations','restaurant_menu_items','restaurant_options',
    'restaurant_orders','restaurant_kitchen_tickets','restaurant_item_cancellations','restaurant_bills','restaurant_reservations','restaurant_print_jobs'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (company_id) REFERENCES companies(id)', t, t || '_company_fk');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (establishment_id) REFERENCES establishments(id)', t, t || '_establishment_fk');
  END LOOP;
END $$;

ALTER TABLE "restaurant_stations" ADD CONSTRAINT "restaurant_stations_location_fk" FOREIGN KEY ("stock_location_id") REFERENCES "stock_locations"("id");
ALTER TABLE "restaurant_menu_items" ADD CONSTRAINT "restaurant_menu_items_product_fk" FOREIGN KEY ("product_id") REFERENCES "products"("id");
ALTER TABLE "restaurant_menu_items" ADD CONSTRAINT "restaurant_menu_items_station_fk" FOREIGN KEY ("station_id") REFERENCES "restaurant_stations"("id");
ALTER TABLE "restaurant_options" ADD CONSTRAINT "restaurant_options_product_fk" FOREIGN KEY ("product_id") REFERENCES "products"("id");

ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_table_fk" FOREIGN KEY ("table_id") REFERENCES "restaurant_tables"("id");
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_reservation_fk" FOREIGN KEY ("reservation_id") REFERENCES "restaurant_reservations"("id");
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_waiter_fk" FOREIGN KEY ("waiter_id") REFERENCES "users"("id");
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_merged_into_fk" FOREIGN KEY ("merged_into_id") REFERENCES "restaurant_orders"("id");
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_cancelled_by_fk" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id");

ALTER TABLE "restaurant_order_items" ADD CONSTRAINT "restaurant_order_items_product_fk" FOREIGN KEY ("product_id") REFERENCES "products"("id");
ALTER TABLE "restaurant_order_items" ADD CONSTRAINT "restaurant_order_items_parent_fk" FOREIGN KEY ("parent_item_id") REFERENCES "restaurant_order_items"("id");
ALTER TABLE "restaurant_order_items" ADD CONSTRAINT "restaurant_order_items_station_fk" FOREIGN KEY ("station_id") REFERENCES "restaurant_stations"("id");
ALTER TABLE "restaurant_order_items" ADD CONSTRAINT "restaurant_order_items_ticket_fk" FOREIGN KEY ("kitchen_ticket_id") REFERENCES "restaurant_kitchen_tickets"("id");
ALTER TABLE "restaurant_order_items" ADD CONSTRAINT "restaurant_order_items_bill_fk" FOREIGN KEY ("bill_id") REFERENCES "restaurant_bills"("id");
ALTER TABLE "restaurant_order_items" ADD CONSTRAINT "restaurant_order_items_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id");
ALTER TABLE "restaurant_order_items" ADD CONSTRAINT "restaurant_order_items_sent_by_fk" FOREIGN KEY ("sent_by_id") REFERENCES "users"("id");
ALTER TABLE "restaurant_order_items" ADD CONSTRAINT "restaurant_order_items_status_by_fk" FOREIGN KEY ("status_changed_by_id") REFERENCES "users"("id");

ALTER TABLE "restaurant_kitchen_tickets" ADD CONSTRAINT "restaurant_kitchen_tickets_station_fk" FOREIGN KEY ("station_id") REFERENCES "restaurant_stations"("id");
ALTER TABLE "restaurant_kitchen_tickets" ADD CONSTRAINT "restaurant_kitchen_tickets_sent_by_fk" FOREIGN KEY ("sent_by_id") REFERENCES "users"("id");

ALTER TABLE "restaurant_consumptions" ADD CONSTRAINT "restaurant_consumptions_raw_material_fk" FOREIGN KEY ("raw_material_id") REFERENCES "raw_materials"("id");
ALTER TABLE "restaurant_consumptions" ADD CONSTRAINT "restaurant_consumptions_product_fk" FOREIGN KEY ("product_id") REFERENCES "products"("id");
ALTER TABLE "restaurant_consumptions" ADD CONSTRAINT "restaurant_consumptions_lot_fk" FOREIGN KEY ("lot_id") REFERENCES "stock_lots"("id");
ALTER TABLE "restaurant_consumptions" ADD CONSTRAINT "restaurant_consumptions_location_fk" FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id");
ALTER TABLE "restaurant_consumptions" ADD CONSTRAINT "restaurant_consumptions_cancellation_fk" FOREIGN KEY ("cancellation_id") REFERENCES "restaurant_item_cancellations"("id");
ALTER TABLE "restaurant_consumptions" ADD CONSTRAINT "restaurant_consumptions_stock_loss_fk" FOREIGN KEY ("stock_loss_id") REFERENCES "stock_losses"("id");

ALTER TABLE "restaurant_item_cancellations" ADD CONSTRAINT "restaurant_item_cancellations_item_fk" FOREIGN KEY ("item_id") REFERENCES "restaurant_order_items"("id");
ALTER TABLE "restaurant_item_cancellations" ADD CONSTRAINT "restaurant_item_cancellations_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id");

ALTER TABLE "restaurant_bills" ADD CONSTRAINT "restaurant_bills_sale_fk" FOREIGN KEY ("sale_id") REFERENCES "sales"("id");
ALTER TABLE "restaurant_bills" ADD CONSTRAINT "restaurant_bills_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id");
ALTER TABLE "restaurant_bills" ADD CONSTRAINT "restaurant_bills_cancelled_by_fk" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id");
ALTER TABLE "restaurant_bill_items" ADD CONSTRAINT "restaurant_bill_items_item_fk" FOREIGN KEY ("item_id") REFERENCES "restaurant_order_items"("id");

ALTER TABLE "restaurant_reservations" ADD CONSTRAINT "restaurant_reservations_table_fk" FOREIGN KEY ("table_id") REFERENCES "restaurant_tables"("id");
ALTER TABLE "restaurant_reservations" ADD CONSTRAINT "restaurant_reservations_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id");

ALTER TABLE "restaurant_print_jobs" ADD CONSTRAINT "restaurant_print_jobs_ticket_fk" FOREIGN KEY ("kitchen_ticket_id") REFERENCES "restaurant_kitchen_tickets"("id");
ALTER TABLE "restaurant_print_jobs" ADD CONSTRAINT "restaurant_print_jobs_bill_fk" FOREIGN KEY ("bill_id") REFERENCES "restaurant_bills"("id");
ALTER TABLE "restaurant_print_jobs" ADD CONSTRAINT "restaurant_print_jobs_station_fk" FOREIGN KEY ("station_id") REFERENCES "restaurant_stations"("id");
ALTER TABLE "restaurant_print_jobs" ADD CONSTRAINT "restaurant_print_jobs_register_fk" FOREIGN KEY ("register_id") REFERENCES "cash_registers"("id");
ALTER TABLE "restaurant_print_jobs" ADD CONSTRAINT "restaurant_print_jobs_requested_by_fk" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id");

-- Cohérence des données.
ALTER TABLE "restaurant_tables" ADD CONSTRAINT "restaurant_tables_chk" CHECK ("capacity" BETWEEN 1 AND 100);
ALTER TABLE "restaurant_stations" ADD CONSTRAINT "restaurant_stations_chk"
  CHECK ("paper_width" IN (58, 80) AND "printer_port" BETWEEN 1 AND 65535
         AND ("printer_type" <> 'NETWORK' OR "printer_host" IS NOT NULL));
ALTER TABLE "restaurant_options" ADD CONSTRAINT "restaurant_options_chk" CHECK (length(trim("label")) > 0);
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_chk"
  CHECK (("mode" = 'TABLE') = ("table_id" IS NOT NULL)
         AND ("covers" IS NULL OR "covers" BETWEEN 1 AND 500)
         AND (("status" = 'PAID') = ("paid_at" IS NOT NULL))
         AND (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL AND "cancel_reason" IS NOT NULL))
         AND (("status" = 'MERGED') = ("merged_into_id" IS NOT NULL)));
ALTER TABLE "restaurant_order_items" ADD CONSTRAINT "restaurant_order_items_chk"
  CHECK ("quantity" > 0 AND "unit_price" >= 0 AND "cost_total" >= 0
         AND "cancelled_quantity" >= 0 AND "cancelled_quantity" <= "quantity"
         AND (("status" IN ('DRAFT', 'REMOVED')) = ("sent_at" IS NULL))
         AND (("status" IN ('DRAFT', 'REMOVED')) = ("kitchen_ticket_id" IS NULL))
         AND ("status" <> 'CANCELLED' OR "cancelled_quantity" = "quantity")
         AND ("status" IN ('DRAFT', 'REMOVED', 'CANCELLED') OR "cancelled_quantity" < "quantity"));
ALTER TABLE "restaurant_consumptions" ADD CONSTRAINT "restaurant_consumptions_chk"
  CHECK ("quantity" > 0 AND "unit_cost" >= 0 AND "value" >= 0
         AND (("raw_material_id" IS NULL) <> ("product_id" IS NULL))
         AND (("kind" = 'LOST') = ("stock_loss_id" IS NOT NULL))
         AND (("kind" = 'CONSUMED') = ("cancellation_id" IS NULL)));
ALTER TABLE "restaurant_item_cancellations" ADD CONSTRAINT "restaurant_item_cancellations_chk"
  CHECK ("quantity" > 0 AND length(trim("reason")) >= 3 AND ("outcome" = 'RESTOCK' OR "loss_cause" IS NOT NULL));
ALTER TABLE "restaurant_bills" ADD CONSTRAINT "restaurant_bills_chk"
  CHECK ("total" >= 0 AND "print_count" >= 0
         AND ("status" <> 'PAID' OR ("paid_at" IS NOT NULL AND "sale_id" IS NOT NULL))
         AND ("status" <> 'OPEN' OR ("paid_at" IS NULL AND "sale_id" IS NULL)));
ALTER TABLE "restaurant_bill_items" ADD CONSTRAINT "restaurant_bill_items_chk" CHECK ("quantity" > 0 AND "unit_price" >= 0 AND "amount" >= 0);
ALTER TABLE "restaurant_reservations" ADD CONSTRAINT "restaurant_reservations_chk" CHECK ("covers" BETWEEN 1 AND 500 AND length(trim("name")) > 0);
ALTER TABLE "restaurant_print_jobs" ADD CONSTRAINT "restaurant_print_jobs_chk"
  CHECK ("attempts" >= 0 AND (("kind" = 'KITCHEN') = ("kitchen_ticket_id" IS NOT NULL)) AND (("kind" = 'BILL') = ("bill_id" IS NOT NULL)));

-- Une seule commande ouverte par table (décision R10).
CREATE UNIQUE INDEX "restaurant_orders_one_open_per_table" ON "restaurant_orders" ("table_id") WHERE "status" = 'OPEN' AND "table_id" IS NOT NULL;

-- Un article envoyé ne se modifie plus (annulation puis nouvelle saisie) ;
-- un article retiré ou annulé est définitif ; rien ne se supprime.
CREATE OR REPLACE FUNCTION restaurant_items_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Article de commande : suppression interdite';
  END IF;
  IF OLD.status IN ('REMOVED', 'CANCELLED') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'Article de commande retiré ou annulé : état définitif';
  END IF;
  IF OLD.status <> 'DRAFT' AND (
       NEW.status = 'DRAFT'
       OR NEW.product_id <> OLD.product_id OR NEW.unit_price <> OLD.unit_price OR NEW.tax_rate <> OLD.tax_rate
       OR NEW.quantity <> OLD.quantity OR NEW.note IS DISTINCT FROM OLD.note OR NEW.options <> OLD.options
       OR NEW.parent_item_id IS DISTINCT FROM OLD.parent_item_id OR NEW.preparation <> OLD.preparation
       OR NEW.kitchen_ticket_id IS DISTINCT FROM OLD.kitchen_ticket_id OR NEW.sent_at IS DISTINCT FROM OLD.sent_at) THEN
    RAISE EXCEPTION 'Article envoyé en cuisine : modification interdite (annulez-le puis ressaisissez-le)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER restaurant_order_items_guard BEFORE UPDATE OR DELETE ON "restaurant_order_items"
  FOR EACH ROW EXECUTE FUNCTION restaurant_items_guard();

CREATE TRIGGER restaurant_bills_guard BEFORE UPDATE OR DELETE ON "restaurant_bills"
  FOR EACH ROW EXECUTE FUNCTION only_columns_update('status', 'sale_id', 'paid_at', 'cancelled_at', 'cancelled_by_id', 'cancel_reason', 'print_count', 'updated_at');

-- En ajout seul.
CREATE TRIGGER restaurant_consumptions_append_only BEFORE UPDATE OR DELETE ON "restaurant_consumptions"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER restaurant_item_cancellations_append_only BEFORE UPDATE OR DELETE ON "restaurant_item_cancellations"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER restaurant_kitchen_tickets_append_only BEFORE UPDATE OR DELETE ON "restaurant_kitchen_tickets"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER restaurant_bill_items_append_only BEFORE UPDATE OR DELETE ON "restaurant_bill_items"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

-- Jamais supprimés (désactivation, statut ou annulation tracés).
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['restaurant_areas','restaurant_tables','restaurant_stations','restaurant_menu_items','restaurant_options',
    'restaurant_orders','restaurant_reservations','restaurant_print_jobs'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_delete()', t || '_no_delete', t);
  END LOOP;
END $$;
