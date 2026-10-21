import { Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { CostingService } from '../production/costing';
import { ProductionService } from '../production/production';
import { SequenceService } from '../sequences/sequence.service';
import { StockEngine } from '../stock/engine';
import { NetworkPrinter } from './printer';
import { RegistersController, RegistersService } from './registers';
import { SalesController, SalesService } from './sales';
import { CashSessionsController, CashSessionsService } from './sessions';

// Module 5 — Caisse & ventes : caisses et imprimantes, sessions (fond, mouvements,
// clôture, validation, rapport Z), encaissement multi-moyens, remises, annulation,
// remboursement, tickets (impression réseau, navigateur, duplicata) et
// traçabilité lot ↔ vente. Réutilise tels quels le moteur de stock (module 3),
// la numérotation et l'audit (module 1) et la traçabilité des lots (module 4).
@Module({
  controllers: [RegistersController, CashSessionsController, SalesController],
  providers: [AuditService, StockEngine, SequenceService, CostingService, ProductionService, NetworkPrinter, RegistersService, CashSessionsService, SalesService],
})
export class SalesModule {}
