import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { ADMIN_EMAIL, ADMIN_PASSWORD, api, createAndLogin, createTestApp, login, resetDatabase, Session } from './helpers';

type Id = { id: string };
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe('Module 3 — Achats & stock', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: Session;
  let manager: Session; // Responsable Plateau
  let storekeeper: Session; // Magasinier Plateau
  let purchaser: Session; // Responsable achats Plateau
  let yopKeeper: Session; // Magasinier Yopougon
  let cashier: Session; // Caissier Plateau
  let plateau: string;
  let yopougon: string;
  let farine: string; // matière périssable, sac 25 kg
  let sucre: string; // matière non périssable, sac 50 kg
  let coca: string; // produit revendu
  let croissant: string; // produit fabriqué
  let gma: string; // fournisseur farine
  let soc: string; // fournisseur sucre
  let offerFarine: string;
  let principalPlt: string;
  let roles: Record<string, string>;
  let froidPlt: string;

  const stockOf = async (s: Session, est: string, itemId: string) => {
    const res = await api(app, s, est).get('/api/stock/items').expect(200);
    const row = res.body.find((r: { rawMaterialId: string | null; productId: string | null }) => r.rawMaterialId === itemId || r.productId === itemId);
    return row;
  };
  const qtyAt = async (locationId: string, itemId: string) => {
    const agg = await prisma.stockBalance.aggregate({ where: { locationId, OR: [{ rawMaterialId: itemId }, { productId: itemId }] }, _sum: { quantity: true } });
    return Number(agg._sum.quantity ?? 0);
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    admin = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    roles = Object.fromEntries((await api(app, admin).get('/api/roles').expect(200)).body.map((r: { code: string; id: string }) => [r.code, r.id]));
    plateau = (await api(app, admin).post('/api/establishments').send({ code: 'PLT', name: 'Pâtisserie Plateau', type: 'PATISSERIE' }).expect(201)).body.id;
    yopougon = (await api(app, admin).post('/api/establishments').send({ code: 'YOP', name: 'Restaurant Yopougon', type: 'RESTAURANT' }).expect(201)).body.id;
    manager = await createAndLogin(app, admin, { email: 'resp@test.ci', fullName: 'Resp Plateau', roles: [{ roleId: roles.MANAGER, establishmentId: plateau }] });
    storekeeper = await createAndLogin(app, admin, { email: 'mag@test.ci', fullName: 'Magasinier PLT', roles: [{ roleId: roles.STOREKEEPER, establishmentId: plateau }] });
    purchaser = await createAndLogin(app, admin, { email: 'achat@test.ci', fullName: 'Acheteur PLT', roles: [{ roleId: roles.PURCHASER, establishmentId: plateau }] });
    yopKeeper = await createAndLogin(app, admin, { email: 'magyop@test.ci', fullName: 'Magasinier YOP', roles: [{ roleId: roles.STOREKEEPER, establishmentId: yopougon }] });
    cashier = await createAndLogin(app, admin, { email: 'caisse@test.ci', fullName: 'Caissier', roles: [{ roleId: roles.CASHIER, establishmentId: plateau }] });

    farine = (await api(app, admin).post('/api/raw-materials').send({ code: 'FAR-T55', name: 'Farine T55', baseUnitCode: 'KG', isPerishable: true, packagings: [{ name: 'Sac 25 kg', quantity: 25, isDefault: true }] }).expect(201)).body.id;
    sucre = (await api(app, admin).post('/api/raw-materials').send({ code: 'SUC', name: 'Sucre', baseUnitCode: 'KG', packagings: [{ name: 'Sac 50 kg', quantity: 50, isDefault: true }] }).expect(201)).body.id;
    coca = (await api(app, admin).post('/api/products').send({ code: 'COCA', name: 'Coca-Cola 33 cl', type: 'RESOLD', basePrice: 500 }).expect(201)).body.id;
    croissant = (await api(app, admin).post('/api/products').send({ code: 'CRO', name: 'Croissant', type: 'MANUFACTURED' }).expect(201)).body.id;
    gma = (await api(app, admin).post('/api/suppliers').send({ code: 'GMA', name: 'Grands Moulins', paymentTermsDays: 30 }).expect(201)).body.id;
    soc = (await api(app, admin).post('/api/suppliers').send({ code: 'SOC', name: 'Sucrerie' }).expect(201)).body.id;
    offerFarine = (await api(app, admin).post('/api/supplier-products').send({ supplierId: gma, rawMaterialId: farine, brand: 'Marque A', purchaseUnitLabel: 'Sac 25 kg', quantityPerPurchaseUnit: 25, unitPrice: 18500, isPreferred: true }).expect(201)).body.id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Emplacements', () => {
    it('crée automatiquement le « Magasin principal » et permet d’autres emplacements', async () => {
      const res = await api(app, storekeeper, plateau).get(`/api/stock-locations?establishmentId=${plateau}`).expect(200);
      expect(res.body.map((l: { code: string; isDefault: boolean }) => [l.code, l.isDefault])).toEqual([['PRINCIPAL', true]]);
      principalPlt = res.body[0].id;
      froidPlt = (await api(app, storekeeper, plateau).post('/api/stock-locations').send({ establishmentId: plateau, code: 'froid', name: 'Chambre froide' }).expect(201)).body.id;
      await api(app, storekeeper, plateau).post('/api/stock-locations').send({ establishmentId: plateau, code: 'FROID', name: 'Doublon' }).expect(409);
      await api(app, storekeeper, plateau).patch(`/api/stock-locations/${principalPlt}`).send({ isActive: false }).expect(409);
      await api(app, cashier, plateau).post('/api/stock-locations').send({ establishmentId: plateau, code: 'X1', name: 'Interdit' }).expect(403);
    });
  });

  describe('Demandes et commandes fournisseurs', () => {
    let requestId: string;
    let orderId: string;

    it('le magasinier crée une demande d’achat, pas le caissier', async () => {
      const res = await api(app, storekeeper, plateau).post('/api/purchase-requests').send({ establishmentId: plateau, items: [{ rawMaterialId: farine, quantity: 2500 }] }).expect(201);
      requestId = res.body.id;
      expect(res.body.number).toMatch(/^PLT-DA-\d{4}-000001$/);
      await api(app, cashier, plateau).post('/api/purchase-requests').send({ establishmentId: plateau, items: [{ rawMaterialId: farine, quantity: 1 }] }).expect(403);
      await api(app, storekeeper, plateau).post('/api/purchase-requests').send({ establishmentId: plateau, items: [{ productId: croissant, quantity: 1 }] }).expect(400);
    });

    it('calcule les montants de la commande et rattache la demande', async () => {
      const res = await api(app, purchaser, plateau)
        .post('/api/purchase-orders')
        .send({ establishmentId: plateau, supplierId: gma, discountAmount: 50000, requestIds: [requestId], items: [{ supplierProductId: offerFarine, orderedQuantity: 100 }] })
        .expect(201);
      orderId = res.body.id;
      expect([res.body.subtotal, res.body.discountAmount, res.body.total, res.body.status]).toEqual(['1850000', '50000', '1800000', 'DRAFT']);
      const req = await prisma.purchaseRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect([req.status, req.purchaseOrderId]).toEqual(['ORDERED', orderId]);
      await api(app, storekeeper, plateau).post('/api/purchase-orders').send({ establishmentId: plateau, supplierId: gma, items: [{ supplierProductId: offerFarine, orderedQuantity: 1 }] }).expect(403);
    });

    it('ne modifie une commande qu’en brouillon', async () => {
      await api(app, purchaser, plateau).patch(`/api/purchase-orders/${orderId}`).send({ notes: 'Livrer avant 8h' }).expect(200);
      await api(app, purchaser, plateau).post(`/api/purchase-orders/${orderId}/validate`).expect(201);
      await api(app, purchaser, plateau).patch(`/api/purchase-orders/${orderId}`).send({ notes: 'trop tard' }).expect(409);
      await api(app, purchaser, plateau).post(`/api/purchase-orders/${orderId}/validate`).expect(409);
    });

    describe('Réceptions', () => {
      let orderItemId: string;
      beforeAll(async () => {
        orderItemId = (await api(app, purchaser, plateau).get(`/api/purchase-orders/${orderId}`).expect(200)).body.items[0].id;
      });

      it('contrôle les données de réception', async () => {
        const base = { establishmentId: plateau, supplierId: gma, purchaseOrderId: orderId };
        // Matière périssable sans date d'expiration.
        await api(app, storekeeper, plateau).post('/api/goods-receipts').send({ ...base, items: [{ orderItemId, receivedQuantity: 10, unitPrice: 18500 }] }).expect(400);
        // Produit déjà périmé.
        await api(app, storekeeper, plateau).post('/api/goods-receipts').send({ ...base, items: [{ orderItemId, receivedQuantity: 10, unitPrice: 18500, expiryDate: inDays(-1) }] }).expect(400);
        // Prix différent de la commande sans motif.
        await api(app, storekeeper, plateau).post('/api/goods-receipts').send({ ...base, items: [{ orderItemId, receivedQuantity: 10, unitPrice: 19000, expiryDate: inDays(90) }] }).expect(400);
        // Refus sans motif.
        await api(app, storekeeper, plateau).post('/api/goods-receipts').send({ ...base, items: [{ orderItemId, receivedQuantity: 10, rejectedQuantity: 1, unitPrice: 18500, expiryDate: inDays(90) }] }).expect(400);
        expect(await prisma.goodsReceipt.count()).toBe(0);
      });

      it('réception partielle : refus au contrôle, lot au coût réel, entrée en stock', async () => {
        const res = await api(app, storekeeper, plateau)
          .post('/api/goods-receipts')
          .send({
            establishmentId: plateau,
            supplierId: gma,
            purchaseOrderId: orderId,
            supplierDocumentRef: 'BL-778',
            items: [{ orderItemId, receivedQuantity: 40, rejectedQuantity: 2, rejectionReason: 'Sacs déchirés', unitPrice: 18500, brand: 'Marque A', supplierLotRef: 'GM-0425', expiryDate: inDays(90) }],
          })
          .expect(201);
        expect(res.body.totalValue).toBe(String(38 * 18500));
        expect(res.body.items[0].lot.unitCost).toBe('740');
        expect(await qtyAt(principalPlt, farine)).toBe(950);
        const o = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: orderId } });
        expect(o.status).toBe('PARTIALLY_RECEIVED');
        const mv = await prisma.stockMovement.findFirstOrThrow({ where: { originType: 'GoodsReceipt', originId: res.body.id } });
        expect([mv.type, Number(mv.quantity), Number(mv.balanceAfter)]).toEqual(['RECEIPT', 950, 950]);
      });

      it('accepte un surplus et un autre prix avec motif, puis clôt la commande', async () => {
        const body = (reason?: string) => ({
          establishmentId: plateau,
          supplierId: gma,
          purchaseOrderId: orderId,
          items: [{ orderItemId, receivedQuantity: 70, unitPrice: 19000, varianceReason: reason, brand: 'Marque A', expiryDate: inDays(30) }],
        });
        await api(app, storekeeper, plateau).post('/api/goods-receipts').send(body()).expect(400);
        await api(app, storekeeper, plateau).post('/api/goods-receipts').send(body('Hausse du prix et livraison complète')).expect(201);
        const o = await api(app, purchaser, plateau).get(`/api/purchase-orders/${orderId}`).expect(200);
        expect(o.body.status).toBe('RECEIVED');
        expect(Number(o.body.items[0].receivedQuantity)).toBe(108);
        await api(app, storekeeper, plateau).post('/api/goods-receipts').send(body('encore')).expect(409);
      });

      it('accepte une réception directe sans commande', async () => {
        await api(app, storekeeper, plateau)
          .post('/api/goods-receipts')
          .send({ establishmentId: plateau, supplierId: soc, items: [{ rawMaterialId: sucre, purchaseUnitLabel: 'Sac 50 kg', quantityPerPurchaseUnit: 50, receivedQuantity: 10, unitPrice: 30000 }] })
          .expect(201);
        await api(app, storekeeper, plateau)
          .post('/api/goods-receipts')
          .send({ establishmentId: plateau, supplierId: soc, items: [{ rawMaterialId: sucre, purchaseUnitLabel: 'Sac 50 kg', quantityPerPurchaseUnit: 50, receivedQuantity: 2, unitPrice: 31000, expiryDate: inDays(10) }] })
          .expect(201);
        await api(app, storekeeper, plateau)
          .post('/api/goods-receipts')
          .send({ establishmentId: plateau, supplierId: soc, items: [{ productId: coca, purchaseUnitLabel: 'Casier 24', quantityPerPurchaseUnit: 24, receivedQuantity: 5, unitPrice: 9600 }] })
          .expect(201);
        // Un produit fabriqué ne s'achète pas.
        await api(app, storekeeper, plateau)
          .post('/api/goods-receipts')
          .send({ establishmentId: plateau, supplierId: soc, items: [{ productId: croissant, purchaseUnitLabel: 'X', quantityPerPurchaseUnit: 1, receivedQuantity: 1, unitPrice: 1 }] })
          .expect(400);
        expect(await prisma.goodsReceipt.count({ where: { purchaseOrderId: null } })).toBe(3);
        expect(await prisma.auditLog.count({ where: { action: 'GOODS_RECEIVED_DIRECT' } })).toBe(3);
      });
    });
  });

  describe('État du stock et règles de sortie', () => {
    it('affiche le stock en kg et en sacs, avec valeur et coût moyen', async () => {
      const row = await stockOf(storekeeper, plateau, farine);
      expect(Number(row.quantity)).toBe(2700);
      expect(Number(row.packaging.count)).toBe(108);
      expect(Number(row.value)).toBe(950 * 740 + 1750 * 760);
      expect(Number(row.averageCost)).toBeCloseTo((950 * 740 + 1750 * 760) / 2700, 2);
      expect(Number(row.lastPurchaseCost)).toBe(760);
    });

    it('sort en FEFO : le lot qui périme le plus tôt part en premier', async () => {
      const res = await api(app, storekeeper, plateau).post('/api/stock-losses').send({ establishmentId: plateau, rawMaterialId: farine, quantity: 10, cause: 'BROKEN', comment: 'Sac percé' }).expect(201);
      const mv = await prisma.stockMovement.findFirstOrThrow({ where: { originId: res.body.id } });
      const lot = await prisma.stockLot.findUniqueOrThrow({ where: { id: mv.lotId } });
      expect(Number(lot.unitCost)).toBe(760); // lot à J+30, avant celui à J+90
      expect(res.body.estimatedValue).toBe('7600');
      await api(app, cashier, plateau).post('/api/stock-losses').send({ establishmentId: plateau, rawMaterialId: farine, quantity: 1, cause: 'BROKEN' }).expect(403);
    });

    it('bloque un lot périmé, sauf pour une perte « péremption »', async () => {
      const lot = await prisma.stockLot.findFirstOrThrow({ where: { rawMaterialId: sucre, expiryDate: { not: null } } });
      await prisma.stockLot.update({ where: { id: lot.id }, data: { expiryDate: new Date(inDays(-1)) } });
      const row = await stockOf(storekeeper, plateau, sucre);
      expect([Number(row.quantity), Number(row.expired), Number(row.available)]).toEqual([600, 100, 500]);
      await api(app, storekeeper, plateau).post('/api/stock-losses').send({ establishmentId: plateau, rawMaterialId: sucre, lotId: lot.id, quantity: 10, cause: 'BROKEN' }).expect(409);
      await api(app, storekeeper, plateau).post('/api/location-moves').send({ establishmentId: plateau, rawMaterialId: sucre, fromLocationId: principalPlt, toLocationId: froidPlt, quantity: 550 }).expect(409);
      await api(app, storekeeper, plateau).post('/api/stock-losses').send({ establishmentId: plateau, rawMaterialId: sucre, quantity: 100, cause: 'EXPIRED' }).expect(201);
      const balance = await prisma.stockBalance.findFirstOrThrow({ where: { lotId: lot.id } });
      expect(Number(balance.quantity)).toBe(0);
    });

    it('ne descend jamais sous zéro, même avec 10 sorties simultanées', async () => {
      const before = await qtyAt(principalPlt, farine); // 2690
      const results = await Promise.all(
        Array.from({ length: 10 }, () => api(app, storekeeper, plateau).post('/api/stock-losses').send({ establishmentId: plateau, rawMaterialId: farine, quantity: 300, cause: 'OTHER', comment: 'test concurrence' })),
      );
      const ok = results.filter((r) => r.status === 201).length;
      expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
      const after = await qtyAt(principalPlt, farine);
      expect(after).toBeGreaterThanOrEqual(0);
      expect(after).toBe(before - ok * 300);
      expect(ok).toBe(Math.floor(before / 300));
    });

    it('signale le stock sous le seuil (par article et établissement)', async () => {
      await api(app, storekeeper, plateau).put('/api/stock/thresholds').send({ establishmentId: plateau, rawMaterialId: sucre, minQuantity: 500, alertQuantity: 800 }).expect(200);
      await api(app, storekeeper, plateau).put('/api/stock/thresholds').send({ establishmentId: plateau, rawMaterialId: sucre, minQuantity: 900, alertQuantity: 800 }).expect(400);
      const row = await stockOf(storekeeper, plateau, sucre);
      expect(row.status).toBe('CRITICAL');
      const below = await api(app, storekeeper, plateau).get('/api/stock/items?belowAlert=true').expect(200);
      expect(below.body.map((r: { item: { code: string } }) => r.item.code)).toContain('SUC');
    });
  });

  describe('Corrections, déplacements et inventaire', () => {
    it('une correction ne touche le stock qu’après validation par un responsable', async () => {
      const out = await api(app, storekeeper, plateau).post('/api/stock-adjustments').send({ establishmentId: plateau, rawMaterialId: sucre, direction: 'OUT', quantity: 5, reason: 'Erreur de saisie' }).expect(201);
      expect(await qtyAt(principalPlt, sucre)).toBe(500);
      await api(app, storekeeper, plateau).post(`/api/stock-adjustments/${out.body.id}/approve`).send({}).expect(403);
      await api(app, manager, plateau).post(`/api/stock-adjustments/${out.body.id}/approve`).send({ note: 'OK' }).expect(201);
      expect(await qtyAt(principalPlt, sucre)).toBe(495);
      await api(app, manager, plateau).post(`/api/stock-adjustments/${out.body.id}/approve`).send({}).expect(409);

      const inn = await api(app, storekeeper, plateau).post('/api/stock-adjustments').send({ establishmentId: plateau, rawMaterialId: sucre, direction: 'IN', quantity: 20, reason: 'Sac oublié' }).expect(201);
      expect(Number(inn.body.unitCost)).toBe(620); // coût proposé : dernier lot (31 000 / 50 kg)
      await api(app, manager, plateau).post(`/api/stock-adjustments/${inn.body.id}/approve`).send({}).expect(201);
      expect(await qtyAt(principalPlt, sucre)).toBe(515);
      const rejected = await api(app, storekeeper, plateau).post('/api/stock-adjustments').send({ establishmentId: plateau, rawMaterialId: sucre, direction: 'OUT', quantity: 1, reason: 'Doute' }).expect(201);
      await api(app, manager, plateau).post(`/api/stock-adjustments/${rejected.body.id}/reject`).send({ note: 'Non justifié' }).expect(201);
      expect(await qtyAt(principalPlt, sucre)).toBe(515);
    });

    it('déplace du stock entre emplacements en gardant les lots', async () => {
      const lotsBefore = await prisma.stockBalance.findMany({ where: { locationId: principalPlt, rawMaterialId: farine, quantity: { gt: 0 } } });
      await api(app, storekeeper, plateau).post('/api/location-moves').send({ establishmentId: plateau, rawMaterialId: farine, fromLocationId: principalPlt, toLocationId: froidPlt, quantity: 100 }).expect(201);
      const inFroid = await prisma.stockBalance.findMany({ where: { locationId: froidPlt, rawMaterialId: farine, quantity: { gt: 0 } } });
      expect(inFroid.every((b) => lotsBefore.some((l) => l.lotId === b.lotId))).toBe(true);
      expect(await qtyAt(froidPlt, farine)).toBe(100);
    });

    it("gèle l'emplacement pendant l'inventaire, valide les écarts et les valorise", async () => {
      const farineBefore = await qtyAt(principalPlt, farine);
      const inv = await api(app, storekeeper, plateau).post('/api/inventories').send({ establishmentId: plateau, locationId: principalPlt }).expect(201);
      await api(app, storekeeper, plateau).post('/api/inventories').send({ establishmentId: plateau, locationId: principalPlt }).expect(409);
      // Emplacement gelé : aucune entrée ni sortie ; l'autre emplacement fonctionne.
      await api(app, storekeeper, plateau).post('/api/stock-losses').send({ establishmentId: plateau, locationId: principalPlt, rawMaterialId: sucre, quantity: 1, cause: 'BROKEN' }).expect(409);
      await api(app, storekeeper, plateau)
        .post('/api/goods-receipts')
        .send({ establishmentId: plateau, locationId: principalPlt, supplierId: soc, items: [{ rawMaterialId: sucre, purchaseUnitLabel: 'Sac 50 kg', quantityPerPurchaseUnit: 50, receivedQuantity: 1, unitPrice: 30000 }] })
        .expect(409);
      await api(app, storekeeper, plateau).post('/api/stock-losses').send({ establishmentId: plateau, locationId: froidPlt, rawMaterialId: farine, quantity: 10, cause: 'BROKEN' }).expect(201);

      const lines = inv.body.items as (Id & { rawMaterialId: string | null; productId: string | null; theoreticalQuantity: string; unitCost: string | null })[];
      const line = (itemId: string) => lines.find((l) => l.rawMaterialId === itemId || l.productId === itemId)!;
      expect(Number(line(farine).theoreticalQuantity)).toBe(farineBefore);
      expect(Number(line(sucre).theoreticalQuantity)).toBe(515);

      // Validation refusée tant que tout n'est pas compté.
      await api(app, storekeeper, plateau).put(`/api/inventories/${inv.body.id}/items/${line(farine).id}`).send({ countedQuantity: farineBefore + 25, justification: 'Sac retrouvé' }).expect(200);
      await api(app, manager, plateau).post(`/api/inventories/${inv.body.id}/validate`).expect(400);
      await api(app, storekeeper, plateau).put(`/api/inventories/${inv.body.id}/items/${line(sucre).id}`).send({ countedQuantity: 510 }).expect(200);
      await api(app, storekeeper, plateau).put(`/api/inventories/${inv.body.id}/items/${line(coca).id}`).send({ countedQuantity: 120 }).expect(200);
      // Écart non justifié sur le sucre.
      await api(app, manager, plateau).post(`/api/inventories/${inv.body.id}/validate`).expect(400);
      await api(app, storekeeper, plateau).put(`/api/inventories/${inv.body.id}/items/${line(sucre).id}`).send({ countedQuantity: 510, justification: 'Écart de pesée' }).expect(200);
      await api(app, storekeeper, plateau).post(`/api/inventories/${inv.body.id}/validate`).expect(403);
      const done = await api(app, manager, plateau).post(`/api/inventories/${inv.body.id}/validate`).expect(201);
      expect(done.body.status).toBe('VALIDATED');

      expect(await qtyAt(principalPlt, farine)).toBe(farineBefore + 25);
      expect(await qtyAt(principalPlt, sucre)).toBe(510);
      const gain = await prisma.stockMovement.findFirstOrThrow({ where: { originId: inv.body.id, type: 'INVENTORY_GAIN' } });
      expect(Number(gain.unitCost)).toBe(760); // coût proposé : dernier lot de farine
      expect(await prisma.stockMovement.count({ where: { originId: inv.body.id, type: 'INVENTORY_LOSS' } })).toBeGreaterThan(0);
      // Dégelé après validation.
      await api(app, storekeeper, plateau).post('/api/stock-losses').send({ establishmentId: plateau, locationId: principalPlt, rawMaterialId: sucre, quantity: 1, cause: 'BROKEN' }).expect(201);
    });
  });

  describe('Transferts entre établissements', () => {
    let transfer: Id & { items: Id[] };

    it('permet de choisir comme source un établissement où l’on n’a pas de droits', async () => {
      const res = await api(app, yopKeeper, yopougon).get('/api/stock-transfers/establishments').expect(200);
      expect(res.body.map((e: { code: string }) => e.code).sort()).toEqual(['PLT', 'YOP']);
      expect(Object.keys(res.body[0]).sort()).toEqual(['code', 'id', 'name']);
      await api(app, cashier, plateau).get('/api/stock-transfers/establishments').expect(403);
    });

    it('suit le circuit complet avec perte en transit', async () => {
      const pltBefore = await qtyAt(principalPlt, farine);
      transfer = (await api(app, yopKeeper, yopougon).post('/api/stock-transfers').send({ sourceEstablishmentId: plateau, destEstablishmentId: yopougon, items: [{ rawMaterialId: farine, quantity: 200 }] }).expect(201)).body;
      // La validation revient à l'établissement source.
      await api(app, yopKeeper, yopougon).post(`/api/stock-transfers/${transfer.id}/validate`).expect(403);
      // Le magasinier de la source prépare et expédie, mais ne valide pas.
      await api(app, storekeeper, plateau).post(`/api/stock-transfers/${transfer.id}/validate`).expect(403);
      await api(app, manager, plateau).post(`/api/stock-transfers/${transfer.id}/validate`).expect(201);
      await api(app, storekeeper, plateau).post(`/api/stock-transfers/${transfer.id}/ship`).expect(409); // pas encore préparé
      await api(app, storekeeper, plateau).post(`/api/stock-transfers/${transfer.id}/prepare`).send({ sourceLocationId: principalPlt, items: [{ itemId: transfer.items[0].id, quantity: 200 }] }).expect(201);
      await api(app, storekeeper, plateau).post(`/api/stock-transfers/${transfer.id}/ship`).expect(201);
      expect(await qtyAt(principalPlt, farine)).toBe(pltBefore - 200);
      await api(app, storekeeper, plateau).post(`/api/stock-transfers/${transfer.id}/cancel`).send({ reason: 'trop tard' }).expect(409);

      // Réception : plus que l'expédié refusé, manque sans motif refusé.
      await api(app, yopKeeper, yopougon).post(`/api/stock-transfers/${transfer.id}/receive`).send({ items: [{ itemId: transfer.items[0].id, receivedQuantity: 201 }] }).expect(400);
      await api(app, yopKeeper, yopougon).post(`/api/stock-transfers/${transfer.id}/receive`).send({ items: [{ itemId: transfer.items[0].id, receivedQuantity: 190 }] }).expect(400);
      await api(app, storekeeper, plateau).post(`/api/stock-transfers/${transfer.id}/receive`).send({ items: [{ itemId: transfer.items[0].id, receivedQuantity: 190, gapReason: 'x' }] }).expect(403);
      await api(app, yopKeeper, yopougon).post(`/api/stock-transfers/${transfer.id}/receive`).send({ items: [{ itemId: transfer.items[0].id, receivedQuantity: 190, gapReason: 'Sac tombé du camion' }] }).expect(201);

      const yopRow = await stockOf(yopKeeper, yopougon, farine);
      expect(Number(yopRow.quantity)).toBe(190);
      const shippedLots = await prisma.stockTransferLot.findMany({ where: { transferItemId: transfer.items[0].id } });
      const yopLots = await prisma.stockBalance.findMany({ where: { establishmentId: yopougon, rawMaterialId: farine, quantity: { gt: 0 } } });
      expect(yopLots.every((b) => shippedLots.some((l) => l.lotId === b.lotId))).toBe(true); // mêmes lots : traçabilité

      const loss = await prisma.stockLoss.findFirstOrThrow({ where: { transferId: transfer.id } });
      expect([loss.cause, loss.establishmentId, Number(loss.quantity)]).toEqual(['TRANSIT', plateau, 10]);
      expect(Number(loss.estimatedValue)).toBeGreaterThan(0);
      const closed = await api(app, yopKeeper, yopougon).post(`/api/stock-transfers/${transfer.id}/close`).expect(201);
      expect(closed.body.status).toBe('CLOSED');
    });
  });

  describe('Factures, paiements, avances et retours fournisseurs', () => {
    let r1: string;
    let r2: string;
    let invoice: string;
    let payment: string;

    beforeAll(async () => {
      const receipts = (await api(app, purchaser, plateau).get(`/api/goods-receipts?supplierId=${gma}`).expect(200)).body.sort((a: { number: string }, b: { number: string }) => a.number.localeCompare(b.number));
      [r1, r2] = receipts.map((r: Id) => r.id);
    });

    it('rattache la facture aux réceptions et affiche l’écart', async () => {
      const res = await api(app, purchaser, plateau)
        .post('/api/supplier-invoices')
        .send({ establishmentId: plateau, supplierId: gma, supplierRef: 'GM-F-1001', invoiceDate: inDays(0), amount: 2_040_000, receiptIds: [r1, r2] })
        .expect(201);
      invoice = res.body.id;
      expect([res.body.receivedValue, res.body.variance]).toEqual([String(703_000 + 1_330_000), '7000']);
      expect(res.body.dueDate.slice(0, 10)).toBe(inDays(30)); // délai de paiement du fournisseur
      await api(app, purchaser, plateau).post('/api/supplier-invoices').send({ establishmentId: plateau, supplierId: gma, supplierRef: 'GM-F-1001', invoiceDate: inDays(0), amount: 1, receiptIds: [] }).expect(409);
      await api(app, purchaser, plateau).post('/api/supplier-invoices').send({ establishmentId: plateau, supplierId: gma, supplierRef: 'GM-F-1002', invoiceDate: inDays(0), amount: 1, receiptIds: [r1] }).expect(409);
      const sucreReceipt = (await api(app, purchaser, plateau).get(`/api/goods-receipts?supplierId=${soc}`).expect(200)).body[0].id;
      await api(app, purchaser, plateau).post('/api/supplier-invoices').send({ establishmentId: plateau, supplierId: gma, supplierRef: 'GM-F-1003', invoiceDate: inDays(0), amount: 1, receiptIds: [sucreReceipt] }).expect(400);
      await api(app, storekeeper, plateau).post('/api/supplier-invoices').send({ establishmentId: plateau, supplierId: gma, supplierRef: 'X', invoiceDate: inDays(0), amount: 1, receiptIds: [] }).expect(403);
    });

    it('enregistre des paiements partiels et des avances, sans dépasser le reste à payer', async () => {
      const res = await api(app, purchaser, plateau)
        .post('/api/supplier-payments')
        .send({ establishmentId: plateau, supplierId: gma, amount: 1_500_000, method: 'ORANGE_MONEY', reference: 'OM-123', allocations: [{ invoiceId: invoice, amount: 1_000_000 }] })
        .expect(201);
      payment = res.body.id;
      let inv = await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: invoice } });
      expect([inv.status, inv.paidAmount]).toEqual(['PARTIALLY_PAID', 1_000_000n]);
      await api(app, purchaser, plateau)
        .post('/api/supplier-payments')
        .send({ establishmentId: plateau, supplierId: gma, amount: 2_000_000, method: 'CASH', allocations: [{ invoiceId: invoice, amount: 1_100_000 }] })
        .expect(400);
      await api(app, purchaser, plateau)
        .post('/api/supplier-payments')
        .send({ establishmentId: plateau, supplierId: gma, amount: 100, method: 'CASH', allocations: [{ invoiceId: invoice, amount: 200 }] })
        .expect(400);
      // Avance affectée plus tard, sans dépasser l'avance disponible.
      await api(app, purchaser, plateau).post(`/api/supplier-payments/${payment}/allocations`).send({ invoiceId: invoice, amount: 600_000 }).expect(400);
      await api(app, purchaser, plateau).post(`/api/supplier-payments/${payment}/allocations`).send({ invoiceId: invoice, amount: 500_000 }).expect(201);
      inv = await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: invoice } });
      expect(inv.paidAmount).toBe(1_500_000n);
      const account = await api(app, purchaser, plateau).get(`/api/suppliers/${gma}/account`).expect(200);
      expect([account.body.invoiced, account.body.paid, account.body.balance, account.body.advances]).toEqual(['2040000', '1500000', '540000', '0']);
    });

    it('retourne un lot au fournisseur et crée un avoir', async () => {
      // Le Magasin principal a été presque vidé par le transfert : retour depuis la chambre froide.
      const lot = await prisma.stockBalance.findFirstOrThrow({ where: { locationId: froidPlt, rawMaterialId: farine, quantity: { gte: 25 }, lot: { supplierId: gma } }, include: { lot: true } });
      const res = await api(app, storekeeper, plateau)
        .post('/api/supplier-returns')
        .send({ establishmentId: plateau, locationId: froidPlt, supplierId: gma, invoiceId: invoice, reason: 'Farine humide', items: [{ lotId: lot.lotId, quantity: 25 }] })
        .expect(201);
      const credit = BigInt(Math.round(25 * Number(lot.lot.unitCost)));
      expect(res.body.creditNote.amount).toBe(credit.toString());
      const account = await api(app, purchaser, plateau).get(`/api/suppliers/${gma}/account`).expect(200);
      expect(account.body.balance).toBe((540_000n - credit).toString());
      // Un lot d'un autre fournisseur ne peut pas lui être retourné.
      const sucreLot = await prisma.stockBalance.findFirstOrThrow({ where: { locationId: principalPlt, rawMaterialId: sucre, quantity: { gt: 0 } } });
      await api(app, storekeeper, plateau).post('/api/supplier-returns').send({ establishmentId: plateau, supplierId: gma, reason: 'Erreur', items: [{ lotId: sucreLot.lotId, quantity: 1 }] }).expect(400);
    });

    it('annule un paiement de façon tracée et protège la facture réglée', async () => {
      await api(app, purchaser, plateau).post(`/api/supplier-payments/${payment}/cancel`).send({ reason: 'Transaction Orange Money échouée' }).expect(201);
      const inv = await prisma.supplierInvoice.findUniqueOrThrow({ where: { id: invoice } });
      expect(inv.status).toBe('PARTIALLY_PAID'); // il reste l'avoir imputé
      await api(app, purchaser, plateau).post(`/api/supplier-payments/${payment}/cancel`).send({ reason: 'encore' }).expect(409);
      await api(app, purchaser, plateau).post(`/api/supplier-invoices/${invoice}/cancel`).send({ reason: 'Erreur' }).expect(409);
      expect(await prisma.supplierPayment.count({ where: { id: payment } })).toBe(1); // jamais supprimé
    });
  });

  describe('Double clic, double paiement, coupure réseau', () => {
    const uuid = () => crypto.randomUUID();

    it('5 envois simultanés d’une même réception ne créent qu’une réception et une entrée en stock', async () => {
      const key = uuid();
      const before = await qtyAt(froidPlt, sucre);
      const body = {
        clientRequestId: key,
        establishmentId: plateau,
        locationId: froidPlt,
        supplierId: soc,
        items: [{ rawMaterialId: sucre, purchaseUnitLabel: 'Sac 50 kg', quantityPerPurchaseUnit: 50, receivedQuantity: 1, unitPrice: 30000 }],
      };
      const results = await Promise.all(Array.from({ length: 5 }, () => api(app, storekeeper, plateau).post('/api/goods-receipts').send(body)));
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(await prisma.goodsReceipt.count({ where: { clientRequestId: key } })).toBe(1);
      expect(await qtyAt(froidPlt, sucre)).toBe(before + 50);
      // Renvoi après une coupure réseau : même réponse, rien de nouveau.
      const retry = await api(app, storekeeper, plateau).post('/api/goods-receipts').send(body).expect(201);
      expect(retry.body.id).toBe(results[0].body.id);
      expect(await qtyAt(froidPlt, sucre)).toBe(before + 50);
    });

    it('un double paiement n’est enregistré qu’une fois', async () => {
      const key = uuid();
      const body = { clientRequestId: key, establishmentId: plateau, supplierId: soc, amount: 10_000, method: 'WAVE' };
      const results = await Promise.all(Array.from({ length: 5 }, () => api(app, purchaser, plateau).post('/api/supplier-payments').send(body)));
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(await prisma.supplierPayment.count({ where: { clientRequestId: key } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { action: 'SUPPLIER_PAYMENT_RECORDED', entityId: results[0].body.id } })).toBe(1);
    });

    it('une perte envoyée deux fois ne sort le stock qu’une fois', async () => {
      const key = uuid();
      const before = await qtyAt(froidPlt, sucre);
      const body = { clientRequestId: key, establishmentId: plateau, locationId: froidPlt, rawMaterialId: sucre, quantity: 5, cause: 'BROKEN' };
      await Promise.all([api(app, storekeeper, plateau).post('/api/stock-losses').send(body), api(app, storekeeper, plateau).post('/api/stock-losses').send(body)]);
      expect(await qtyAt(froidPlt, sucre)).toBe(before - 5);
    });

    it('un autre utilisateur ne peut pas rejouer l’identifiant de quelqu’un d’autre', async () => {
      const key = uuid();
      await api(app, storekeeper, plateau).post('/api/purchase-requests').send({ clientRequestId: key, establishmentId: plateau, items: [{ rawMaterialId: sucre, quantity: 50 }] }).expect(201);
      await api(app, manager, plateau).post('/api/purchase-requests').send({ clientRequestId: key, establishmentId: plateau, items: [{ rawMaterialId: sucre, quantity: 50 }] }).expect(409);
    });
  });

  describe('Historiques (prix d’achat, achats fournisseur)', () => {
    it('affiche les derniers prix d’achat réels d’un article', async () => {
      const res = await api(app, storekeeper, plateau).get(`/api/stock/item?rawMaterialId=${farine}&establishmentId=${plateau}`).expect(200);
      expect(res.body.purchaseHistory.map((p: { unitCost: string; unitPrice: string }) => [Number(p.unitCost), p.unitPrice])).toEqual([
        [760, '19000'],
        [740, '18500'],
      ]);
      expect(res.body.purchaseHistory[0].supplier.name).toBe('Grands Moulins');
    });

    it('reporte la date de production saisie à la réception sur le lot', async () => {
      const res = await api(app, storekeeper, plateau)
        .post('/api/goods-receipts')
        .send({ establishmentId: plateau, locationId: froidPlt, supplierId: soc, items: [{ rawMaterialId: sucre, purchaseUnitLabel: 'Sac 50 kg', quantityPerPurchaseUnit: 50, receivedQuantity: 1, unitPrice: 30000, productionDate: inDays(-20) }] })
        .expect(201);
      const lot = await prisma.stockLot.findFirstOrThrow({ where: { receiptItem: { receiptId: res.body.id } } });
      expect(lot.productionDate?.toISOString().slice(0, 10)).toBe(inDays(-20));
    });

    it('affiche l’historique des achats et des retours dans le compte fournisseur', async () => {
      const res = await api(app, purchaser, plateau).get(`/api/suppliers/${gma}/account`).expect(200);
      expect(res.body.purchaseHistory).toHaveLength(2);
      expect(res.body.purchaseHistory.every((r: { invoice: string | null; purchaseOrder: { number: string } }) => r.invoice && r.purchaseOrder.number)).toBe(true);
      expect(res.body.returns).toHaveLength(1);
      expect(res.body.returns[0].creditNote.number).toMatch(/^PLT-AVF-/);
    });
  });

  describe('Droits par rôle', () => {
    let chef: Session & { id: string }; // Chef de cuisine, Plateau
    let prod: Session & { id: string }; // Responsable production, Plateau
    let accountant: Session & { id: string }; // Comptable, Plateau
    let waiter: Session & { id: string }; // Serveur, Plateau
    const request = { establishmentId: '', items: [] as { rawMaterialId: string; quantity: number }[] };

    beforeAll(async () => {
      chef = await createAndLogin(app, admin, { email: 'chef@test.ci', fullName: 'Chef cuisine', roles: [{ roleId: roles.HEAD_CHEF, establishmentId: plateau }] });
      prod = await createAndLogin(app, admin, { email: 'prod@test.ci', fullName: 'Resp production', roles: [{ roleId: roles.PRODUCTION_MANAGER, establishmentId: plateau }] });
      accountant = await createAndLogin(app, admin, { email: 'compta@test.ci', fullName: 'Comptable', roles: [{ roleId: roles.ACCOUNTANT, establishmentId: plateau }] });
      waiter = await createAndLogin(app, admin, { email: 'serveur@test.ci', fullName: 'Serveur', roles: [{ roleId: roles.WAITER, establishmentId: plateau }] });
      Object.assign(request, { establishmentId: plateau, items: [{ rawMaterialId: sucre, quantity: 25 }] });
    });

    it('demandes d’achat : ceux qui voient le stock en créent, chacun ne voit que les siennes sauf les achats', async () => {
      const mine = await api(app, chef, plateau).post('/api/purchase-requests').send(request).expect(201);
      await api(app, prod, plateau).post('/api/purchase-requests').send(request).expect(201);
      await api(app, accountant, plateau).post('/api/purchase-requests').send(request).expect(403);
      await api(app, waiter, plateau).post('/api/purchase-requests').send(request).expect(403);

      const chefList = await api(app, chef, plateau).get('/api/purchase-requests').expect(200);
      expect(chefList.body.map((r: Id) => r.id)).toEqual([mine.body.id]);
      const buyerList = await api(app, purchaser, plateau).get('/api/purchase-requests').expect(200);
      expect(buyerList.body.length).toBeGreaterThan(2);
      await api(app, accountant, plateau).get('/api/purchase-requests').expect(200); // consultation via « Voir les achats »
      await api(app, waiter, plateau).get('/api/purchase-requests').expect(403);

      // Le chef annule sa demande mais ne peut pas refuser ; il ne touche pas aux demandes des autres.
      const other = buyerList.body.find((r: { requestedById: string; status: string }) => r.requestedById !== chef.id && r.status === 'OPEN');
      await api(app, chef, plateau).post(`/api/purchase-requests/${other.id}/cancel`).send({ reason: 'pas à moi' }).expect(403);
      await api(app, chef, plateau).post(`/api/purchase-requests/${mine.body.id}/reject`).send({ reason: 'interdit' }).expect(403);
      await api(app, chef, plateau).post(`/api/purchase-requests/${mine.body.id}/cancel`).send({ reason: 'Erreur de quantité' }).expect(201);
    });

    it('pertes : magasin et production (chef compris) ; corrections et déplacements : magasin seulement', async () => {
      const loss = { establishmentId: plateau, locationId: froidPlt, rawMaterialId: sucre, quantity: 1, cause: 'BURNT', comment: 'Caramel brûlé' };
      await api(app, chef, plateau).post('/api/stock-losses').send(loss).expect(201);
      await api(app, prod, plateau).post('/api/stock-losses').send(loss).expect(201);
      await api(app, purchaser, plateau).post('/api/stock-losses').send(loss).expect(403);
      await api(app, accountant, plateau).post('/api/stock-losses').send(loss).expect(403);
      await api(app, waiter, plateau).post('/api/stock-losses').send(loss).expect(403);
      await api(app, chef, plateau).post('/api/stock-adjustments').send({ establishmentId: plateau, rawMaterialId: sucre, direction: 'OUT', quantity: 1, reason: 'test droits' }).expect(403);
      await api(app, chef, plateau).post('/api/location-moves').send({ establishmentId: plateau, rawMaterialId: sucre, fromLocationId: froidPlt, toLocationId: principalPlt, quantity: 1 }).expect(403);
      await api(app, prod, plateau).post('/api/stock-adjustments').send({ establishmentId: plateau, rawMaterialId: sucre, direction: 'OUT', quantity: 1, reason: 'test droits' }).expect(201);
    });

    it('achats, réceptions, inventaires et paiements restent aux rôles prévus', async () => {
      // Chef et responsable production : pas d'accès aux commandes ni aux réceptions.
      for (const s of [chef, prod]) {
        await api(app, s, plateau).get('/api/purchase-orders').expect(403);
        await api(app, s, plateau).post('/api/goods-receipts').send({ establishmentId: plateau, supplierId: soc, items: [] }).expect(403);
        await api(app, s, plateau).post('/api/inventories').send({ establishmentId: plateau }).expect(403);
      }
      // Responsable achats : pas d'inventaire ni de transfert.
      await api(app, purchaser, plateau).post('/api/inventories').send({ establishmentId: plateau }).expect(403);
      await api(app, purchaser, plateau).post('/api/stock-transfers').send({ sourceEstablishmentId: yopougon, destEstablishmentId: plateau, items: [{ rawMaterialId: sucre, quantity: 1 }] }).expect(403);
      // Paiements fournisseurs : séparation des tâches.
      const pay = { establishmentId: plateau, supplierId: soc, amount: 1000, method: 'CASH' };
      await api(app, manager, plateau).post('/api/supplier-payments').send(pay).expect(403);
      await api(app, storekeeper, plateau).post('/api/supplier-payments').send(pay).expect(403);
      await api(app, accountant, plateau).post('/api/supplier-payments').send(pay).expect(201);
      // Le comptable consulte les achats mais ne voit pas le stock.
      await api(app, accountant, plateau).get('/api/goods-receipts').expect(200);
      await api(app, accountant, plateau).get('/api/stock/items').expect(403);
      // Le serveur n'a aucun accès au stock ni aux achats.
      for (const url of ['/api/stock/items', '/api/stock-losses', '/api/purchase-orders', '/api/supplier-invoices', '/api/inventories', '/api/stock-transfers']) {
        await api(app, waiter, plateau).get(url).expect(403);
      }
    });
  });

  describe('Intégrité en base', () => {
    it('protège le journal des mouvements et les soldes', async () => {
      await expect(prisma.$executeRaw`UPDATE stock_movements SET quantity = 1`).rejects.toThrow(/ajout seul/);
      await expect(prisma.$executeRaw`DELETE FROM stock_movements`).rejects.toThrow(/ajout seul/);
      await expect(prisma.$executeRaw`DELETE FROM stock_balances`).rejects.toThrow(/Suppression interdite/);
      await expect(prisma.$executeRaw`UPDATE stock_balances SET quantity = -1`).rejects.toThrow();
      await expect(prisma.$executeRaw`DELETE FROM supplier_payments`).rejects.toThrow(/Suppression interdite/);
    });

    it('chaque solde est égal à la somme de ses mouvements', async () => {
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*) AS n FROM stock_balances b
        WHERE b.quantity <> (SELECT COALESCE(SUM(m.quantity), 0) FROM stock_movements m WHERE m.location_id = b.location_id AND m.lot_id = b.lot_id)`;
      expect(Number(rows[0].n)).toBe(0);
    });
  });
});
