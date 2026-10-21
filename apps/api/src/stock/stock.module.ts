import { Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { StockEngine } from './engine';
import { InventoryController, InventoryService } from './inventory';
import { StockOperationsController, StockOperationsService } from './operations';
import { PurchasesController, PurchasesService } from './purchases';
import { ReceiptsController, ReceiptsService } from './receipts';
import { StockViewController, StockViewService } from './stock-view';
import { SupplierFinanceController, SupplierFinanceService } from './supplier-finance';
import { TransfersController, TransfersService } from './transfers';

// Module 3 — Achats & stock : emplacements, lots, mouvements, achats,
// réceptions, factures / paiements / retours fournisseurs, pertes,
// corrections, inventaires et transferts entre établissements.
@Module({
  controllers: [
    StockViewController,
    PurchasesController,
    ReceiptsController,
    SupplierFinanceController,
    StockOperationsController,
    InventoryController,
    TransfersController,
  ],
  providers: [
    AuditService,
    StockEngine,
    StockViewService,
    PurchasesService,
    ReceiptsService,
    SupplierFinanceService,
    StockOperationsService,
    InventoryService,
    TransfersService,
  ],
})
export class StockModule {}
