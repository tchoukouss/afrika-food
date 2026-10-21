-- Module 3 — idempotence des créations (double clic, renvoi après coupure réseau).
-- Un même identifiant de requête ne peut créer qu'un seul document par entreprise.

ALTER TABLE "purchase_requests" ADD COLUMN "client_request_id" UUID;
CREATE UNIQUE INDEX "purchase_requests_company_id_client_request_id_key" ON "purchase_requests"("company_id", "client_request_id");

ALTER TABLE "purchase_orders" ADD COLUMN "client_request_id" UUID;
CREATE UNIQUE INDEX "purchase_orders_company_id_client_request_id_key" ON "purchase_orders"("company_id", "client_request_id");

ALTER TABLE "goods_receipts" ADD COLUMN "client_request_id" UUID;
CREATE UNIQUE INDEX "goods_receipts_company_id_client_request_id_key" ON "goods_receipts"("company_id", "client_request_id");

ALTER TABLE "supplier_invoices" ADD COLUMN "client_request_id" UUID;
CREATE UNIQUE INDEX "supplier_invoices_company_id_client_request_id_key" ON "supplier_invoices"("company_id", "client_request_id");

ALTER TABLE "supplier_payments" ADD COLUMN "client_request_id" UUID;
CREATE UNIQUE INDEX "supplier_payments_company_id_client_request_id_key" ON "supplier_payments"("company_id", "client_request_id");

ALTER TABLE "supplier_returns" ADD COLUMN "client_request_id" UUID;
CREATE UNIQUE INDEX "supplier_returns_company_id_client_request_id_key" ON "supplier_returns"("company_id", "client_request_id");

ALTER TABLE "stock_adjustments" ADD COLUMN "client_request_id" UUID;
CREATE UNIQUE INDEX "stock_adjustments_company_id_client_request_id_key" ON "stock_adjustments"("company_id", "client_request_id");

ALTER TABLE "stock_losses" ADD COLUMN "client_request_id" UUID;
CREATE UNIQUE INDEX "stock_losses_company_id_client_request_id_key" ON "stock_losses"("company_id", "client_request_id");

ALTER TABLE "location_moves" ADD COLUMN "client_request_id" UUID;
CREATE UNIQUE INDEX "location_moves_company_id_client_request_id_key" ON "location_moves"("company_id", "client_request_id");

ALTER TABLE "stock_transfers" ADD COLUMN "client_request_id" UUID;
CREATE UNIQUE INDEX "stock_transfers_company_id_client_request_id_key" ON "stock_transfers"("company_id", "client_request_id");
