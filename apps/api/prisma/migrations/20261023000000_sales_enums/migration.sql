-- Module 5 — nouvelles valeurs de l'énumération des mouvements du module 3 (ventes).
-- Seule modification autorisée du module 3 : types de mouvement SALE et SALE_RETURN.

ALTER TYPE "StockMovementType" ADD VALUE 'SALE';
ALTER TYPE "StockMovementType" ADD VALUE 'SALE_RETURN';
