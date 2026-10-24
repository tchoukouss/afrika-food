import { Module } from '@nestjs/common';
import { DashboardController, DashboardService } from './dashboard';
import { OperationsKpiController, OperationsKpiService } from './operations';
import { PilotageController, PilotageService } from './pilotage';
import { ReceivablesKpiController, ReceivablesKpiService } from './receivables';
import { SalesKpiController, SalesKpiService } from './sales';

// Module 8 — Pilotage : étape 1 (chiffre d'affaires, encaissements,
// rapprochement), étape 2 (créances, acomptes, clients), étape 3 (ventes
// détaillées, catégories historiques, marge brute, caisse), étape 4 (achats,
// stock, production), étape 5 (tableau de bord consolidé, contrôles, exports),
// calculés à la lecture depuis les écritures des modules 3 à 7.
// Lecture seule : aucune écriture, aucune table de cache.
@Module({
  controllers: [PilotageController, ReceivablesKpiController, SalesKpiController, OperationsKpiController, DashboardController],
  providers: [PilotageService, ReceivablesKpiService, SalesKpiService, OperationsKpiService, DashboardService],
})
export class ReportingModule {}
