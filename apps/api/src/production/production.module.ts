import { Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { StockEngine } from '../stock/engine';
import { CostingService } from './costing';
import { ProductionController, ProductionService } from './production';
import { RecipesController, RecipesService } from './recipes';

// Module 4 — Recettes & production : fiches techniques versionnées, coût de
// revient et marge, ordres de production (réservation, consommation par lot,
// produits finis, pertes, contrôle) et traçabilité des lots.
// Le moteur de stock du module 3 est réutilisé tel quel.
@Module({
  controllers: [RecipesController, ProductionController],
  providers: [AuditService, StockEngine, CostingService, RecipesService, ProductionService],
})
export class ProductionModule {}
