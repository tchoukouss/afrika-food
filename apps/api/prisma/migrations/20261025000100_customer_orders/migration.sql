-- Module 7 — étape 2 : devis, commandes clients et événements.
-- CreateEnum
CREATE TYPE "CustomerDocumentKind" AS ENUM ('STANDARD', 'EVENT');

-- CreateEnum
CREATE TYPE "DocumentLineKind" AS ENUM ('PRODUCT', 'FEE');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'REFUSED');

-- CreateEnum
CREATE TYPE "CustomerOrderStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'IN_PREPARATION', 'READY', 'DELIVERED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('WEDDING', 'BAPTISM', 'BIRTHDAY', 'FUNERAL', 'SEMINAR', 'CORPORATE_MEAL', 'BUFFET', 'COCKTAIL', 'OTHER');

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "client_request_id" UUID,
    "kind" "CustomerDocumentKind" NOT NULL DEFAULT 'STANDARD',
    "status" "QuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "valid_until" DATE NOT NULL,
    "desired_at" TIMESTAMPTZ(3),
    "event" JSONB,
    "notes" TEXT,
    "total" BIGINT NOT NULL,
    "tax_total" BIGINT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "sent_at" TIMESTAMPTZ(3),
    "sent_by_id" UUID,
    "accepted_at" TIMESTAMPTZ(3),
    "accepted_by_id" UUID,
    "refused_at" TIMESTAMPTZ(3),
    "refused_by_id" UUID,
    "refuse_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_lines" (
    "id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
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

    CONSTRAINT "quote_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_status_history" (
    "id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "from_status" "QuoteStatus",
    "to_status" "QuoteStatus" NOT NULL,
    "reason" TEXT,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_orders" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "client_request_id" UUID,
    "kind" "CustomerDocumentKind" NOT NULL DEFAULT 'STANDARD',
    "status" "CustomerOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "quote_id" UUID,
    "due_at" TIMESTAMPTZ(3),
    "notes" TEXT,
    "total" BIGINT NOT NULL,
    "tax_total" BIGINT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "confirmed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_order_lines" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
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
    "production_order_id" UUID,
    "delivered_quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,

    CONSTRAINT "customer_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_order_events" (
    "order_id" UUID NOT NULL,
    "event_type" "EventType" NOT NULL,
    "event_date" TIMESTAMPTZ(3) NOT NULL,
    "venue" TEXT,
    "guests" INTEGER,
    "contact_name" TEXT,
    "contact_phone" TEXT,
    "notes" TEXT,

    CONSTRAINT "customer_order_events_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "customer_order_status_history" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "from_status" "CustomerOrderStatus",
    "to_status" "CustomerOrderStatus" NOT NULL,
    "reason" TEXT,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_reservations" (
    "id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "balance_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "released_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quotes_establishment_id_status_idx" ON "quotes"("establishment_id", "status");

-- CreateIndex
CREATE INDEX "quotes_customer_id_idx" ON "quotes"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_company_id_number_key" ON "quotes"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_company_id_client_request_id_key" ON "quotes"("company_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "quote_lines_quote_id_position_key" ON "quote_lines"("quote_id", "position");

-- CreateIndex
CREATE INDEX "quote_status_history_quote_id_idx" ON "quote_status_history"("quote_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_orders_quote_id_key" ON "customer_orders"("quote_id");

-- CreateIndex
CREATE INDEX "customer_orders_establishment_id_status_idx" ON "customer_orders"("establishment_id", "status");

-- CreateIndex
CREATE INDEX "customer_orders_customer_id_idx" ON "customer_orders"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_orders_company_id_number_key" ON "customer_orders"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "customer_orders_company_id_client_request_id_key" ON "customer_orders"("company_id", "client_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_order_lines_order_id_position_key" ON "customer_order_lines"("order_id", "position");

-- CreateIndex
CREATE INDEX "customer_order_status_history_order_id_idx" ON "customer_order_status_history"("order_id");

-- CreateIndex
CREATE INDEX "order_reservations_order_line_id_idx" ON "order_reservations"("order_line_id");

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_status_history" ADD CONSTRAINT "quote_status_history_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_order_lines" ADD CONSTRAINT "customer_order_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "customer_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_order_events" ADD CONSTRAINT "customer_order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "customer_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_order_status_history" ADD CONSTRAINT "customer_order_status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "customer_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_reservations" ADD CONSTRAINT "order_reservations_order_line_id_fkey" FOREIGN KEY ("order_line_id") REFERENCES "customer_order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- Compléments manuels du module 7, étape 2 (non exprimables dans le schéma Prisma).
-- ===========================================================================

-- Clés étrangères vers les tables des modules 1 à 4.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['quotes', 'customer_orders'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (company_id) REFERENCES companies(id)', t, t || '_company_fk');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (establishment_id) REFERENCES establishments(id)', t, t || '_establishment_fk');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (created_by_id) REFERENCES users(id)', t, t || '_created_by_fk');
  END LOOP;
END $$;
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_sent_by_fk" FOREIGN KEY ("sent_by_id") REFERENCES "users"("id");
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_accepted_by_fk" FOREIGN KEY ("accepted_by_id") REFERENCES "users"("id");
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_refused_by_fk" FOREIGN KEY ("refused_by_id") REFERENCES "users"("id");
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_product_fk" FOREIGN KEY ("product_id") REFERENCES "products"("id");
ALTER TABLE "quote_status_history" ADD CONSTRAINT "quote_status_history_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_cancelled_by_fk" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id");
ALTER TABLE "customer_order_lines" ADD CONSTRAINT "customer_order_lines_product_fk" FOREIGN KEY ("product_id") REFERENCES "products"("id");
ALTER TABLE "customer_order_lines" ADD CONSTRAINT "customer_order_lines_production_fk" FOREIGN KEY ("production_order_id") REFERENCES "production_orders"("id");
ALTER TABLE "customer_order_status_history" ADD CONSTRAINT "customer_order_status_history_user_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id");
ALTER TABLE "order_reservations" ADD CONSTRAINT "order_reservations_balance_fk" FOREIGN KEY ("balance_id") REFERENCES "stock_balances"("id");
ALTER TABLE "order_reservations" ADD CONSTRAINT "order_reservations_lot_fk" FOREIGN KEY ("lot_id") REFERENCES "stock_lots"("id");

-- Cohérence des données.
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_chk"
  CHECK ("total" >= 0 AND "tax_total" >= 0 AND "tax_total" <= "total"
         AND (("kind" = 'EVENT') = ("event" IS NOT NULL))
         AND (("status" = 'DRAFT') = ("sent_at" IS NULL))
         AND (("status" = 'ACCEPTED') = ("accepted_at" IS NOT NULL))
         AND (("status" = 'REFUSED') = ("refused_at" IS NOT NULL AND "refuse_reason" IS NOT NULL)));
ALTER TABLE "customer_orders" ADD CONSTRAINT "customer_orders_chk"
  CHECK ("total" >= 0 AND "tax_total" >= 0 AND "tax_total" <= "total"
         AND (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL AND "cancel_reason" IS NOT NULL))
         AND ("status" IN ('DRAFT', 'CANCELLED') OR "confirmed_at" IS NOT NULL));
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['quote_lines', 'customer_order_lines'] LOOP
    EXECUTE format($f$ALTER TABLE %I ADD CONSTRAINT %I CHECK (
      "quantity" > 0 AND "unit_price" >= 0 AND "line_total" >= 0 AND "tax_amount" >= 0 AND "tax_amount" <= "line_total"
      AND "tax_rate" >= 0 AND "tax_rate" <= 100 AND length(trim("label")) > 0
      AND (("kind" = 'PRODUCT') = ("product_id" IS NOT NULL)))$f$, t, t || '_chk');
  END LOOP;
END $$;
ALTER TABLE "customer_order_lines" ADD CONSTRAINT "customer_order_lines_stock_chk"
  CHECK ("delivered_quantity" >= 0 AND "delivered_quantity" <= "quantity"
         AND ("kind" = 'PRODUCT' OR ("production_order_id" IS NULL AND "delivered_quantity" = 0)));
ALTER TABLE "customer_order_events" ADD CONSTRAINT "customer_order_events_chk" CHECK ("guests" IS NULL OR "guests" BETWEEN 1 AND 100000);
ALTER TABLE "order_reservations" ADD CONSTRAINT "order_reservations_chk" CHECK ("quantity" > 0);

-- Après le brouillon, un devis ou une commande ne change plus que par ses
-- colonnes d'état (passées en arguments) ; rien ne se supprime.
CREATE OR REPLACE FUNCTION m7_frozen_after_draft() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Table % : suppression interdite', TG_TABLE_NAME;
  END IF;
  IF OLD.status <> 'DRAFT' AND (to_jsonb(NEW) - TG_ARGV) IS DISTINCT FROM (to_jsonb(OLD) - TG_ARGV) THEN
    RAISE EXCEPTION 'Table % : document hors brouillon, seul son état peut changer', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER quotes_guard BEFORE UPDATE OR DELETE ON "quotes"
  FOR EACH ROW EXECUTE FUNCTION m7_frozen_after_draft('status', 'sent_at', 'sent_by_id', 'accepted_at', 'accepted_by_id', 'refused_at', 'refused_by_id', 'refuse_reason', 'updated_at');
CREATE TRIGGER customer_orders_guard BEFORE UPDATE OR DELETE ON "customer_orders"
  FOR EACH ROW EXECUTE FUNCTION m7_frozen_after_draft('status', 'confirmed_at', 'cancelled_at', 'cancelled_by_id', 'cancel_reason', 'updated_at');

-- Lignes et détails d'événement : modifiables seulement tant que le document
-- parent est en brouillon (colonnes de stock exceptées pour l'étape 3).
CREATE OR REPLACE FUNCTION m7_lines_guard() RETURNS trigger AS $$
DECLARE
  parent_status TEXT;
  parent_id UUID;
BEGIN
  -- TG_ARGV[0] : table parente ; TG_ARGV[1] : colonne de la clé du parent.
  parent_id := ((CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END) ->> TG_ARGV[1])::uuid;
  EXECUTE format('SELECT status::text FROM %I WHERE id = $1', TG_ARGV[0]) INTO parent_status USING parent_id;
  IF parent_status IS DISTINCT FROM 'DRAFT' THEN
    IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'customer_order_lines'
       AND (to_jsonb(NEW) - ARRAY['production_order_id', 'delivered_quantity']) = (to_jsonb(OLD) - ARRAY['production_order_id', 'delivered_quantity']) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Table % : document hors brouillon, lignes figées', TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER quote_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "quote_lines"
  FOR EACH ROW EXECUTE FUNCTION m7_lines_guard('quotes', 'quote_id');
CREATE TRIGGER customer_order_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON "customer_order_lines"
  FOR EACH ROW EXECUTE FUNCTION m7_lines_guard('customer_orders', 'order_id');
CREATE TRIGGER customer_order_events_guard BEFORE INSERT OR UPDATE OR DELETE ON "customer_order_events"
  FOR EACH ROW EXECUTE FUNCTION m7_lines_guard('customer_orders', 'order_id');

-- Historiques en ajout seul ; réservations jamais supprimées (libération tracée).
CREATE TRIGGER quote_status_history_append_only BEFORE UPDATE OR DELETE ON "quote_status_history"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER customer_order_status_history_append_only BEFORE UPDATE OR DELETE ON "customer_order_status_history"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER order_reservations_no_delete BEFORE DELETE ON "order_reservations"
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
