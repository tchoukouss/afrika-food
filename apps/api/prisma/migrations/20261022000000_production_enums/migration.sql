-- Module 4 — nouvelles valeurs des énumérations du module 3 (production).
-- Seule modification autorisée du module 3 : origine de lot et types de mouvement.

ALTER TYPE "LotOrigin" ADD VALUE 'PRODUCTION';
ALTER TYPE "StockMovementType" ADD VALUE 'CONSUMPTION';
ALTER TYPE "StockMovementType" ADD VALUE 'PRODUCTION';
