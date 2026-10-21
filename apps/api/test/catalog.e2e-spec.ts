import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { ADMIN_EMAIL, ADMIN_PASSWORD, api, createAndLogin, createTestApp, login, resetDatabase, Session } from './helpers';

type Id = { id: string };

describe('Module 2 — Catalogue', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: Session;
  let manager: Session; // Responsable, Plateau uniquement
  let storekeeper: Session; // Magasinier, Plateau
  let purchaser: Session; // Responsable achats, Yopougon
  let cashier: Session; // Caissier, Plateau
  let roles: Record<string, string>;
  let plateau: string;
  let yopougon: string;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    admin = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const list = await api(app, admin).get('/api/roles').expect(200);
    roles = Object.fromEntries(list.body.map((r: { code: string; id: string }) => [r.code, r.id]));
    plateau = (await api(app, admin).post('/api/establishments').send({ code: 'PLT', name: 'Pâtisserie Plateau', type: 'PATISSERIE' }).expect(201)).body.id;
    yopougon = (await api(app, admin).post('/api/establishments').send({ code: 'YOP', name: 'Restaurant Yopougon', type: 'RESTAURANT' }).expect(201)).body.id;
    manager = await createAndLogin(app, admin, { email: 'resp@test.ci', fullName: 'Resp Plateau', roles: [{ roleId: roles.MANAGER, establishmentId: plateau }] });
    storekeeper = await createAndLogin(app, admin, { email: 'mag@test.ci', fullName: 'Magasinier', roles: [{ roleId: roles.STOREKEEPER, establishmentId: plateau }] });
    purchaser = await createAndLogin(app, admin, { email: 'achat@test.ci', fullName: 'Acheteur Yop', roles: [{ roleId: roles.PURCHASER, establishmentId: yopougon }] });
    cashier = await createAndLogin(app, admin, { email: 'caisse@test.ci', fullName: 'Caissier', roles: [{ roleId: roles.CASHIER, establishmentId: plateau }] });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Unités et catégories', () => {
    it('expose le référentiel des unités avec les conversions', async () => {
      const res = await api(app, cashier, plateau).get('/api/units').expect(200);
      const g = res.body.find((u: { code: string }) => u.code === 'G');
      expect(res.body).toHaveLength(6);
      expect(Number(g.factorToBase)).toBe(0.001);
    });

    it('crée des catégories au niveau groupe uniquement et refuse les doublons', async () => {
      await api(app, admin).post('/api/raw-material-categories').send({ name: 'Farines' }).expect(201);
      await api(app, admin).post('/api/raw-material-categories').send({ name: 'Farines' }).expect(409);
      await api(app, manager, plateau).post('/api/raw-material-categories').send({ name: 'Sucres' }).expect(403);
      await api(app, admin).post('/api/product-categories').send({ name: 'Viennoiseries', color: '#C2410C', sortOrder: 1 }).expect(201);
      await api(app, admin).post('/api/product-categories').send({ name: 'Boissons', color: 'rouge' }).expect(400);
      const res = await api(app, storekeeper, plateau).get('/api/raw-material-categories').expect(200);
      expect(res.body.map((c: { name: string }) => c.name)).toEqual(['Farines']);
    });
  });

  describe('Matières premières — farine en sacs et en kg', () => {
    let farine: Id & { packagings: (Id & { name: string; isDefault: boolean })[] };

    it('crée la farine T55 avec ses conditionnements', async () => {
      const cat = (await api(app, admin).get('/api/raw-material-categories').expect(200)).body[0];
      const res = await api(app, admin)
        .post('/api/raw-materials')
        .send({
          code: 'far-t55',
          name: 'Farine T55',
          categoryId: cat.id,
          baseUnitCode: 'KG',
          isPerishable: true,
          packagings: [
            { name: 'Sac 25 kg', quantity: 25, isDefault: true },
            { name: 'Sac 50 kg', quantity: 50 },
          ],
        })
        .expect(201);
      farine = res.body;
      expect(res.body.code).toBe('FAR-T55');
      expect(res.body.packagings.map((p: { quantity: string }) => Number(p.quantity))).toEqual([25, 50]);
    });

    it('refuse les données incohérentes', async () => {
      await api(app, admin).post('/api/raw-materials').send({ code: 'FAR-T55', name: 'Doublon', baseUnitCode: 'KG' }).expect(409);
      await api(app, admin).post('/api/raw-materials').send({ code: 'SUC', name: 'Sucre', baseUnitCode: 'G' }).expect(400);
      await api(app, admin)
        .post('/api/raw-materials')
        .send({ code: 'BEU', name: 'Beurre', baseUnitCode: 'KG', packagings: [{ name: 'A', quantity: 1, isDefault: true }, { name: 'B', quantity: 2, isDefault: true }] })
        .expect(400);
      await api(app, admin).post('/api/raw-materials').send({ code: 'OEU', name: 'Œufs', baseUnitCode: 'U', packagings: [{ name: 'Plaquette', quantity: 0 }] }).expect(400);
    });

    it('réserve la création au niveau groupe, la lecture au magasinier', async () => {
      await api(app, storekeeper, plateau).post('/api/raw-materials').send({ code: 'SUC', name: 'Sucre', baseUnitCode: 'KG' }).expect(403);
      await api(app, manager, plateau).post('/api/raw-materials').send({ code: 'SUC', name: 'Sucre', baseUnitCode: 'KG' }).expect(403);
      const res = await api(app, storekeeper, plateau).get('/api/raw-materials?search=t55').expect(200);
      expect(res.body).toHaveLength(1);
      await api(app, cashier, plateau).get('/api/suppliers').expect(403);
    });

    it("garde un seul conditionnement par défaut et interdit de changer l'unité de base", async () => {
      const added = await api(app, admin).post(`/api/raw-materials/${farine.id}/packagings`).send({ name: 'Sac 10 kg', quantity: 10, isDefault: true }).expect(201);
      const res = await api(app, admin).get(`/api/raw-materials/${farine.id}`).expect(200);
      const defaults = res.body.packagings.filter((p: { isDefault: boolean }) => p.isDefault);
      expect(defaults.map((p: Id) => p.id)).toEqual([added.body.id]);
      await api(app, admin).patch(`/api/raw-materials/${farine.id}`).send({ baseUnitCode: 'L' }).expect(409);
    });

    it('archive sans supprimer', async () => {
      const m = await api(app, admin).post('/api/raw-materials').send({ code: 'ARO-VAN', name: 'Arôme vanille', baseUnitCode: 'L' }).expect(201);
      await api(app, admin).patch(`/api/raw-materials/${m.body.id}`).send({ isActive: false }).expect(200);
      const active = await api(app, admin).get('/api/raw-materials').expect(200);
      const all = await api(app, admin).get('/api/raw-materials?includeInactive=true').expect(200);
      expect(active.body.some((x: Id) => x.id === m.body.id)).toBe(false);
      expect(all.body.some((x: Id) => x.id === m.body.id)).toBe(true);
      expect(await prisma.auditLog.count({ where: { entityId: m.body.id, action: 'RAW_MATERIAL_ARCHIVED' } })).toBe(1);
    });
  });

  describe('Fournisseurs et offres', () => {
    let supplier: Id;
    let farineId: string;
    let offerA: Id;

    beforeAll(async () => {
      farineId = (await api(app, admin).get('/api/raw-materials?search=FAR-T55').expect(200)).body[0].id;
    });

    it('permet à un responsable achats de tout site de tenir le fichier fournisseurs', async () => {
      const res = await api(app, purchaser, yopougon)
        .post('/api/suppliers')
        .send({ code: 'gma', name: 'Grands Moulins', phone: '+225 27 00 00 00', email: 'Contact@GM.ci', paymentTermsDays: 30, creditLimit: 5_000_000 })
        .expect(201);
      supplier = res.body;
      expect(res.body.email).toBe('contact@gm.ci');
      expect(res.body.creditLimit).toBe('5000000');
      await api(app, purchaser, yopougon).post('/api/suppliers').send({ code: 'GMA', name: 'Doublon' }).expect(409);
      await api(app, purchaser, yopougon).post('/api/suppliers').send({ code: 'X1', name: 'Mauvais', email: 'pas-un-email' }).expect(400);
      await api(app, cashier, plateau).post('/api/suppliers').send({ code: 'X2', name: 'Interdit' }).expect(403);
    });

    it('calcule le prix au kg à partir du prix du sac', async () => {
      const res = await api(app, purchaser, yopougon)
        .post('/api/supplier-products')
        .send({ supplierId: supplier.id, rawMaterialId: farineId, brand: 'Marque A', purchaseUnitLabel: 'Sac 25 kg', quantityPerPurchaseUnit: 25, unitPrice: 18500, isPreferred: true })
        .expect(201);
      offerA = res.body;
      expect(res.body.pricePerBaseUnit).toBe(740);
    });

    it("garde une seule offre préférée par article", async () => {
      const b = await api(app, purchaser, yopougon)
        .post('/api/supplier-products')
        .send({ supplierId: supplier.id, rawMaterialId: farineId, brand: 'Marque B', purchaseUnitLabel: 'Sac 50 kg', quantityPerPurchaseUnit: 50, unitPrice: 36000, isPreferred: true })
        .expect(201);
      const offers = await prisma.supplierProduct.findMany({ where: { rawMaterialId: farineId, isPreferred: true } });
      expect(offers.map((o) => o.id)).toEqual([b.body.id]);
      const m = await api(app, storekeeper, plateau).get(`/api/raw-materials/${farineId}`).expect(200);
      expect(m.body.supplierProducts.map((o: { brand: string; pricePerBaseUnit: number }) => [o.brand, o.pricePerBaseUnit])).toEqual([
        ['Marque B', 720],
        ['Marque A', 740],
      ]);
    });

    it('trace le changement de prix fournisseur', async () => {
      await api(app, purchaser, yopougon).patch(`/api/supplier-products/${offerA.id}`).send({ unitPrice: 19000 }).expect(200);
      const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: offerA.id, action: 'SUPPLIER_PRICE_CHANGED' } });
      expect(log.oldValues).toEqual({ unitPrice: '18500' });
      expect(log.newValues).toEqual({ unitPrice: '19000' });
    });

    it('exige exactement un article par offre, et un produit « revendu »', async () => {
      const croissant = await api(app, admin).post('/api/products').send({ code: 'CRO', name: 'Croissant', type: 'MANUFACTURED' }).expect(201);
      await api(app, purchaser, yopougon)
        .post('/api/supplier-products')
        .send({ supplierId: supplier.id, rawMaterialId: farineId, productId: croissant.body.id, purchaseUnitLabel: 'X', quantityPerPurchaseUnit: 1 })
        .expect(400);
      await api(app, purchaser, yopougon).post('/api/supplier-products').send({ supplierId: supplier.id, purchaseUnitLabel: 'X', quantityPerPurchaseUnit: 1 }).expect(400);
      await api(app, purchaser, yopougon)
        .post('/api/supplier-products')
        .send({ supplierId: supplier.id, productId: croissant.body.id, purchaseUnitLabel: 'X', quantityPerPurchaseUnit: 1 })
        .expect(400);
      // Contrainte également garantie par la base.
      await expect(
        prisma.supplierProduct.create({ data: { supplierId: supplier.id, purchaseUnitLabel: 'X', quantityPerPurchaseUnit: 1 } }),
      ).rejects.toThrow();
    });
  });

  describe('Produits et prix', () => {
    let croissant: string;
    let coca: string;

    beforeAll(async () => {
      croissant = (await api(app, admin).get('/api/products?search=CRO').expect(200)).body[0].id;
    });

    it('crée un produit revendu avec prix de base et refuse les doublons', async () => {
      const res = await api(app, admin)
        .post('/api/products')
        .send({ code: 'COCA-33', name: 'Coca-Cola 33 cl', type: 'RESOLD', barcode: '5449000000996', taxRate: 18, basePrice: 500 })
        .expect(201);
      coca = res.body.id;
      expect(res.body.basePrice).toBe('500');
      expect(Number(res.body.taxRate)).toBe(18);
      await api(app, admin).post('/api/products').send({ code: 'COCA-2', name: 'Doublon code-barres', type: 'RESOLD', barcode: '5449000000996' }).expect(409);
      await api(app, admin).post('/api/products').send({ code: 'X', name: 'TVA invalide', type: 'RESOLD', taxRate: 150 }).expect(400);
      await api(app, admin).post('/api/products').send({ code: 'Y', name: 'Unité inconnue', type: 'RESOLD', saleUnitCode: 'SAC' }).expect(400);
    });

    it('réserve la création de produit au niveau groupe', async () => {
      await api(app, manager, plateau).post('/api/products').send({ code: 'TAR', name: 'Tarte', type: 'MANUFACTURED' }).expect(403);
    });

    it('historise chaque changement de prix sans rien écraser', async () => {
      await api(app, admin).put(`/api/products/${croissant}/price`).send({ price: 300 }).expect(200);
      await api(app, admin).put(`/api/products/${croissant}/price`).send({ price: 350, reason: 'Hausse du beurre' }).expect(200);
      // Même prix : aucune nouvelle ligne.
      await api(app, admin).put(`/api/products/${croissant}/price`).send({ price: 350 }).expect(200);
      const history = await api(app, admin).get(`/api/products/${croissant}/price-history`).expect(200);
      expect(history.body.map((h: { price: string; validTo: string | null }) => [h.price, h.validTo === null])).toEqual([
        ['350', true],
        ['300', false],
      ]);
      expect(history.body[0].reason).toBe('Hausse du beurre');
      expect(history.body[0].createdBy.fullName).toBe('Admin Test');
    });

    it("applique le prix d'exception d'un établissement, sinon le prix de base", async () => {
      await api(app, manager, plateau).put(`/api/products/${croissant}/price`).send({ price: 400, establishmentId: plateau }).expect(200);
      const atPlateau = await api(app, cashier, plateau).get('/api/products').expect(200);
      const atYop = await api(app, admin, yopougon).get('/api/products').expect(200);
      const find = (body: (Id & { price: string })[]) => body.find((p) => p.id === croissant)!.price;
      expect(find(atPlateau.body)).toBe('400');
      expect(find(atYop.body)).toBe('350');
      const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: croissant, action: 'PRICE_CHANGED', establishmentId: plateau } });
      expect(log.newValues).toMatchObject({ price: '400', scope: plateau });
    });

    it('limite chaque responsable à ses établissements', async () => {
      await api(app, manager, plateau).put(`/api/products/${croissant}/price`).send({ price: 1, establishmentId: yopougon }).expect(403);
      await api(app, manager, plateau).put(`/api/products/${croissant}/price`).send({ price: 1 }).expect(403);
      await api(app, cashier, plateau).put(`/api/products/${croissant}/price`).send({ price: 1, establishmentId: plateau }).expect(403);
    });

    it("revient au prix de base quand l'exception est supprimée", async () => {
      await api(app, manager, plateau).delete(`/api/products/${croissant}/price/${plateau}`).expect(200);
      const res = await api(app, cashier, plateau).get('/api/products').expect(200);
      expect(res.body.find((p: Id) => p.id === croissant).price).toBe('350');
      await api(app, manager, plateau).delete(`/api/products/${croissant}/price/${plateau}`).expect(404);
    });

    it('reste cohérent avec 10 changements de prix simultanés', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => api(app, admin).put(`/api/products/${coca}/price`).send({ price: 600 + i * 10 })),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      const rows = await prisma.productPrice.findMany({ where: { productId: coca, establishmentId: null }, orderBy: { validFrom: 'asc' } });
      expect(rows.filter((r) => r.validTo === null)).toHaveLength(1);
      expect(rows).toHaveLength(11);
      // Chaque prix se termine exactement quand le suivant commence : aucun trou, aucun chevauchement.
      for (let i = 0; i < rows.length - 1; i++) expect(rows[i].validTo!.getTime()).toBe(rows[i + 1].validFrom.getTime());
    });

    it("protège l'historique des prix au niveau de la base", async () => {
      await expect(prisma.$executeRaw`DELETE FROM product_prices`).rejects.toThrow(/suppression interdite/);
      await expect(prisma.$executeRaw`UPDATE product_prices SET price = 1`).rejects.toThrow(/clôture/);
      await expect(
        prisma.productPrice.create({ data: { productId: coca, establishmentId: null, price: 1n } }),
      ).rejects.toThrow(); // second prix « en vigueur » refusé par l'index unique partiel
    });

    it('gère la disponibilité par établissement', async () => {
      await api(app, manager, plateau).put(`/api/products/${croissant}/availability`).send({ establishmentId: plateau, isAvailable: false }).expect(200);
      const atPlateau = await api(app, cashier, plateau).get('/api/products').expect(200);
      const atYop = await api(app, admin, yopougon).get('/api/products').expect(200);
      expect(atPlateau.body.find((p: Id) => p.id === croissant).isAvailable).toBe(false);
      expect(atYop.body.find((p: Id) => p.id === croissant).isAvailable).toBe(true);
      await api(app, manager, plateau).put(`/api/products/${croissant}/availability`).send({ establishmentId: yopougon, isAvailable: false }).expect(403);
    });

    it('compose un menu et refuse les compositions invalides', async () => {
      const menu = await api(app, admin)
        .post('/api/products')
        .send({ code: 'FORM-PDJ', name: 'Formule petit-déjeuner', type: 'MENU', basePrice: 1000, components: [{ productId: croissant, quantity: 1 }, { productId: coca, quantity: 1 }] })
        .expect(201);
      expect(menu.body.menuComponents).toHaveLength(2);
      await api(app, admin).put(`/api/products/${menu.body.id}/components`).send({ components: [{ productId: menu.body.id, quantity: 1 }] }).expect(400);
      const other = await api(app, admin).post('/api/products').send({ code: 'FORM-2', name: 'Autre formule', type: 'MENU' }).expect(201);
      await api(app, admin).put(`/api/products/${other.body.id}/components`).send({ components: [{ productId: menu.body.id, quantity: 1 }] }).expect(400);
      await api(app, admin).put(`/api/products/${croissant}/components`).send({ components: [{ productId: coca, quantity: 1 }] }).expect(400);
      await api(app, admin).patch(`/api/products/${menu.body.id}`).send({ type: 'MANUFACTURED' }).expect(409);
      await api(app, admin).patch(`/api/products/${croissant}`).send({ type: 'MENU' }).expect(409);
    });

    it("empêche de changer le type d'un produit revendu qui a des offres fournisseurs", async () => {
      const supplier = (await api(app, admin).get('/api/suppliers').expect(200)).body[0];
      await api(app, admin)
        .post('/api/supplier-products')
        .send({ supplierId: supplier.id, productId: coca, purchaseUnitLabel: 'Casier 24', quantityPerPurchaseUnit: 24, unitPrice: 9600 })
        .expect(201);
      await api(app, admin).patch(`/api/products/${coca}`).send({ type: 'MANUFACTURED' }).expect(409);
      const detail = await api(app, admin).get(`/api/products/${coca}`).expect(200);
      expect(detail.body.supplierProducts[0].pricePerBaseUnit).toBe(400);
    });
  });
});
