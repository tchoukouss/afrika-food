-- Module 7 — Clients & facturation, étape 1 : clients, encours et crédit.
-- CreateEnum
CREATE TYPE "CustomerType" AS ENUM ('INDIVIDUAL', 'BUSINESS', 'WHOLESALER', 'EVENT');

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "client_request_id" UUID,
    "type" "CustomerType" NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "phone_normalized" TEXT,
    "email" TEXT,
    "address" TEXT,
    "tax_id" TEXT,
    "credit_limit" BIGINT,
    "payment_term_days" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_overrides" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "client_request_id" UUID,
    "max_amount" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "approved_by_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "used_by_id" UUID,
    "used_amount" BIGINT,
    "used_reference" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_company_id_name_idx" ON "customers"("company_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "customers_company_id_client_request_id_key" ON "customers"("company_id", "client_request_id");

-- CreateIndex
CREATE INDEX "credit_overrides_customer_id_expires_at_idx" ON "credit_overrides"("customer_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "credit_overrides_company_id_client_request_id_key" ON "credit_overrides"("company_id", "client_request_id");

-- AddForeignKey
ALTER TABLE "credit_overrides" ADD CONSTRAINT "credit_overrides_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- Compléments manuels du module 7, étape 1 (non exprimables dans le schéma Prisma).
-- ===========================================================================

-- Clés étrangères vers les tables du module 1.
ALTER TABLE "customers" ADD CONSTRAINT "customers_company_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id");
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_fk" FOREIGN KEY ("created_by_id") REFERENCES "users"("id");
ALTER TABLE "credit_overrides" ADD CONSTRAINT "credit_overrides_company_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id");
ALTER TABLE "credit_overrides" ADD CONSTRAINT "credit_overrides_establishment_fk" FOREIGN KEY ("establishment_id") REFERENCES "establishments"("id");
ALTER TABLE "credit_overrides" ADD CONSTRAINT "credit_overrides_approved_by_fk" FOREIGN KEY ("approved_by_id") REFERENCES "users"("id");
ALTER TABLE "credit_overrides" ADD CONSTRAINT "credit_overrides_used_by_fk" FOREIGN KEY ("used_by_id") REFERENCES "users"("id");
ALTER TABLE "credit_overrides" ADD CONSTRAINT "credit_overrides_cancelled_by_fk" FOREIGN KEY ("cancelled_by_id") REFERENCES "users"("id");

-- Cohérence des données.
ALTER TABLE "customers" ADD CONSTRAINT "customers_chk"
  CHECK (length(trim("name")) >= 2
         AND ("credit_limit" IS NULL OR "credit_limit" >= 0)
         AND "payment_term_days" BETWEEN 0 AND 365
         AND (("phone" IS NULL) = ("phone_normalized" IS NULL)));
ALTER TABLE "credit_overrides" ADD CONSTRAINT "credit_overrides_chk"
  CHECK ("max_amount" > 0 AND length(trim("reason")) >= 3 AND "expires_at" > "created_at"
         AND (("used_at" IS NULL) = ("used_by_id" IS NULL))
         AND (("used_at" IS NULL) = ("used_amount" IS NULL))
         AND ("used_amount" IS NULL OR ("used_amount" > 0 AND "used_amount" <= "max_amount"))
         AND (("cancelled_at" IS NULL) = ("cancelled_by_id" IS NULL))
         AND ("used_at" IS NULL OR "cancelled_at" IS NULL));

-- Téléphone unique dans l'entreprise, quand il est renseigné.
CREATE UNIQUE INDEX "customers_company_phone_key" ON "customers" ("company_id", "phone_normalized") WHERE "phone_normalized" IS NOT NULL;

-- Un client ne se supprime jamais (désactivation).
CREATE TRIGGER customers_no_delete BEFORE DELETE ON "customers"
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- Une autorisation ne change que par sa consommation ou son annulation ; jamais supprimée.
CREATE TRIGGER credit_overrides_guard BEFORE UPDATE OR DELETE ON "credit_overrides"
  FOR EACH ROW EXECUTE FUNCTION only_columns_update('used_at', 'used_by_id', 'used_amount', 'used_reference', 'cancelled_at', 'cancelled_by_id');
