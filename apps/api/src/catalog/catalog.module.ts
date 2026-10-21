import { Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { CategoriesController, CategoriesService } from './categories';
import { ProductsController, ProductsService } from './products';
import { RawMaterialsController, RawMaterialsService } from './raw-materials';
import { SuppliersController, SuppliersService } from './suppliers';

// Module 2 — Catalogue : unités, catégories, matières premières,
// conditionnements, fournisseurs, offres fournisseurs, produits et prix.
@Module({
  controllers: [CategoriesController, RawMaterialsController, SuppliersController, ProductsController],
  providers: [AuditService, CategoriesService, RawMaterialsService, SuppliersService, ProductsService],
})
export class CatalogModule {}
