-- CreateEnum
CREATE TYPE "UnitDimension" AS ENUM ('MASS', 'VOLUME', 'COUNT');

-- CreateEnum
CREATE TYPE "RawMaterialKind" AS ENUM ('INGREDIENT', 'PACKAGING', 'CONSUMABLE');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('MANUFACTURED', 'RESOLD', 'MENU');

-- CreateTable
CREATE TABLE "units" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "dimension" "UnitDimension" NOT NULL,
    "factor_to_base" DECIMAL(18,6) NOT NULL,
    "is_base" BOOLEAN NOT NULL,

    CONSTRAINT "units_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "raw_material_categories" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "raw_material_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_materials" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category_id" UUID,
    "kind" "RawMaterialKind" NOT NULL DEFAULT 'INGREDIENT',
    "base_unit_code" TEXT NOT NULL,
    "is_perishable" BOOLEAN NOT NULL DEFAULT false,
    "track_lots" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "raw_materials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_material_packagings" (
    "id" UUID NOT NULL,
    "raw_material_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "raw_material_packagings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contact_name" TEXT,
    "phone" TEXT,
    "phone2" TEXT,
    "email" TEXT,
    "address" TEXT,
    "city" TEXT,
    "tax_id" TEXT,
    "payment_terms_days" INTEGER NOT NULL DEFAULT 0,
    "payment_terms" TEXT,
    "credit_limit" BIGINT,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_products" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "raw_material_id" UUID,
    "product_id" UUID,
    "brand" TEXT,
    "supplier_ref" TEXT,
    "purchase_unit_label" TEXT NOT NULL,
    "quantity_per_purchase_unit" DECIMAL(18,4) NOT NULL,
    "unit_price" BIGINT,
    "price_updated_at" TIMESTAMPTZ(3),
    "is_preferred" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "supplier_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_categories" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category_id" UUID,
    "type" "ProductType" NOT NULL,
    "sale_unit_code" TEXT NOT NULL DEFAULT 'U',
    "barcode" TEXT,
    "description" TEXT,
    "image_url" TEXT,
    "tax_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_prices" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "establishment_id" UUID,
    "price" BIGINT NOT NULL,
    "valid_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_to" TIMESTAMPTZ(3),
    "created_by_id" UUID,
    "reason" TEXT,

    CONSTRAINT "product_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_availability" (
    "product_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "is_available" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_availability_pkey" PRIMARY KEY ("product_id","establishment_id")
);

-- CreateTable
CREATE TABLE "product_components" (
    "id" UUID NOT NULL,
    "menu_product_id" UUID NOT NULL,
    "component_product_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "product_components_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "raw_material_categories_company_id_name_key" ON "raw_material_categories"("company_id", "name");

-- CreateIndex
CREATE INDEX "raw_materials_company_id_name_idx" ON "raw_materials"("company_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "raw_materials_company_id_code_key" ON "raw_materials"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "raw_material_packagings_raw_material_id_name_key" ON "raw_material_packagings"("raw_material_id", "name");

-- CreateIndex
CREATE INDEX "suppliers_company_id_name_idx" ON "suppliers"("company_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_company_id_code_key" ON "suppliers"("company_id", "code");

-- CreateIndex
CREATE INDEX "supplier_products_supplier_id_idx" ON "supplier_products"("supplier_id");

-- CreateIndex
CREATE INDEX "supplier_products_raw_material_id_idx" ON "supplier_products"("raw_material_id");

-- CreateIndex
CREATE INDEX "supplier_products_product_id_idx" ON "supplier_products"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_categories_company_id_name_key" ON "product_categories"("company_id", "name");

-- CreateIndex
CREATE INDEX "products_company_id_name_idx" ON "products"("company_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "products_company_id_code_key" ON "products"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "products_company_id_barcode_key" ON "products"("company_id", "barcode");

-- CreateIndex
CREATE INDEX "product_prices_product_id_establishment_id_valid_to_idx" ON "product_prices"("product_id", "establishment_id", "valid_to");

-- CreateIndex
CREATE UNIQUE INDEX "product_components_menu_product_id_component_product_id_key" ON "product_components"("menu_product_id", "component_product_id");

-- AddForeignKey
ALTER TABLE "raw_material_categories" ADD CONSTRAINT "raw_material_categories_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_materials" ADD CONSTRAINT "raw_materials_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_materials" ADD CONSTRAINT "raw_materials_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "raw_material_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_materials" ADD CONSTRAINT "raw_materials_base_unit_code_fkey" FOREIGN KEY ("base_unit_code") REFERENCES "units"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raw_material_packagings" ADD CONSTRAINT "raw_material_packagings_raw_material_id_fkey" FOREIGN KEY ("raw_material_id") REFERENCES "raw_materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_raw_material_id_fkey" FOREIGN KEY ("raw_material_id") REFERENCES "raw_materials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "product_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_sale_unit_code_fkey" FOREIGN KEY ("sale_unit_code") REFERENCES "units"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_establishment_id_fkey" FOREIGN KEY ("establishment_id") REFERENCES "establishments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_availability" ADD CONSTRAINT "product_availability_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_availability" ADD CONSTRAINT "product_availability_establishment_id_fkey" FOREIGN KEY ("establishment_id") REFERENCES "establishments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_components" ADD CONSTRAINT "product_components_menu_product_id_fkey" FOREIGN KEY ("menu_product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_components" ADD CONSTRAINT "product_components_component_product_id_fkey" FOREIGN KEY ("component_product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Référentiel des unités (unité de base : kg, L, unité).
-- ---------------------------------------------------------------------------
INSERT INTO "units" ("code", "name", "symbol", "dimension", "factor_to_base", "is_base") VALUES
  ('KG', 'Kilogramme', 'kg', 'MASS', 1, true),
  ('G', 'Gramme', 'g', 'MASS', 0.001, false),
  ('L', 'Litre', 'L', 'VOLUME', 1, true),
  ('CL', 'Centilitre', 'cL', 'VOLUME', 0.01, false),
  ('ML', 'Millilitre', 'mL', 'VOLUME', 0.001, false),
  ('U', 'Unité', 'u', 'COUNT', 1, true);

-- ---------------------------------------------------------------------------
-- Contraintes d'intégrité non exprimables dans Prisma.
-- ---------------------------------------------------------------------------

-- Une matière première est stockée dans une unité de base (kg, L ou unité).
ALTER TABLE "raw_materials" ADD CONSTRAINT "raw_materials_base_unit_chk"
  CHECK ("base_unit_code" IN ('KG', 'L', 'U'));

ALTER TABLE "raw_material_packagings" ADD CONSTRAINT "raw_material_packagings_quantity_chk"
  CHECK ("quantity" > 0);

-- Offre fournisseur : exactement un article (matière OU produit revendu).
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_item_chk"
  CHECK (("raw_material_id" IS NULL) <> ("product_id" IS NULL));
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_quantity_chk"
  CHECK ("quantity_per_purchase_unit" > 0);
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_price_chk"
  CHECK ("unit_price" IS NULL OR "unit_price" >= 0);

ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_terms_chk"
  CHECK ("payment_terms_days" >= 0 AND ("credit_limit" IS NULL OR "credit_limit" >= 0));

ALTER TABLE "products" ADD CONSTRAINT "products_tax_rate_chk"
  CHECK ("tax_rate" >= 0 AND "tax_rate" <= 100);

ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_price_chk"
  CHECK ("price" >= 0);
ALTER TABLE "product_prices" ADD CONSTRAINT "product_prices_period_chk"
  CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from");

-- Un seul prix en vigueur par produit et par périmètre (groupe ou établissement),
-- même en cas de modifications simultanées.
CREATE UNIQUE INDEX "product_prices_current_uniq"
  ON "product_prices" ("product_id", COALESCE("establishment_id", '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE "valid_to" IS NULL;

ALTER TABLE "product_components" ADD CONSTRAINT "product_components_chk"
  CHECK ("quantity" > 0 AND "menu_product_id" <> "component_product_id");

-- L'historique des prix ne se supprime jamais (seule la clôture valid_to est permise).
CREATE OR REPLACE FUNCTION product_prices_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Historique des prix : suppression interdite';
  END IF;
  IF NEW.price <> OLD.price OR NEW.product_id <> OLD.product_id
     OR NEW.establishment_id IS DISTINCT FROM OLD.establishment_id
     OR NEW.valid_from <> OLD.valid_from
     OR (OLD.valid_to IS NOT NULL) THEN
    RAISE EXCEPTION 'Historique des prix : seule la clôture d''un prix en vigueur est autorisée';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER product_prices_history_guard
  BEFORE UPDATE OR DELETE ON "product_prices"
  FOR EACH ROW EXECUTE FUNCTION product_prices_guard();
