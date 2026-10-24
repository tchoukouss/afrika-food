-- Module 7, étape 5 : un paiement se répartit aussi sur une facture.
-- Migration séparée : une nouvelle valeur d'énumération ne s'utilise pas dans la transaction qui la crée.
ALTER TYPE "AllocationTarget" ADD VALUE 'INVOICE';
