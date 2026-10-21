-- CreateEnum
CREATE TYPE "LotOrigin" AS ENUM ('RECEIPT', 'INVENTORY', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('RECEIPT', 'SUPPLIER_RETURN', 'TRANSFER_OUT', 'TRANSFER_IN', 'LOCATION_OUT', 'LOCATION_IN', 'INVENTORY_GAIN', 'INVENTORY_LOSS', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'LOSS');

-- CreateEnum
CREATE TYPE "PurchaseRequestStatus" AS ENUM ('OPEN', 'ORDERED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'VALIDATED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SupplierInvoiceStatus" AS ENUM ('OPEN', 'PARTIALLY_PAID', 'PAID', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'ORANGE_MONEY', 'MTN_MONEY', 'MOOV_MONEY', 'WAVE', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'OTHER');

-- CreateEnum
CREATE TYPE "InventoryStatus" AS ENUM ('OPEN', 'VALIDATED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AdjustmentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AdjustmentDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "LossCause" AS ENUM ('EXPIRED', 'BURNT', 'BROKEN', 'PRODUCTION_ERROR', 'CUSTOMER_RETURN', 'QUALITY', 'TRANSIT', 'OTHER');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('REQUESTED', 'VALIDATED', 'PREPARED', 'SHIPPED', 'RECEIVED', 'CLOSED', 'CANCELLED');

-- CreateTable
CREATE TABLE "stock_locations" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_lots" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "lot_number" TEXT NOT NULL,
    "raw_material_id" UUID,
    "product_id" UUID,
    "origin" "LotOrigin" NOT NULL,
    "supplier_id" UUID,
    "brand" TEXT,
    "supplier_lot_ref" TEXT,
    "production_date" DATE,
    "expiry_date" DATE,
    "unit_cost" DECIMAL(18,4) NOT NULL,
    "receipt_item_id" UUID,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balances" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "raw_material_id" UUID,
    "product_id" UUID,
    "quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "reserved_quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" BIGSERIAL NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "raw_material_id" UUID,
    "product_id" UUID,
    "type" "StockMovementType" NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_cost" DECIMAL(18,4) NOT NULL,
    "value" DECIMAL(18,2) NOT NULL,
    "balance_after" DECIMAL(18,4) NOT NULL,
    "origin_type" TEXT NOT NULL,
    "origin_id" UUID NOT NULL,
    "reason" TEXT,
    "user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_thresholds" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "raw_material_id" UUID,
    "product_id" UUID,
    "min_quantity" DECIMAL(18,4) NOT NULL,
    "alert_quantity" DECIMAL(18,4) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_thresholds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_requests" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" "PurchaseRequestStatus" NOT NULL DEFAULT 'OPEN',
    "needed_by" DATE,
    "notes" TEXT,
    "requested_by_id" UUID NOT NULL,
    "purchase_order_id" UUID,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_request_items" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "raw_material_id" UUID,
    "product_id" UUID,
    "quantity" DECIMAL(18,4) NOT NULL,
    "note" TEXT,

    CONSTRAINT "purchase_request_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "supplier_id" UUID NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "order_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expected_date" DATE,
    "payment_terms" TEXT,
    "notes" TEXT,
    "discount_amount" BIGINT NOT NULL DEFAULT 0,
    "subtotal" BIGINT NOT NULL DEFAULT 0,
    "total" BIGINT NOT NULL DEFAULT 0,
    "created_by_id" UUID NOT NULL,
    "validated_by_id" UUID,
    "validated_at" TIMESTAMPTZ(3),
    "closed_by_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "close_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "raw_material_id" UUID,
    "product_id" UUID,
    "supplier_product_id" UUID,
    "purchase_unit_label" TEXT NOT NULL,
    "quantity_per_purchase_unit" DECIMAL(18,4) NOT NULL,
    "ordered_quantity" DECIMAL(18,4) NOT NULL,
    "unit_price" BIGINT NOT NULL,
    "discount_amount" BIGINT NOT NULL DEFAULT 0,
    "line_total" BIGINT NOT NULL,
    "received_quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,

    CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipts" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "supplier_id" UUID NOT NULL,
    "purchase_order_id" UUID,
    "supplier_document_ref" TEXT,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "total_value" BIGINT NOT NULL,
    "received_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goods_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goods_receipt_items" (
    "id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "order_item_id" UUID,
    "raw_material_id" UUID,
    "product_id" UUID,
    "purchase_unit_label" TEXT NOT NULL,
    "quantity_per_purchase_unit" DECIMAL(18,4) NOT NULL,
    "received_quantity" DECIMAL(18,4) NOT NULL,
    "rejected_quantity" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "accepted_quantity" DECIMAL(18,4) NOT NULL,
    "rejection_reason" TEXT,
    "variance_reason" TEXT,
    "unit_price" BIGINT NOT NULL,
    "ordered_unit_price" BIGINT,
    "line_value" BIGINT NOT NULL,
    "brand" TEXT,
    "supplier_lot_ref" TEXT,
    "production_date" DATE,
    "expiry_date" DATE,

    CONSTRAINT "goods_receipt_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_invoices" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "supplier_id" UUID NOT NULL,
    "supplier_ref" TEXT NOT NULL,
    "invoice_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "amount" BIGINT NOT NULL,
    "received_value" BIGINT NOT NULL,
    "paid_amount" BIGINT NOT NULL DEFAULT 0,
    "status" "SupplierInvoiceStatus" NOT NULL DEFAULT 'OPEN',
    "notes" TEXT,
    "created_by_id" UUID NOT NULL,
    "cancelled_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "supplier_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_invoice_receipts" (
    "invoice_id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,

    CONSTRAINT "supplier_invoice_receipts_pkey" PRIMARY KEY ("invoice_id","receipt_id")
);

-- CreateTable
CREATE TABLE "supplier_payments" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "supplier_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "paid_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "created_by_id" UUID NOT NULL,
    "cancelled_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payment_allocations" (
    "id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_returns" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "supplier_id" UUID NOT NULL,
    "receipt_id" UUID,
    "reason" TEXT NOT NULL,
    "total_value" BIGINT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_return_items" (
    "id" UUID NOT NULL,
    "return_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_cost" DECIMAL(18,4) NOT NULL,
    "value" BIGINT NOT NULL,

    CONSTRAINT "supplier_return_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_credit_notes" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "supplier_id" UUID NOT NULL,
    "return_id" UUID NOT NULL,
    "invoice_id" UUID,
    "amount" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_credit_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_sessions" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" "InventoryStatus" NOT NULL DEFAULT 'OPEN',
    "notes" TEXT,
    "opened_by_id" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_by_id" UUID,
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "inventory_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_items" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "raw_material_id" UUID,
    "product_id" UUID,
    "theoretical_quantity" DECIMAL(18,4) NOT NULL,
    "counted_quantity" DECIMAL(18,4),
    "unit_cost" DECIMAL(18,4),
    "justification" TEXT,
    "counted_by_id" UUID,
    "counted_at" TIMESTAMPTZ(3),

    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_adjustments" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "status" "AdjustmentStatus" NOT NULL DEFAULT 'PENDING',
    "raw_material_id" UUID,
    "product_id" UUID,
    "direction" "AdjustmentDirection" NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "lot_id" UUID,
    "unit_cost" DECIMAL(18,4),
    "reason" TEXT NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_losses" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "location_id" UUID,
    "number" TEXT NOT NULL,
    "raw_material_id" UUID,
    "product_id" UUID,
    "lot_id" UUID,
    "quantity" DECIMAL(18,4) NOT NULL,
    "cause" "LossCause" NOT NULL,
    "comment" TEXT,
    "estimated_value" BIGINT NOT NULL,
    "transfer_id" UUID,
    "declared_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_losses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_moves" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "establishment_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "from_location_id" UUID NOT NULL,
    "to_location_id" UUID NOT NULL,
    "raw_material_id" UUID,
    "product_id" UUID,
    "quantity" DECIMAL(18,4) NOT NULL,
    "reason" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "location_moves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfers" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "source_establishment_id" UUID NOT NULL,
    "source_location_id" UUID,
    "dest_establishment_id" UUID NOT NULL,
    "dest_location_id" UUID,
    "status" "TransferStatus" NOT NULL DEFAULT 'REQUESTED',
    "notes" TEXT,
    "requested_by_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validated_by_id" UUID,
    "validated_at" TIMESTAMPTZ(3),
    "prepared_by_id" UUID,
    "prepared_at" TIMESTAMPTZ(3),
    "shipped_by_id" UUID,
    "shipped_at" TIMESTAMPTZ(3),
    "received_by_id" UUID,
    "received_at" TIMESTAMPTZ(3),
    "closed_by_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_items" (
    "id" UUID NOT NULL,
    "transfer_id" UUID NOT NULL,
    "raw_material_id" UUID,
    "product_id" UUID,
    "requested_quantity" DECIMAL(18,4) NOT NULL,
    "prepared_quantity" DECIMAL(18,4),
    "shipped_quantity" DECIMAL(18,4),
    "received_quantity" DECIMAL(18,4),
    "gap_reason" TEXT,

    CONSTRAINT "stock_transfer_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_lots" (
    "id" UUID NOT NULL,
    "transfer_item_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "shipped_quantity" DECIMAL(18,4) NOT NULL,
    "received_quantity" DECIMAL(18,4),
    "unit_cost" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "stock_transfer_lots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_locations_establishment_id_code_key" ON "stock_locations"("establishment_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "stock_lots_receipt_item_id_key" ON "stock_lots"("receipt_item_id");

-- CreateIndex
CREATE INDEX "stock_lots_raw_material_id_idx" ON "stock_lots"("raw_material_id");

-- CreateIndex
CREATE INDEX "stock_lots_product_id_idx" ON "stock_lots"("product_id");

-- CreateIndex
CREATE INDEX "stock_lots_expiry_date_idx" ON "stock_lots"("expiry_date");

-- CreateIndex
CREATE UNIQUE INDEX "stock_lots_company_id_lot_number_key" ON "stock_lots"("company_id", "lot_number");

-- CreateIndex
CREATE INDEX "stock_balances_establishment_id_raw_material_id_idx" ON "stock_balances"("establishment_id", "raw_material_id");

-- CreateIndex
CREATE INDEX "stock_balances_establishment_id_product_id_idx" ON "stock_balances"("establishment_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_balances_location_id_lot_id_key" ON "stock_balances"("location_id", "lot_id");

-- CreateIndex
CREATE INDEX "stock_movements_establishment_id_created_at_idx" ON "stock_movements"("establishment_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_movements_lot_id_idx" ON "stock_movements"("lot_id");

-- CreateIndex
CREATE INDEX "stock_movements_origin_type_origin_id_idx" ON "stock_movements"("origin_type", "origin_id");

-- CreateIndex
CREATE INDEX "stock_movements_raw_material_id_created_at_idx" ON "stock_movements"("raw_material_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_movements_product_id_created_at_idx" ON "stock_movements"("product_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "stock_thresholds_establishment_id_raw_material_id_key" ON "stock_thresholds"("establishment_id", "raw_material_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_thresholds_establishment_id_product_id_key" ON "stock_thresholds"("establishment_id", "product_id");

-- CreateIndex
CREATE INDEX "purchase_requests_establishment_id_status_idx" ON "purchase_requests"("establishment_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_requests_company_id_number_key" ON "purchase_requests"("company_id", "number");

-- CreateIndex
CREATE INDEX "purchase_orders_establishment_id_status_idx" ON "purchase_orders"("establishment_id", "status");

-- CreateIndex
CREATE INDEX "purchase_orders_supplier_id_idx" ON "purchase_orders"("supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_company_id_number_key" ON "purchase_orders"("company_id", "number");

-- CreateIndex
CREATE INDEX "purchase_order_items_order_id_idx" ON "purchase_order_items"("order_id");

-- CreateIndex
CREATE INDEX "goods_receipts_establishment_id_received_at_idx" ON "goods_receipts"("establishment_id", "received_at");

-- CreateIndex
CREATE INDEX "goods_receipts_supplier_id_idx" ON "goods_receipts"("supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "goods_receipts_company_id_number_key" ON "goods_receipts"("company_id", "number");

-- CreateIndex
CREATE INDEX "goods_receipt_items_receipt_id_idx" ON "goods_receipt_items"("receipt_id");

-- CreateIndex
CREATE INDEX "supplier_invoices_supplier_id_status_idx" ON "supplier_invoices"("supplier_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_invoices_company_id_number_key" ON "supplier_invoices"("company_id", "number");

-- CreateIndex
CREATE INDEX "supplier_invoice_receipts_receipt_id_idx" ON "supplier_invoice_receipts"("receipt_id");

-- CreateIndex
CREATE INDEX "supplier_payments_supplier_id_idx" ON "supplier_payments"("supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payments_company_id_number_key" ON "supplier_payments"("company_id", "number");

-- CreateIndex
CREATE INDEX "supplier_payment_allocations_payment_id_idx" ON "supplier_payment_allocations"("payment_id");

-- CreateIndex
CREATE INDEX "supplier_payment_allocations_invoice_id_idx" ON "supplier_payment_allocations"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_returns_company_id_number_key" ON "supplier_returns"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_credit_notes_return_id_key" ON "supplier_credit_notes"("return_id");

-- CreateIndex
CREATE INDEX "supplier_credit_notes_supplier_id_idx" ON "supplier_credit_notes"("supplier_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_credit_notes_company_id_number_key" ON "supplier_credit_notes"("company_id", "number");

-- CreateIndex
CREATE INDEX "inventory_sessions_location_id_status_idx" ON "inventory_sessions"("location_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_sessions_company_id_number_key" ON "inventory_sessions"("company_id", "number");

-- CreateIndex
CREATE INDEX "inventory_items_session_id_idx" ON "inventory_items"("session_id");

-- CreateIndex
CREATE INDEX "stock_adjustments_establishment_id_status_idx" ON "stock_adjustments"("establishment_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stock_adjustments_company_id_number_key" ON "stock_adjustments"("company_id", "number");

-- CreateIndex
CREATE INDEX "stock_losses_establishment_id_created_at_idx" ON "stock_losses"("establishment_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "stock_losses_company_id_number_key" ON "stock_losses"("company_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "location_moves_company_id_number_key" ON "location_moves"("company_id", "number");

-- CreateIndex
CREATE INDEX "stock_transfers_source_establishment_id_status_idx" ON "stock_transfers"("source_establishment_id", "status");

-- CreateIndex
CREATE INDEX "stock_transfers_dest_establishment_id_status_idx" ON "stock_transfers"("dest_establishment_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_company_id_number_key" ON "stock_transfers"("company_id", "number");

-- CreateIndex
CREATE INDEX "stock_transfer_items_transfer_id_idx" ON "stock_transfer_items"("transfer_id");

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_receipt_item_id_fkey" FOREIGN KEY ("receipt_item_id") REFERENCES "goods_receipt_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "stock_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_request_items" ADD CONSTRAINT "purchase_request_items_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "purchase_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "purchase_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "goods_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "purchase_order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoice_receipts" ADD CONSTRAINT "supplier_invoice_receipts_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "supplier_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_invoice_receipts" ADD CONSTRAINT "supplier_invoice_receipts_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "goods_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "supplier_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "supplier_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "goods_receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_return_items" ADD CONSTRAINT "supplier_return_items_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "supplier_returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_credit_notes" ADD CONSTRAINT "supplier_credit_notes_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "supplier_returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_credit_notes" ADD CONSTRAINT "supplier_credit_notes_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "supplier_invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "inventory_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "stock_transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lots" ADD CONSTRAINT "stock_transfer_lots_transfer_item_id_fkey" FOREIGN KEY ("transfer_item_id") REFERENCES "stock_transfer_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- Compléments manuels du module 3 (non exprimables dans le schéma Prisma).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Clés étrangères vers les tables des modules 1 et 2 (déclarées ici pour ne
-- pas modifier les modèles Prisma de ces modules).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
BEGIN
  -- company_id
  FOREACH t IN ARRAY ARRAY['stock_locations','stock_lots','stock_balances','stock_movements','stock_thresholds',
    'purchase_requests','purchase_orders','goods_receipts','supplier_invoices','supplier_payments','supplier_returns',
    'supplier_credit_notes','inventory_sessions','stock_adjustments','stock_losses','location_moves','stock_transfers'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (company_id) REFERENCES companies(id)', t, t || '_company_fk');
  END LOOP;
  -- establishment_id
  FOREACH t IN ARRAY ARRAY['stock_locations','stock_balances','stock_movements','stock_thresholds','purchase_requests',
    'purchase_orders','goods_receipts','supplier_invoices','supplier_payments','supplier_returns','inventory_sessions',
    'stock_adjustments','stock_losses','location_moves'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (establishment_id) REFERENCES establishments(id)', t, t || '_establishment_fk');
  END LOOP;
  -- raw_material_id / product_id + « exactement un article »
  FOREACH t IN ARRAY ARRAY['stock_lots','stock_balances','stock_movements','stock_thresholds','purchase_request_items',
    'purchase_order_items','goods_receipt_items','inventory_items','stock_adjustments','stock_losses','location_moves',
    'stock_transfer_items'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (raw_material_id) REFERENCES raw_materials(id)', t, t || '_raw_material_fk');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (product_id) REFERENCES products(id)', t, t || '_product_fk');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ((raw_material_id IS NULL) <> (product_id IS NULL))', t, t || '_item_chk');
  END LOOP;
  -- supplier_id
  FOREACH t IN ARRAY ARRAY['stock_lots','purchase_orders','goods_receipts','supplier_invoices','supplier_payments',
    'supplier_returns','supplier_credit_notes'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (supplier_id) REFERENCES suppliers(id)', t, t || '_supplier_fk');
  END LOOP;
END $$;

ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_supplier_product_fk"
  FOREIGN KEY ("supplier_product_id") REFERENCES "supplier_products"("id");

-- Emplacements référencés par les documents de stock.
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_location_fk" FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id");
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_lot_fk" FOREIGN KEY ("lot_id") REFERENCES "stock_lots"("id");
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_location_fk" FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id");
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_location_fk" FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id");
ALTER TABLE "supplier_return_items" ADD CONSTRAINT "supplier_return_items_lot_fk" FOREIGN KEY ("lot_id") REFERENCES "stock_lots"("id");
ALTER TABLE "inventory_sessions" ADD CONSTRAINT "inventory_sessions_location_fk" FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id");
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_location_fk" FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id");
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_lot_fk" FOREIGN KEY ("lot_id") REFERENCES "stock_lots"("id");
ALTER TABLE "stock_losses" ADD CONSTRAINT "stock_losses_location_fk" FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id");
ALTER TABLE "stock_losses" ADD CONSTRAINT "stock_losses_lot_fk" FOREIGN KEY ("lot_id") REFERENCES "stock_lots"("id");
ALTER TABLE "stock_losses" ADD CONSTRAINT "stock_losses_transfer_fk" FOREIGN KEY ("transfer_id") REFERENCES "stock_transfers"("id");
ALTER TABLE "location_moves" ADD CONSTRAINT "location_moves_from_fk" FOREIGN KEY ("from_location_id") REFERENCES "stock_locations"("id");
ALTER TABLE "location_moves" ADD CONSTRAINT "location_moves_to_fk" FOREIGN KEY ("to_location_id") REFERENCES "stock_locations"("id");
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_source_fk" FOREIGN KEY ("source_establishment_id") REFERENCES "establishments"("id");
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_dest_fk" FOREIGN KEY ("dest_establishment_id") REFERENCES "establishments"("id");
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_source_location_fk" FOREIGN KEY ("source_location_id") REFERENCES "stock_locations"("id");
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_dest_location_fk" FOREIGN KEY ("dest_location_id") REFERENCES "stock_locations"("id");
ALTER TABLE "stock_transfer_lots" ADD CONSTRAINT "stock_transfer_lots_lot_fk" FOREIGN KEY ("lot_id") REFERENCES "stock_lots"("id");

-- ---------------------------------------------------------------------------
-- Règles d'intégrité.
-- ---------------------------------------------------------------------------

-- Jamais de stock négatif, ni de réservé supérieur au physique.
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_quantity_chk"
  CHECK ("quantity" >= 0 AND "reserved_quantity" >= 0 AND "reserved_quantity" <= "quantity");

ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_cost_chk" CHECK ("unit_cost" >= 0);
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_quantity_chk" CHECK ("quantity" <> 0 AND "balance_after" >= 0);
ALTER TABLE "stock_thresholds" ADD CONSTRAINT "stock_thresholds_chk" CHECK ("min_quantity" >= 0 AND "alert_quantity" >= "min_quantity");
ALTER TABLE "purchase_request_items" ADD CONSTRAINT "purchase_request_items_qty_chk" CHECK ("quantity" > 0);
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_chk"
  CHECK ("ordered_quantity" > 0 AND "quantity_per_purchase_unit" > 0 AND "unit_price" >= 0
         AND "discount_amount" >= 0 AND "line_total" >= 0 AND "received_quantity" >= 0);
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_amounts_chk"
  CHECK ("discount_amount" >= 0 AND "subtotal" >= 0 AND "total" >= 0);
ALTER TABLE "goods_receipt_items" ADD CONSTRAINT "goods_receipt_items_chk"
  CHECK ("received_quantity" > 0 AND "rejected_quantity" >= 0 AND "rejected_quantity" <= "received_quantity"
         AND "accepted_quantity" = "received_quantity" - "rejected_quantity"
         AND "unit_price" >= 0 AND "line_value" >= 0 AND "quantity_per_purchase_unit" > 0);
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_chk"
  CHECK ("amount" > 0 AND "paid_amount" >= 0 AND "paid_amount" <= "amount" AND "due_date" >= "invoice_date");
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_amount_chk" CHECK ("amount" > 0);
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_amount_chk" CHECK ("amount" > 0);
ALTER TABLE "supplier_return_items" ADD CONSTRAINT "supplier_return_items_chk" CHECK ("quantity" > 0 AND "value" >= 0);
ALTER TABLE "supplier_credit_notes" ADD CONSTRAINT "supplier_credit_notes_amount_chk" CHECK ("amount" >= 0);
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_chk"
  CHECK ("theoretical_quantity" >= 0 AND ("counted_quantity" IS NULL OR "counted_quantity" >= 0) AND ("unit_cost" IS NULL OR "unit_cost" >= 0));
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_chk" CHECK ("quantity" > 0 AND ("unit_cost" IS NULL OR "unit_cost" >= 0));
ALTER TABLE "stock_losses" ADD CONSTRAINT "stock_losses_chk" CHECK ("quantity" > 0 AND "estimated_value" >= 0);
ALTER TABLE "location_moves" ADD CONSTRAINT "location_moves_chk" CHECK ("quantity" > 0 AND "from_location_id" <> "to_location_id");
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_chk" CHECK ("source_establishment_id" <> "dest_establishment_id");
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_chk"
  CHECK ("requested_quantity" > 0 AND ("prepared_quantity" IS NULL OR "prepared_quantity" >= 0)
         AND ("shipped_quantity" IS NULL OR "shipped_quantity" >= 0)
         AND ("received_quantity" IS NULL OR ("received_quantity" >= 0 AND "received_quantity" <= "shipped_quantity")));
ALTER TABLE "stock_transfer_lots" ADD CONSTRAINT "stock_transfer_lots_chk"
  CHECK ("shipped_quantity" > 0 AND ("received_quantity" IS NULL OR ("received_quantity" >= 0 AND "received_quantity" <= "shipped_quantity")));

-- Un seul emplacement par défaut par établissement.
CREATE UNIQUE INDEX "stock_locations_default_uniq" ON "stock_locations" ("establishment_id") WHERE "is_default";

-- Un seul inventaire ouvert à la fois par emplacement.
CREATE UNIQUE INDEX "inventory_sessions_open_uniq" ON "inventory_sessions" ("location_id") WHERE "status" = 'OPEN';

-- ---------------------------------------------------------------------------
-- Journal des mouvements de stock : en ajout seul, même en SQL direct.
-- (La fonction forbid_update_delete est créée par la migration du module 1.)
-- ---------------------------------------------------------------------------
CREATE TRIGGER stock_movements_append_only
  BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

-- Les soldes ne sont jamais supprimés (un solde épuisé reste à 0).
CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Suppression interdite sur la table %', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_balances_no_delete BEFORE DELETE ON "stock_balances"
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER stock_lots_no_delete BEFORE DELETE ON "stock_lots"
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER supplier_payments_no_delete BEFORE DELETE ON "supplier_payments"
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER supplier_invoices_no_delete BEFORE DELETE ON "supplier_invoices"
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER goods_receipts_no_delete BEFORE DELETE ON "goods_receipts"
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------------------
-- « Magasin principal » pour les établissements déjà existants.
-- Les nouveaux établissements le reçoivent automatiquement à la première
-- utilisation du stock (création idempotente côté application).
-- ---------------------------------------------------------------------------
INSERT INTO "stock_locations" ("id", "company_id", "establishment_id", "code", "name", "is_default", "is_active", "created_at", "updated_at")
SELECT gen_random_uuid(), e."company_id", e."id", 'PRINCIPAL', 'Magasin principal', true, true, now(), now()
FROM "establishments" e
WHERE e."deleted_at" IS NULL;
