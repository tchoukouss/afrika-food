-- Module 4 — Recettes & production : tables, contraintes et protections.

-- CreateEnum
CREATE TYPE "RecipeVersionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ProductionStatus" AS ENUM ('PLANNED', 'VALIDATED', 'IN_PROGRESS', 'COMPLETED', 'CONTROLLED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProductionLossStage" AS ENUM ('COMPLETION', 'CONTROL');

-- CreateEnum
CREATE TYPE "ConsumptionKind" AS ENUM ('THEORETICAL', 'EXTRA', 'RETURN');

-- CreateTable
CREATE TABLE "recipes" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "active_version_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recipes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_versions" (
    "id" UUID NOT NULL,
    "recipe_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "RecipeVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "yield_quantity" DECIMAL(18,4) NOT NULL,
    "shelf_life_days" INTEGER,
    "instructions" TEXT,
    "notes" TEXT,
    "created_by_id" UUID NOT NULL,
    "activated_by_id" UUID,
    "activated_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recipe_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipe_items" (
    "id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "raw_material_id" UUID,
    "product_id" UUID,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_code" TEXT NOT NULL,
    "loss_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "recipe_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_orders" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "client_request_id" UUID,
    "product_id" UUID NOT NULL,
    "recipe_version_id" UUID NOT NULL,
    "status" "ProductionStatus" NOT NULL DEFAULT 'PLANNED',
    "planned_quantity" DECIMAL(18,4) NOT NULL,
    "produced_quantity" DECIMAL(18,4),
    "planned_date" DATE,
    "source_location_id" UUID NOT NULL,
    "dest_location_id" UUID NOT NULL,
    "notes" TEXT,
    "theoretical_cost" DECIMAL(18,2),
    "real_cost" DECIMAL(18,2),
    "unit_cost" DECIMAL(18,4),
    "over_reason" TEXT,
    "control_note" TEXT,
    "cancel_reason" TEXT,
    "created_by_id" UUID NOT NULL,
    "validated_by_id" UUID,
    "validated_at" TIMESTAMPTZ(3),
    "started_by_id" UUID,
    "started_at" TIMESTAMPTZ(3),
    "completed_by_id" UUID,
    "completed_at" TIMESTAMPTZ(3),
    "controlled_by_id" UUID,
    "controlled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "production_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "raw_material_id" UUID,
    "product_id" UUID,
    "recipe_quantity" DECIMAL(18,4) NOT NULL,
    "recipe_unit_code" TEXT NOT NULL,
    "loss_percent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "theoretical_quantity" DECIMAL(18,4) NOT NULL,
    "consumed_quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,

    CONSTRAINT "production_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_reservations" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "balance_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "released_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_consumptions" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "kind" "ConsumptionKind" NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_cost" DECIMAL(18,4) NOT NULL,
    "value" DECIMAL(18,2) NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_consumptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_outputs" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_cost" DECIMAL(18,4) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_outputs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "production_losses" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "stage" "ProductionLossStage" NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "cause" "LossCause" NOT NULL,
    "reason" TEXT NOT NULL,
    "value" DECIMAL(18,2) NOT NULL,
    "stock_loss_id" UUID,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_losses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recipes_product_id_key" ON "recipes"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "recipes_active_version_id_key" ON "recipes"("active_version_id");

-- CreateIndex
CREATE INDEX "recipes_company_id_idx" ON "recipes"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "recipe_versions_recipe_id_version_key" ON "recipe_versions"("recipe_id", "version");

-- CreateIndex
CREATE INDEX "recipe_items_version_id_idx" ON "recipe_items"("version_id");

-- CreateIndex
CREATE INDEX "production_orders_establishment_id_status_idx" ON "production_orders"("establishment_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "production_orders_company_id_number_key" ON "production_orders"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "production_orders_company_id_client_request_id_key" ON "production_orders"("company_id", "client_request_id");

-- CreateIndex
CREATE INDEX "production_items_order_id_idx" ON "production_items"("order_id");

-- CreateIndex
CREATE INDEX "production_reservations_order_id_idx" ON "production_reservations"("order_id");

-- CreateIndex
CREATE INDEX "production_reservations_balance_id_idx" ON "production_reservations"("balance_id");

-- CreateIndex
CREATE INDEX "production_consumptions_order_id_idx" ON "production_consumptions"("order_id");

-- CreateIndex
CREATE INDEX "production_consumptions_lot_id_idx" ON "production_consumptions"("lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "production_outputs_lot_id_key" ON "production_outputs"("lot_id");

-- CreateIndex
CREATE INDEX "production_outputs_order_id_idx" ON "production_outputs"("order_id");

-- CreateIndex
CREATE INDEX "production_losses_order_id_idx" ON "production_losses"("order_id");

-- AddForeignKey
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "recipes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipe_items" ADD CONSTRAINT "recipe_items_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "recipe_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_items" ADD CONSTRAINT "production_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_reservations" ADD CONSTRAINT "production_reservations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_consumptions" ADD CONSTRAINT "production_consumptions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_outputs" ADD CONSTRAINT "production_outputs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "production_losses" ADD CONSTRAINT "production_losses_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "production_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- Compléments manuels du module 4 (non exprimables dans le schéma Prisma).
-- ===========================================================================

-- Clés étrangères vers les tables des modules 1, 2 et 3.
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_company_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id");
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_product_fk" FOREIGN KEY ("product_id") REFERENCES "products"("id");
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_active_version_fk" FOREIGN KEY ("active_version_id") REFERENCES "recipe_versions"("id");
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id");
ALTER TABLE "recipe_items" ADD CONSTRAINT "recipe_items_raw_material_fk" FOREIGN KEY ("raw_material_id") REFERENCES "raw_materials"("id");
ALTER TABLE "recipe_items" ADD CONSTRAINT "recipe_items_product_fk" FOREIGN KEY ("product_id") REFERENCES "products"("id");
ALTER TABLE "recipe_items" ADD CONSTRAINT "recipe_items_unit_fk" FOREIGN KEY ("unit_code") REFERENCES "units"("code");

ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_company_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id");
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_establishment_fk" FOREIGN KEY ("establishment_id") REFERENCES "establishments"("id");
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_product_fk" FOREIGN KEY ("product_id") REFERENCES "products"("id");
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_version_fk" FOREIGN KEY ("recipe_version_id") REFERENCES "recipe_versions"("id");
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_source_location_fk" FOREIGN KEY ("source_location_id") REFERENCES "stock_locations"("id");
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_dest_location_fk" FOREIGN KEY ("dest_location_id") REFERENCES "stock_locations"("id");
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id");
ALTER TABLE "production_items" ADD CONSTRAINT "production_items_raw_material_fk" FOREIGN KEY ("raw_material_id") REFERENCES "raw_materials"("id");
ALTER TABLE "production_items" ADD CONSTRAINT "production_items_product_fk" FOREIGN KEY ("product_id") REFERENCES "products"("id");
ALTER TABLE "production_reservations" ADD CONSTRAINT "production_reservations_item_fk" FOREIGN KEY ("item_id") REFERENCES "production_items"("id");
ALTER TABLE "production_reservations" ADD CONSTRAINT "production_reservations_balance_fk" FOREIGN KEY ("balance_id") REFERENCES "stock_balances"("id");
ALTER TABLE "production_consumptions" ADD CONSTRAINT "production_consumptions_item_fk" FOREIGN KEY ("item_id") REFERENCES "production_items"("id");
ALTER TABLE "production_consumptions" ADD CONSTRAINT "production_consumptions_lot_fk" FOREIGN KEY ("lot_id") REFERENCES "stock_lots"("id");
ALTER TABLE "production_consumptions" ADD CONSTRAINT "production_consumptions_location_fk" FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id");
ALTER TABLE "production_outputs" ADD CONSTRAINT "production_outputs_lot_fk" FOREIGN KEY ("lot_id") REFERENCES "stock_lots"("id");
ALTER TABLE "production_outputs" ADD CONSTRAINT "production_outputs_location_fk" FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id");
ALTER TABLE "production_losses" ADD CONSTRAINT "production_losses_stock_loss_fk" FOREIGN KEY ("stock_loss_id") REFERENCES "stock_losses"("id");

-- Cohérence des données.
ALTER TABLE "recipe_versions" ADD CONSTRAINT "recipe_versions_chk"
  CHECK ("yield_quantity" > 0 AND ("shelf_life_days" IS NULL OR ("shelf_life_days" >= 0 AND "shelf_life_days" <= 3650)));
ALTER TABLE "recipe_items" ADD CONSTRAINT "recipe_items_item_chk" CHECK (("raw_material_id" IS NULL) <> ("product_id" IS NULL));
ALTER TABLE "recipe_items" ADD CONSTRAINT "recipe_items_chk" CHECK ("quantity" > 0 AND "loss_percent" >= 0 AND "loss_percent" < 100);
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_chk"
  CHECK ("planned_quantity" > 0 AND ("produced_quantity" IS NULL OR "produced_quantity" >= 0)
         AND ("real_cost" IS NULL OR "real_cost" >= 0) AND ("unit_cost" IS NULL OR "unit_cost" >= 0));
ALTER TABLE "production_items" ADD CONSTRAINT "production_items_item_chk" CHECK (("raw_material_id" IS NULL) <> ("product_id" IS NULL));
ALTER TABLE "production_items" ADD CONSTRAINT "production_items_chk" CHECK ("theoretical_quantity" > 0 AND "consumed_quantity" >= 0);
ALTER TABLE "production_reservations" ADD CONSTRAINT "production_reservations_chk" CHECK ("quantity" > 0);
ALTER TABLE "production_consumptions" ADD CONSTRAINT "production_consumptions_chk"
  CHECK ("quantity" <> 0 AND (("kind" = 'RETURN') = ("quantity" < 0)));
ALTER TABLE "production_outputs" ADD CONSTRAINT "production_outputs_chk" CHECK ("quantity" > 0 AND "unit_cost" >= 0);
ALTER TABLE "production_losses" ADD CONSTRAINT "production_losses_chk" CHECK ("quantity" > 0 AND "value" >= 0);

-- Une seule version active par recette.
CREATE UNIQUE INDEX "recipe_versions_one_active" ON "recipe_versions" ("recipe_id") WHERE "status" = 'ACTIVE';

-- Une version publiée (active ou archivée) ne se modifie plus : seul le passage
-- ACTIVE → ARCHIVED est permis. Aucune version n'est jamais supprimée.
CREATE OR REPLACE FUNCTION recipe_versions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Version de recette : suppression interdite';
  END IF;
  IF OLD.status <> 'DRAFT' THEN
    IF NOT (OLD.status = 'ACTIVE' AND NEW.status = 'ARCHIVED')
       OR NEW.yield_quantity <> OLD.yield_quantity
       OR NEW.shelf_life_days IS DISTINCT FROM OLD.shelf_life_days
       OR NEW.instructions IS DISTINCT FROM OLD.instructions
       OR NEW.notes IS DISTINCT FROM OLD.notes
       OR NEW.version <> OLD.version OR NEW.recipe_id <> OLD.recipe_id THEN
      RAISE EXCEPTION 'Version de recette publiée : modification interdite (créez une nouvelle version)';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER recipe_versions_immutable BEFORE UPDATE OR DELETE ON "recipe_versions"
  FOR EACH ROW EXECUTE FUNCTION recipe_versions_guard();

-- Les ingrédients d'une version publiée sont figés.
CREATE OR REPLACE FUNCTION recipe_items_guard() RETURNS trigger AS $$
DECLARE
  st "RecipeVersionStatus";
BEGIN
  SELECT status INTO st FROM recipe_versions WHERE id = COALESCE(NEW.version_id, OLD.version_id);
  IF st <> 'DRAFT' THEN
    RAISE EXCEPTION 'Ingrédients d''une version publiée : modification interdite';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER recipe_items_immutable BEFORE INSERT OR UPDATE OR DELETE ON "recipe_items"
  FOR EACH ROW EXECUTE FUNCTION recipe_items_guard();

-- Consommations, sorties et pertes de production : en ajout seul.
CREATE TRIGGER production_consumptions_append_only BEFORE UPDATE OR DELETE ON "production_consumptions"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER production_outputs_append_only BEFORE UPDATE OR DELETE ON "production_outputs"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
CREATE TRIGGER production_losses_append_only BEFORE UPDATE OR DELETE ON "production_losses"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
-- Ordres et réservations ne sont jamais supprimés (annulation / libération tracées).
CREATE TRIGGER production_orders_no_delete BEFORE DELETE ON "production_orders"
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER production_reservations_no_delete BEFORE DELETE ON "production_reservations"
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
