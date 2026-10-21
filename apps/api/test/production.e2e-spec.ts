import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { ADMIN_EMAIL, ADMIN_PASSWORD, api, createAndLogin, createTestApp, login, resetDatabase, Session } from './helpers';

type Id = { id: string };
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const num = (v: unknown) => Number(v);

describe('Module 4 — Recettes & production', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: Session;
  let manager: Session & { id: string }; // Responsable Plateau (valide, contrôle)
  let chef: Session & { id: string }; // Chef de cuisine Plateau
  let prod: Session & { id: string }; // Responsable production Plateau
  let storekeeper: Session & { id: string }; // Magasinier Plateau
  let cashier: Session & { id: string }; // Caissier Plateau
  let chefYop: Session & { id: string }; // Chef de cuisine Yopougon
  let plateau: string;
  let yopougon: string;
  let principal: string;
  const ids: Record<string, string> = {};

  const qtyOf = async (itemId: string, establishmentId = plateau) => {
    const agg = await prisma.stockBalance.aggregate({ where: { establishmentId, OR: [{ rawMaterialId: itemId }, { productId: itemId }] }, _sum: { quantity: true, reservedQuantity: true } });
    return { quantity: num(agg._sum.quantity ?? 0), reserved: num(agg._sum.reservedQuantity ?? 0) };
  };
  const receive = (rawMaterialId: string, label: string, qpu: number, qty: number, price: number, expiry?: string) =>
    api(app, storekeeper, plateau)
      .post('/api/goods-receipts')
      .send({ establishmentId: plateau, supplierId: ids.gma, items: [{ rawMaterialId, purchaseUnitLabel: label, quantityPerPurchaseUnit: qpu, receivedQuantity: qty, unitPrice: price, expiryDate: expiry }] })
      .expect(201);
  const order = (s: Session, productId: string, plannedQuantity: number, extra: object = {}) =>
    api(app, s, plateau).post('/api/production-orders').send({ establishmentId: plateau, productId, plannedQuantity, ...extra });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    admin = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const roles = Object.fromEntries((await api(app, admin).get('/api/roles').expect(200)).body.map((r: { code: string; id: string }) => [r.code, r.id]));
    plateau = (await api(app, admin).post('/api/establishments').send({ code: 'PLT', name: 'Pâtisserie Plateau', type: 'PATISSERIE' }).expect(201)).body.id;
    yopougon = (await api(app, admin).post('/api/establishments').send({ code: 'YOP', name: 'Restaurant Yopougon', type: 'PATISSERIE_RESTAURANT' }).expect(201)).body.id;
    const user = (email: string, role: string, est: string) => createAndLogin(app, admin, { email, fullName: email.split('@')[0], roles: [{ roleId: roles[role], establishmentId: est }] });
    manager = await user('resp@test.ci', 'MANAGER', plateau);
    chef = await user('chef@test.ci', 'HEAD_CHEF', plateau);
    prod = await user('prod@test.ci', 'PRODUCTION_MANAGER', plateau);
    storekeeper = await user('mag@test.ci', 'STOREKEEPER', plateau);
    cashier = await user('caisse@test.ci', 'CASHIER', plateau);
    chefYop = await user('chefyop@test.ci', 'HEAD_CHEF', yopougon);

    const raw = async (code: string, name: string, unit: string, perishable = false) =>
      (await api(app, admin).post('/api/raw-materials').send({ code, name, baseUnitCode: unit, isPerishable: perishable }).expect(201)).body.id;
    ids.farine = await raw('FAR', 'Farine T55', 'KG', true);
    ids.beurre = await raw('BEU', 'Beurre', 'KG', true);
    ids.sucre = await raw('SUC', 'Sucre', 'KG');
    ids.oeufs = await raw('OEU', 'Œufs', 'U');
    const product = async (code: string, name: string, type: string, extra: object = {}) =>
      (await api(app, admin).post('/api/products').send({ code, name, type, ...extra }).expect(201)).body.id;
    ids.croissant = await product('CRO', 'Croissant', 'MANUFACTURED', { basePrice: 300 });
    ids.creme = await product('CREME', 'Crème pâtissière', 'MANUFACTURED', { saleUnitCode: 'KG' });
    ids.tarte = await product('TARTE', 'Tarte', 'MANUFACTURED', { basePrice: 5000, taxRate: 18 });
    ids.coca = await product('COCA', 'Coca', 'RESOLD', { basePrice: 500 });
    ids.gma = (await api(app, admin).post('/api/suppliers').send({ code: 'GMA', name: 'Grands Moulins' }).expect(201)).body.id;

    await receive(ids.farine, 'Sac 25 kg', 25, 4, 18500, inDays(60)); // 100 kg à 740/kg
    await receive(ids.farine, 'Sac 25 kg', 25, 2, 19000, inDays(30)); // 50 kg à 760/kg (périme plus tôt)
    await receive(ids.beurre, 'kg', 1, 10, 4000, inDays(20));
    await receive(ids.sucre, 'kg', 1, 5, 800);
    await receive(ids.oeufs, 'Œuf', 1, 60, 100);
    principal = (await api(app, storekeeper, plateau).get(`/api/stock-locations?establishmentId=${plateau}`).expect(200)).body[0].id;
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Fiches techniques', () => {
    const croissantItems = (farineGrams = 1000) => [
      { rawMaterialId: ids.farine, quantity: farineGrams, unitCode: 'G', lossPercent: 2 },
      { rawMaterialId: ids.beurre, quantity: 500, unitCode: 'G' },
      { rawMaterialId: ids.sucre, quantity: 100, unitCode: 'G' },
      { rawMaterialId: ids.oeufs, quantity: 4, unitCode: 'U' },
    ];

    it('crée une recette en brouillon (niveau groupe) et refuse les incohérences', async () => {
      const base = { productId: ids.croissant, yieldQuantity: 40, shelfLifeDays: 1 };
      await api(app, chef, plateau).post('/api/recipes').send({ ...base, items: croissantItems() }).expect(403); // décision G
      await api(app, admin).post('/api/recipes').send({ ...base, items: [{ rawMaterialId: ids.oeufs, quantity: 1, unitCode: 'KG' }] }).expect(400); // unité incompatible
      await api(app, admin).post('/api/recipes').send({ ...base, items: [...croissantItems(), { rawMaterialId: ids.sucre, quantity: 1, unitCode: 'G' }] }).expect(400); // doublon
      await api(app, admin).post('/api/recipes').send({ ...base, items: [{ productId: ids.croissant, quantity: 1, unitCode: 'U' }] }).expect(400); // lui-même
      await api(app, admin).post('/api/recipes').send({ ...base, productId: ids.coca, items: croissantItems() }).expect(400); // produit revendu
      await api(app, admin).post('/api/recipes').send({ productId: ids.croissant, items: croissantItems() }).expect(400); // rendement obligatoire
      const res = await api(app, admin).post('/api/recipes').send({ ...base, items: croissantItems() }).expect(201);
      ids.recipe = res.body.id;
      ids.v1 = res.body.versions[0].id;
      expect([res.body.versions[0].version, res.body.versions[0].status]).toEqual([1, 'DRAFT']);
      await api(app, admin).post('/api/recipes').send({ ...base, items: croissantItems() }).expect(409); // une recette par produit
      // Le chef consulte les recettes.
      await api(app, chef, plateau).get(`/api/recipes/${ids.recipe}`).expect(200);
      await api(app, cashier, plateau).get('/api/recipes').expect(403);
    });

    it('fige une version publiée et ne garde qu’une version active', async () => {
      await api(app, admin).post(`/api/recipe-versions/${ids.v1}/activate`).expect(201);
      await api(app, admin).patch(`/api/recipe-versions/${ids.v1}`).send({ yieldQuantity: 50 }).expect(409);
      await expect(prisma.$executeRaw`UPDATE recipe_items SET quantity = 1 WHERE version_id = ${ids.v1}::uuid`).rejects.toThrow(/publiée/);
      await expect(prisma.$executeRaw`UPDATE recipe_versions SET yield_quantity = 1 WHERE id = ${ids.v1}::uuid`).rejects.toThrow(/publiée/);

      const v2 = await api(app, admin).post(`/api/recipes/${ids.recipe}/versions`).expect(201);
      ids.v2 = v2.body.versions.find((v: { version: number }) => v.version === 2).id;
      await api(app, admin).post(`/api/recipes/${ids.recipe}/versions`).expect(409); // un seul brouillon
      await api(app, admin).patch(`/api/recipe-versions/${ids.v2}`).send({ items: croissantItems(1100) }).expect(200);
      const after = await api(app, admin).post(`/api/recipe-versions/${ids.v2}/activate`).expect(201);
      const status = Object.fromEntries(after.body.versions.map((v: { version: number; status: string }) => [v.version, v.status]));
      expect(status).toEqual({ 1: 'ARCHIVED', 2: 'ACTIVE' });
      expect(after.body.activeVersionId).toBe(ids.v2);
      // L'ancienne version reste consultable avec ses ingrédients.
      expect(after.body.versions.find((v: { version: number }) => v.version === 1).items).toHaveLength(4);
      await expect(prisma.$executeRaw`UPDATE recipe_versions SET status = 'ACTIVE' WHERE id = ${ids.v1}::uuid`).rejects.toThrow();
    });

    it('refuse une boucle de sous-recettes et accepte une sous-préparation', async () => {
      // Crème pâtissière (1 kg) puis tarte qui l'utilise : sous-recette valide (décision B).
      const creme = await api(app, admin)
        .post('/api/recipes')
        .send({ productId: ids.creme, yieldQuantity: 1, shelfLifeDays: 2, items: [{ rawMaterialId: ids.sucre, quantity: 200, unitCode: 'G' }, { rawMaterialId: ids.oeufs, quantity: 6, unitCode: 'U' }] })
        .expect(201);
      await api(app, admin).post(`/api/recipe-versions/${creme.body.versions[0].id}/activate`).expect(201);
      const tarte = await api(app, admin)
        .post('/api/recipes')
        .send({ productId: ids.tarte, yieldQuantity: 1, shelfLifeDays: 3, items: [{ productId: ids.creme, quantity: 500, unitCode: 'G' }, { rawMaterialId: ids.farine, quantity: 300, unitCode: 'G' }] })
        .expect(201);
      ids.tarteV1 = tarte.body.versions[0].id;
      await api(app, admin).post(`/api/recipe-versions/${ids.tarteV1}/activate`).expect(201);
      // Boucle : la crème ne peut pas contenir la tarte (qui contient la crème).
      const v2 = await api(app, admin).post(`/api/recipes/${creme.body.id}/versions`).expect(201);
      const draft = v2.body.versions.find((v: { status: string }) => v.status === 'DRAFT').id;
      const res = await api(app, admin)
        .patch(`/api/recipe-versions/${draft}`)
        .send({ items: [{ rawMaterialId: ids.sucre, quantity: 200, unitCode: 'G' }, { productId: ids.tarte, quantity: 1, unitCode: 'U' }] })
        .expect(400);
      expect(res.body.message).toMatch(/Boucle/);
      await api(app, admin).post(`/api/recipe-versions/${draft}/archive`).expect(201); // brouillon abandonné
    });
  });

  describe('Coût de revient et marge', () => {
    it('calcule le coût à partir des lots FEFO et la marge sur le prix HT', async () => {
      const res = await api(app, chef, plateau).get(`/api/recipe-versions/${ids.v2}/cost?establishmentId=${plateau}`).expect(200);
      const line = (name: string) => res.body.lines.find((l: { name: string }) => l.name === name);
      // 1 100 g × 1,02 = 1,122 kg pris d'abord dans le lot à 760 (périme plus tôt).
      expect(num(line('Farine T55').stockQuantity)).toBeCloseTo(1.122, 4);
      expect(num(line('Farine T55').cost)).toBeCloseTo(1.122 * 760, 2);
      expect(line('Farine T55').source).toBe('STOCK');
      const total = 1.122 * 760 + 0.5 * 4000 + 0.1 * 800 + 4 * 100;
      expect(num(res.body.totalCost)).toBeCloseTo(total, 1);
      expect(num(res.body.unitCost)).toBeCloseTo(total / 40, 3);
      expect(num(res.body.margin)).toBeCloseTo(300 - total / 40, 1);
    });

    it('utilise le dernier prix d’achat sans stock et le coût de la sous-recette', async () => {
      const yop = await api(app, chefYop, yopougon).get(`/api/recipe-versions/${ids.v2}/cost?establishmentId=${yopougon}`).expect(200);
      expect(yop.body.lines.find((l: { name: string }) => l.name === 'Farine T55').source).toBe('LAST_PURCHASE');
      const tarte = await api(app, chef, plateau).get(`/api/recipe-versions/${ids.tarteV1}/cost?establishmentId=${plateau}`).expect(200);
      const creme = tarte.body.lines.find((l: { name: string }) => l.name === 'Crème pâtissière');
      expect(creme.source).toBe('SUB_RECIPE');
      expect(num(creme.unitCost)).toBeCloseTo(0.2 * 800 + 6 * 100, 2); // coût d'1 kg de crème
      // Marge sur le prix HT : 5 000 TTC à 18 % → 4 237,29 HT.
      expect(num(tarte.body.priceHt)).toBeCloseTo(5000 / 1.18, 2);
    });

    it('se met à jour quand un nouveau prix d’achat arrive', async () => {
      const before = await api(app, chef, plateau).get(`/api/recipe-versions/${ids.v2}/cost?establishmentId=${plateau}`).expect(200);
      await receive(ids.farine, 'Sac 25 kg', 25, 1, 20000, inDays(10)); // 800/kg, périme en premier
      const after = await api(app, chef, plateau).get(`/api/recipe-versions/${ids.v2}/cost?establishmentId=${plateau}`).expect(200);
      expect(num(after.body.totalCost) - num(before.body.totalCost)).toBeCloseTo(1.122 * (800 - 760), 1);
      const list = await api(app, manager, plateau).get(`/api/costing?establishmentId=${plateau}`).expect(200);
      const row = list.body.find((r: { code: string }) => r.code === 'CRO');
      expect([row.hasActiveRecipe, row.costComplete, num(row.priceTtc)]).toEqual([true, true, 300]);
      expect(num(row.marginRate)).toBeGreaterThan(0);
    });
  });

  describe('Ordres de production', () => {
    it('planifie avec les besoins théoriques convertis en unité de stock', async () => {
      await order(cashier, ids.croissant, 80).expect(403);
      await order(chefYop, ids.croissant, 80).expect(403); // pas de droits au Plateau
      await order(chef, ids.coca, 10).expect(400);
      const res = await order(chef, ids.croissant, 80).expect(201);
      ids.order = res.body.id;
      expect(res.body.number).toMatch(/^PLT-PRD-\d{4}-000001$/);
      expect(res.body.status).toBe('PLANNED');
      const need = (name: string) => num(res.body.items.find((i: { item: { name: string } }) => i.item.name === name).theoreticalQuantity);
      expect(need('Farine T55')).toBeCloseTo(2.244, 4); // 1,1 kg × 1,02 × 2
      expect(need('Beurre')).toBeCloseTo(1, 4);
      expect(need('Œufs')).toBe(8);
      expect(num(res.body.theoreticalCost)).toBeGreaterThan(0);
      // Transitions interdites.
      await api(app, chef, plateau).post(`/api/production-orders/${ids.order}/start`).expect(409);
      await api(app, chef, plateau).post(`/api/production-orders/${ids.order}/complete`).send({ producedQuantity: 80 }).expect(409);
    });

    it('réserve les matières à la validation et refuse si le stock disponible manque', async () => {
      const big = await order(chef, ids.croissant, 100000).expect(201);
      const refused = await api(app, chef, plateau).post(`/api/production-orders/${big.body.id}/validate`).expect(409);
      expect(refused.body.message).toMatch(/insuffisant/);
      await api(app, chef, plateau).post(`/api/production-orders/${big.body.id}/cancel`).send({ reason: 'Erreur de quantité' }).expect(201);

      const before = await qtyOf(ids.farine);
      await api(app, chef, plateau).post(`/api/production-orders/${ids.order}/validate`).expect(201);
      const after = await qtyOf(ids.farine);
      expect(after.quantity).toBe(before.quantity); // rien ne sort encore
      expect(after.reserved).toBeCloseTo(before.reserved + 2.244, 4);
      // Le stock réservé ne peut plus partir en perte.
      const free = after.quantity - after.reserved;
      await api(app, storekeeper, plateau).post('/api/stock-losses').send({ establishmentId: plateau, rawMaterialId: ids.farine, quantity: free + 0.5, cause: 'OTHER', comment: 'test réservation' }).expect(409);
    });

    it('libère la réservation à l’annulation', async () => {
      const o = await order(chef, ids.croissant, 40).expect(201);
      const before = await qtyOf(ids.beurre);
      await api(app, chef, plateau).post(`/api/production-orders/${o.body.id}/validate`).expect(201);
      expect((await qtyOf(ids.beurre)).reserved).toBeCloseTo(before.reserved + 0.5, 4);
      await api(app, chef, plateau).post(`/api/production-orders/${o.body.id}/cancel`).send({ reason: 'Commande annulée' }).expect(201);
      expect((await qtyOf(ids.beurre)).reserved).toBeCloseTo(before.reserved, 4);
      await api(app, chef, plateau).post(`/api/production-orders/${o.body.id}/start`).expect(409);
    });

    it('consomme les lots en FEFO au lancement', async () => {
      const before = await qtyOf(ids.farine);
      const res = await api(app, chef, plateau).post(`/api/production-orders/${ids.order}/start`).expect(201);
      expect(res.body.status).toBe('IN_PROGRESS');
      const after = await qtyOf(ids.farine);
      expect(after.quantity).toBeCloseTo(before.quantity - 2.244, 4);
      expect(after.reserved).toBeCloseTo(before.reserved - 2.244, 4);
      const farineLines = res.body.consumptions.filter((c: { itemId: string }) => res.body.items.find((i: Id & { rawMaterialId: string }) => i.id === c.itemId)?.rawMaterialId === ids.farine);
      expect(farineLines.map((c: { unitCost: string }) => num(c.unitCost))).toEqual([800]); // lot à J+10 en premier
      expect(await prisma.stockMovement.count({ where: { originId: ids.order, type: 'CONSUMPTION' } })).toBe(4);
      await api(app, chef, plateau).post(`/api/production-orders/${ids.order}/cancel`).send({ reason: 'trop tard' }).expect(409);
    });

    it('termine avec écarts de consommation, perte de production et lot de produit fini', async () => {
      const done = `/api/production-orders/${ids.order}/complete`;
      const sucreItem = (await api(app, chef, plateau).get(`/api/production-orders/${ids.order}`).expect(200)).body.items.find((i: { rawMaterialId: string }) => i.rawMaterialId === ids.sucre).id;
      const beurreItem = (await api(app, chef, plateau).get(`/api/production-orders/${ids.order}`).expect(200)).body.items.find((i: { rawMaterialId: string }) => i.rawMaterialId === ids.beurre).id;
      await api(app, chef, plateau).post(done).send({ producedQuantity: 77 }).expect(400); // perte sans cause
      await api(app, chef, plateau)
        .post(done)
        .send({ producedQuantity: 77, lossCause: 'BURNT', lossReason: 'Four trop chaud', adjustments: [{ itemId: sucreItem, returnedQuantity: 5, reason: 'impossible' }] })
        .expect(400); // reste rendu > consommé
      const sucreBefore = await qtyOf(ids.sucre);
      const res = await api(app, chef, plateau)
        .post(done)
        .send({
          producedQuantity: 77,
          lossCause: 'BURNT',
          lossReason: 'Four trop chaud',
          adjustments: [
            { itemId: beurreItem, extraQuantity: 0.05, reason: 'Pâte trop sèche' },
            { itemId: sucreItem, returnedQuantity: 0.05, reason: 'Reste non utilisé' },
          ],
        })
        .expect(201);
      expect(res.body.status).toBe('COMPLETED');
      expect((await qtyOf(ids.sucre)).quantity).toBeCloseTo(sucreBefore.quantity + 0.05, 4);
      // Coût réel = valeur nette des lots consommés ; coût unitaire sur 77 produits bons.
      const net = res.body.consumptions.reduce((s: number, c: { value: string }) => s + num(c.value), 0);
      expect(num(res.body.realCost)).toBeCloseTo(net, 1);
      expect(num(res.body.unitCost)).toBeCloseTo(net / 77, 3);
      expect(res.body.losses.map((l: { stage: string; quantity: string; cause: string }) => [l.stage, num(l.quantity), l.cause])).toEqual([['COMPLETION', 3, 'BURNT']]);
      // Lot de produit fini : 77 croissants, péremption = aujourd'hui + 1 jour (décision F).
      const out = res.body.outputs[0];
      expect(num(out.quantity)).toBe(77);
      expect(out.expiryDate.slice(0, 10)).toBe(inDays(1));
      const lot = await prisma.stockLot.findUniqueOrThrow({ where: { id: out.lotId } });
      expect([lot.origin, lot.productId]).toEqual(['PRODUCTION', ids.croissant]);
      expect((await qtyOf(ids.croissant)).quantity).toBe(77);
      ids.croissantLot = out.lotId;
      ids.croissantLotNumber = out.lotNumber;
    });

    it('fait contrôler par un responsable autre que le producteur, non-conformités en perte', async () => {
      const ctrl = `/api/production-orders/${ids.order}/control`;
      await api(app, chef, plateau).post(ctrl).send({}).expect(403); // pas « Valider un inventaire »
      await api(app, prod, plateau).post(ctrl).send({}).expect(403);
      await api(app, manager, plateau).post(ctrl).send({ nonConformQuantity: 2 }).expect(400); // cause manquante
      const res = await api(app, manager, plateau).post(ctrl).send({ nonConformQuantity: 2, cause: 'QUALITY', reason: 'Croissants déformés', note: 'RAS sinon' }).expect(201);
      expect(res.body.status).toBe('CONTROLLED');
      expect((await qtyOf(ids.croissant)).quantity).toBe(75);
      const loss = await prisma.stockLoss.findFirstOrThrow({ where: { productId: ids.croissant } });
      expect([loss.cause, num(loss.quantity)]).toEqual(['QUALITY', 2]);
      await api(app, manager, plateau).post(ctrl).send({}).expect(409);
    });

    it('refuse que celui qui termine contrôle lui-même ; surplus accepté avec motif', async () => {
      const o = await order(manager, ids.croissant, 40).expect(201);
      const url = (a: string) => `/api/production-orders/${o.body.id}/${a}`;
      await api(app, manager, plateau).post(url('validate')).expect(201);
      await api(app, manager, plateau).post(url('start')).expect(201);
      await api(app, manager, plateau).post(url('complete')).send({ producedQuantity: 42 }).expect(400); // surplus sans motif
      await api(app, manager, plateau).post(url('complete')).send({ producedQuantity: 42, overReason: 'Pâte plus abondante' }).expect(201);
      await api(app, manager, plateau).post(url('control')).send({}).expect(403); // décision E
      await api(app, admin, plateau).post(url('control')).send({ note: 'Conforme' }).expect(201);
    });
  });

  describe('Sous-recette, traçabilité et visibilité', () => {
    it('produit une sous-préparation puis la consomme (traçabilité en cascade)', async () => {
      const cr = await order(prod, ids.creme, 1).expect(201);
      for (const a of ['validate', 'start']) await api(app, prod, plateau).post(`/api/production-orders/${cr.body.id}/${a}`).expect(201);
      const crDone = await api(app, prod, plateau).post(`/api/production-orders/${cr.body.id}/complete`).send({ producedQuantity: 1 }).expect(201);
      const ta = await order(prod, ids.tarte, 1).expect(201);
      expect(num(ta.body.items.find((i: { productId: string }) => i.productId === ids.creme).theoreticalQuantity)).toBe(0.5); // 500 g → 0,5 kg
      for (const a of ['validate', 'start']) await api(app, prod, plateau).post(`/api/production-orders/${ta.body.id}/${a}`).expect(201);
      const taDone = await api(app, prod, plateau).post(`/api/production-orders/${ta.body.id}/complete`).send({ producedQuantity: 1 }).expect(201);
      const trace = await api(app, storekeeper, plateau).get(`/api/traceability/lots/${taDone.body.outputs[0].lotId}`).expect(200);
      const cremeInput = trace.body.upstream.inputs.find((x: { lot: { item: { code: string } } }) => x.lot.item.code === 'CREME');
      expect(cremeInput.lot.lotId).toBe(crDone.body.outputs[0].lotId);
      expect(cremeInput.lot.inputs.map((x: { lot: { item: { code: string } } }) => x.lot.item.code).sort()).toEqual(['OEU', 'SUC']);
    });

    it('retrouve les matières d’un produit et les produits issus d’un lot de matière', async () => {
      const up = await api(app, storekeeper, plateau).get(`/api/traceability?lotNumber=${ids.croissantLotNumber}`).expect(200);
      const farineInput = up.body.upstream.inputs.find((x: { lot: { item: { code: string } } }) => x.lot.item.code === 'FAR');
      expect(farineInput.lot.supplier.name).toBe('Grands Moulins');
      expect(farineInput.lot.receipt.number).toMatch(/^PLT-REC-/);
      const down = await api(app, storekeeper, plateau).get(`/api/traceability/lots/${farineInput.lot.lotId}`).expect(200);
      const lots = down.body.downstream.flatMap((d: { outputs: { lotId: string }[] }) => d.outputs.map((o) => o.lotId));
      expect(lots).toContain(ids.croissantLot);
      await api(app, cashier, plateau).get(`/api/traceability/lots/${ids.croissantLot}`).expect(403);
      await api(app, chefYop, yopougon).get(`/api/traceability/lots/${ids.croissantLot}`).expect(403); // lot jamais passé à Yopougon
    });

    it('le magasinier voit les ordres validés (lecture seule), pas les planifiés', async () => {
      const planned = await order(chef, ids.croissant, 40).expect(201);
      const list = await api(app, storekeeper, plateau).get('/api/production-orders').expect(200);
      expect(list.body.some((o: Id) => o.id === planned.body.id)).toBe(false);
      expect(list.body.some((o: Id) => o.id === ids.order)).toBe(true);
      await api(app, storekeeper, plateau).get(`/api/production-orders/${planned.body.id}`).expect(404);
      await api(app, storekeeper, plateau).post(`/api/production-orders/${planned.body.id}/validate`).expect(403);
      await api(app, cashier, plateau).get('/api/production-orders').expect(403);
      const yop = await api(app, chefYop, yopougon).get('/api/production-orders').expect(200);
      expect(yop.body).toHaveLength(0); // isolement entre établissements
      await api(app, chefYop, yopougon).get(`/api/production-orders/${ids.order}`).expect(404);
    });
  });

  describe('Concurrence et intégrité', () => {
    it('deux validations simultanées ne réservent jamais plus que le stock', async () => {
      const { quantity, reserved } = await qtyOf(ids.beurre);
      const free = quantity - reserved; // beurre : 0,5 kg par fournée de 40
      const batch = Math.floor((free / 0.5) * 0.6) * 40; // chaque ordre prend ~60 % du libre
      const a = await order(chef, ids.croissant, batch).expect(201);
      const b = await order(chef, ids.croissant, batch).expect(201);
      const results = await Promise.all([a, b].map((o) => api(app, chef, plateau).post(`/api/production-orders/${o.body.id}/validate`)));
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const after = await qtyOf(ids.beurre);
      expect(after.reserved).toBeLessThanOrEqual(after.quantity);
    });

    it('un ordre envoyé deux fois n’est créé qu’une fois', async () => {
      const key = crypto.randomUUID();
      const results = await Promise.all([1, 2, 3].map(() => order(chef, ids.croissant, 40, { clientRequestId: key })));
      expect(results.every((r) => r.status === 201)).toBe(true);
      expect(await prisma.productionOrder.count({ where: { clientRequestId: key } })).toBe(1);
    });

    it('protège l’historique de production et garde chaque solde égal à ses mouvements', async () => {
      await expect(prisma.$executeRaw`UPDATE production_consumptions SET quantity = 1`).rejects.toThrow(/ajout seul/);
      await expect(prisma.$executeRaw`DELETE FROM production_outputs`).rejects.toThrow(/ajout seul/);
      await expect(prisma.$executeRaw`DELETE FROM production_orders`).rejects.toThrow(/Suppression interdite/);
      await expect(prisma.$executeRaw`DELETE FROM recipe_versions`).rejects.toThrow(/suppression interdite/);
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*) AS n FROM stock_balances b
        WHERE b.quantity <> (SELECT COALESCE(SUM(m.quantity), 0) FROM stock_movements m WHERE m.location_id = b.location_id AND m.lot_id = b.lot_id)`;
      expect(Number(rows[0].n)).toBe(0);
      // Réservations : la somme des réservations actives égale le réservé des soldes.
      const res = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*) AS n FROM stock_balances b
        WHERE b.reserved_quantity <> (SELECT COALESCE(SUM(r.quantity), 0) FROM production_reservations r WHERE r.balance_id = b.id AND r.released_at IS NULL)`;
      expect(Number(res[0].n)).toBe(0);
      expect(principal).toBeTruthy();
    });
  });
});
