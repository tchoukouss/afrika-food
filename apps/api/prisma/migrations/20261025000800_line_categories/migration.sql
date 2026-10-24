-- AlterTable
ALTER TABLE "sale_items" ADD COLUMN     "category_id" UUID,
ADD COLUMN     "category_name" TEXT;

-- AlterTable
ALTER TABLE "customer_order_lines" ADD COLUMN     "category_id" UUID,
ADD COLUMN     "category_name" TEXT;

-- AlterTable
ALTER TABLE "invoice_lines" ADD COLUMN     "category_id" UUID,
ADD COLUMN     "category_name" TEXT;

-- ===========================================================================
-- Compléments manuels : catégorie historique des lignes commerciales (préparation du module 8).
-- Lignes existantes laissées à NULL (« catégorie non renseignée ») : aucune reconstitution.
-- ===========================================================================

-- Les catégories ne se suppriment pas (renommage ou désactivation seulement) : le nom figé garde l'historique.
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_category_fk" FOREIGN KEY ("category_id") REFERENCES "product_categories"("id");
ALTER TABLE "customer_order_lines" ADD CONSTRAINT "customer_order_lines_category_fk" FOREIGN KEY ("category_id") REFERENCES "product_categories"("id");
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_category_fk" FOREIGN KEY ("category_id") REFERENCES "product_categories"("id");

-- Identifiant et nom vont ensemble ; une ligne « frais » n'a pas de catégorie produit.
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_category_chk"
  CHECK (("category_id" IS NULL) = ("category_name" IS NULL));
ALTER TABLE "customer_order_lines" ADD CONSTRAINT "customer_order_lines_category_chk"
  CHECK (("category_id" IS NULL) = ("category_name" IS NULL) AND ("kind" = 'PRODUCT' OR "category_id" IS NULL));
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_category_chk"
  CHECK (("category_id" IS NULL) = ("category_name" IS NULL) AND ("kind" = 'PRODUCT' OR "category_id" IS NULL));
