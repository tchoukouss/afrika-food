-- Module 7, étape 4 : mouvements de caisse des paiements clients (extension du module 5, décision D1).
-- Migration séparée : une nouvelle valeur d'énumération ne s'utilise pas dans la transaction qui la crée.
ALTER TYPE "CashMovementType" ADD VALUE 'CUSTOMER_PAYMENT';
ALTER TYPE "CashMovementType" ADD VALUE 'CUSTOMER_REFUND';
