import { Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { CostingService } from '../production/costing';
import { SalesModule } from '../sales/sales.module';
import { ProductionService } from '../production/production';
import { SequenceService } from '../sequences/sequence.service';
import { StockEngine } from '../stock/engine';
import { CreditController, CustomerCreditService } from './credit';
import { CustomersController, CustomersService } from './customers';
import { DeliveriesController, DeliveriesService } from './deliveries';
import { InvoicesController, InvoicesService } from './invoices';
import { CustomerOrdersController, CustomerOrdersService } from './orders';
import { CustomerPaymentsController, CustomerPaymentsService } from './payments';
import { QuotesController, QuotesService } from './quotes';
import { CustomerOrderStock } from './stock';

// Module 7 — Clients & facturation, étape 1 : fichier clients commun au groupe
// (décision D9), encours et contrôle du crédit sous verrou du client,
// pré-autorisations de dépassement (décision D4). Étape 2 : devis, commandes
// clients et événements (décision D10). Le service de crédit est exporté pour
// les étapes suivantes (factures, paiements, caisse, restaurant). Étape 3 :
// réservations, fabrication à la demande (module 4) et livraisons, sur le
// moteur de stock du module 3 (décision D5). Étape 4 : paiements clients,
// répartitions et acomptes, encaissés par la caisse du module 5 (décision D1).
// Étape 5 : factures (FAC), avoirs (AVR) et créances calculées (D2, D3, D7).
@Module({
  // Vente à crédit : traitement de la créance enregistré auprès de la caisse (SalesService).
  imports: [SalesModule],
  controllers: [CustomersController, CreditController, QuotesController, CustomerOrdersController, DeliveriesController, CustomerPaymentsController, InvoicesController],
  providers: [
    AuditService,
    SequenceService,
    StockEngine,
    CostingService,
    ProductionService,
    CustomerCreditService,
    CustomersService,
    CustomerOrderStock,
    CustomerOrdersService,
    QuotesService,
    DeliveriesService,
    CustomerPaymentsService,
    InvoicesService,
  ],
  exports: [CustomerCreditService],
})
export class CustomersModule {}
