-- Module 6 — nouvelles valeurs de l'énumération des mouvements du module 3 (décision R12).
-- Seule modification du module 3 : sortie cuisine et retour cuisine.

ALTER TYPE "StockMovementType" ADD VALUE 'ORDER_CONSUMPTION';
ALTER TYPE "StockMovementType" ADD VALUE 'ORDER_RETURN';
