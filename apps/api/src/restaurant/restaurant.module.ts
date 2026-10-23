import { Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { CostingService } from '../production/costing';
import { ProductionService } from '../production/production';
import { NetworkPrinter } from '../sales/printer';
import { SalesModule } from '../sales/sales.module';
import { SequenceService } from '../sequences/sequence.service';
import { StockEngine } from '../stock/engine';
import { BillsController, BillsService } from './bills';
import { RestaurantConsumption } from './consumption';
import { FloorController, FloorService } from './floor';
import { KitchenController, KitchenService } from './kitchen';
import { MenuController, MenuService } from './menu';
import { OrdersController, OrdersService } from './orders';
import { RestaurantPrinting } from './printing';
import { ReservationsController, ReservationsService } from './reservations';
import { RestaurantTraceability, TraceabilityController } from './traceability';

// Module 6 — Restaurant & commandes : salles et tables (statuts calculés),
// carte (préparé à la commande / depuis le stock, postes, suppléments,
// options), commandes (table, comptoir, emporter, téléphone, en ligne,
// livraison), envoi en cuisine avec sortie de stock, écran cuisine, additions
// encaissées par la caisse du module 5, réservations et traçabilité.
// Réutilise le moteur de stock (module 3), les recettes et la traçabilité
// (module 4), l'encaissement, l'impression et la numérotation (modules 1 et 5).
@Module({
  imports: [SalesModule],
  controllers: [FloorController, MenuController, OrdersController, KitchenController, BillsController, ReservationsController, TraceabilityController],
  providers: [
    AuditService,
    StockEngine,
    SequenceService,
    CostingService,
    ProductionService,
    NetworkPrinter,
    RestaurantPrinting,
    RestaurantConsumption,
    FloorService,
    MenuService,
    OrdersService,
    KitchenService,
    BillsService,
    ReservationsService,
    RestaurantTraceability,
  ],
})
export class RestaurantModule {}
