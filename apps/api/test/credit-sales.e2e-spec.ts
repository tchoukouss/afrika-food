import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { SalesService } from '../src/sales/sales';
import { ADMIN_EMAIL, ADMIN_PASSWORD, api, createAndLogin, createTestApp, login, resetDatabase, Session } from './helpers';

type User = Session & { id: string };
const num = (v: unknown) => Number(v);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Vente à crédit (H1-a) : part du ticket mise à crédit, jamais un paiement ni
 * un mouvement de caisse (module 5) ; créance du module 7 par la facture du
 * ticket, émise dans la même transaction, après contrôle de la limite.
 */
describe('Vente à crédit — caisse (module 5) et créance (module 7)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cashier: User;
  let manager: User;
  let plateau: string;
  let session: string;
  let coca: string;
  const ids: Record<string, string> = {};

  /** Vente de quantity cocas à 500 F. */
  const sell = (body: object, quantity = 2) => api(app, cashier, plateau).post('/api/sales').send({ sessionId: session, lines: [{ productId: coca, quantity }], ...body });
  const cocaStock = async () => num((await prisma.stockBalance.aggregate({ where: { productId: coca }, _sum: { quantity: true } }))._sum.quantity ?? 0);
  const movements = (saleId: string) => prisma.cashMovement.findMany({ where: { saleId } });
  const invoiceOf = async (saleId: string) => {
    const inv = await prisma.invoice.findFirstOrThrow({ where: { saleId } });
    return (await api(app, manager, plateau).get(`/api/invoices/${inv.id}`).expect(200)).body;
  };
  /** Lignes « À crédit » et « Facture » du ticket rendu, sans les espaces d'alignement. */
  const creditLines = (ticket: { lines: string[] }) => ticket.lines.filter((l) => /^(À crédit|Facture) /.test(l)).map((l) => l.replace(/ {2,}/g, ' '));
  const outstanding = async (customerId: string) => num((await api(app, manager, plateau).get(`/api/customers/${customerId}/credit`).query({ establishmentId: plateau }).expect(200)).body.outstanding);
  const snapshot = async () => ({
    sales: await prisma.sale.count(),
    invoices: await prisma.invoice.count(),
    moves: await prisma.cashMovement.count(),
    stock: await cocaStock(),
    voided: await prisma.auditLog.count({ where: { action: 'SALE_NUMBER_VOIDED' } }),
  });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    const admin = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const roles = Object.fromEntries((await api(app, admin).get('/api/roles').expect(200)).body.map((r: { code: string; id: string }) => [r.code, r.id]));
    plateau = (await api(app, admin).post('/api/establishments').send({ code: 'PLT', name: 'Pâtisserie Plateau', type: 'PATISSERIE' }).expect(201)).body.id;
    cashier = await createAndLogin(app, admin, { email: 'caisse@test.ci', fullName: 'caisse', roles: [{ roleId: roles.CASHIER, establishmentId: plateau }] });
    manager = await createAndLogin(app, admin, { email: 'resp@test.ci', fullName: 'resp', roles: [{ roleId: roles.MANAGER, establishmentId: plateau }] });
    const store = await createAndLogin(app, admin, { email: 'mag@test.ci', fullName: 'mag', roles: [{ roleId: roles.STOREKEEPER, establishmentId: plateau }] });
    coca = (await api(app, admin).post('/api/products').send({ code: 'COCA', name: 'Coca 33 cl', type: 'RESOLD', basePrice: 500 }).expect(201)).body.id;
    const supplier = (await api(app, admin).post('/api/suppliers').send({ code: 'SOL', name: 'Solibra' }).expect(201)).body.id;
    await api(app, store, plateau)
      .post('/api/goods-receipts')
      .send({ establishmentId: plateau, supplierId: supplier, items: [{ productId: coca, purchaseUnitLabel: 'unité', quantityPerPurchaseUnit: 1, receivedQuantity: 200, unitPrice: 300, expiryDate: inDays(90) }] })
      .expect(201);
    const register = (await api(app, admin).post('/api/cash-registers').send({ establishmentId: plateau, code: 'C1', name: 'Caisse 1', printerType: 'NONE' }).expect(201)).body.id;
    session = (await api(app, cashier, plateau).post('/api/cash-sessions').send({ registerId: register, openingFloat: 5000 }).expect(201)).body.id;
    // Clients : limites et délais fixés par un responsable (« credit.override »).
    const customer = async (name: string, extra: object) => (await api(app, manager, plateau).post('/api/customers').send({ type: 'BUSINESS', name, ...extra }).expect(201)).body.id;
    ids.a = await customer('Société Ivoire Events', { creditLimit: 10000, paymentTermDays: 30 });
    ids.noLimit = await customer('Client sans limite', {});
    ids.d = await customer('Traiteur Kouassi', { creditLimit: 3000, paymentTermDays: 15 });
    ids.inactive = await customer('Client parti', { creditLimit: 50000 });
    await api(app, manager, plateau).patch(`/api/customers/${ids.inactive}`).send({ isActive: false }).expect(200);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Ventes sans crédit : comportement inchangé', () => {
    it('paiement complet avec monnaie rendue, sans facture ni créance', async () => {
      const res = (await sell({ payments: [{ method: 'CASH', amount: 1500 }] }).expect(201)).body;
      const s = res.sale;
      expect([num(s.total), num(s.paidTotal), num(s.changeGiven), num(s.creditAmount)]).toEqual([1000, 1500, 500, 0]);
      // Ticket inchangé : ni « À crédit » ni « Facture ».
      expect(creditLines(res.ticket)).toEqual([]);
      expect(res.ticket.lines.some((l: string) => l.startsWith('Monnaie rendue'))).toBe(true);
      expect((await movements(s.id)).map((m) => [m.type, num(m.amount)])).toEqual([['SALE', 1000]]);
      expect(await prisma.invoice.count({ where: { saleId: s.id } })).toBe(0);
    });

    it('refuse toujours un paiement insuffisant sans crédit ; un crédit nul est une vente normale', async () => {
      expect((await sell({ payments: [{ method: 'CASH', amount: 400 }] }).expect(400)).body.message).toBe('Paiement insuffisant : il manque 600 FCFA');
      const s = (await sell({ payments: [{ method: 'CASH', amount: 1000 }], credit: { customerId: ids.a, amount: 0 } }).expect(201)).body.sale;
      expect([num(s.creditAmount), await prisma.invoice.count({ where: { saleId: s.id } })]).toEqual([0, 0]);
    });

    it('le traitement de la créance est branché une seule fois', () => {
      expect(() => app.get(SalesService).registerCreditSaleHandler(async () => ({ invoiceId: '', invoiceNumber: '' }))).toThrow(/déjà enregistré/);
    });
  });

  describe('Vente à crédit', () => {
    it('paiement partiel + crédit : une seule vente, une facture émise, reste dû = part à crédit, sans mouvement de caisse en plus', async () => {
      const before = await snapshot();
      const key = randomUUID();
      const body = { clientRequestId: key, payments: [{ method: 'CASH', amount: 400 }], credit: { customerId: ids.a, amount: 600 } };
      const res = (await sell(body).expect(201)).body;
      const s = res.sale;
      expect([num(s.total), num(s.paidTotal), num(s.changeGiven), num(s.creditAmount)]).toEqual([1000, 400, 0, 600]);
      expect((await movements(s.id)).map((m) => [m.type, m.method, num(m.amount)])).toEqual([['SALE', 'CASH', 400]]);
      const inv = await invoiceOf(s.id);
      expect([inv.source, inv.sale.id, inv.customer.id, inv.status, inv.number.startsWith('PLT-FAC-'), num(inv.total), num(inv.posPaidAmount), num(inv.balance), inv.paymentStatus]).toEqual([
        'SALE', s.id, ids.a, 'ISSUED', true, 1000, 400, 600, 'PARTIALLY_PAID',
      ]);
      expect([inv.paymentTermDays, inv.dueDate.slice(0, 10)]).toEqual([30, inDays(30)]); // conditions du client
      expect(inv.lines.map((l: { label: string; quantity: string; lineTotal: string }) => [l.label, num(l.quantity), num(l.lineTotal)])).toEqual([['Coca 33 cl', 2, 1000]]);
      expect(await outstanding(ids.a)).toBe(600);
      // Ticket : encaissé réel, part à crédit et facture de la créance.
      expect(res.ticket.lines.filter((l: string) => l.startsWith('Espèces')).map((l: string) => l.replace(/ {2,}/g, ' '))).toEqual(['Espèces 400 F']);
      expect(creditLines(res.ticket)).toEqual(['À crédit 600 F', `Facture ${inv.number}`]);
      expect(creditLines((await api(app, cashier, plateau).get(`/api/sales/${s.id}/ticket`).expect(200)).body)).toEqual(['À crédit 600 F', `Facture ${inv.number}`]);
      // Double envoi : même ticket, aucune seconde vente ni facture.
      expect((await sell(body).expect(201)).body.sale.id).toBe(s.id);
      const after = await snapshot();
      expect([after.sales - before.sales, after.invoices - before.invoices, after.moves - before.moves]).toEqual([1, 1, 1]);
      expect(await prisma.invoice.count({ where: { saleId: s.id } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { action: 'CREDIT_SALE_RECORDED', entityId: inv.id } })).toBe(1);
      ids.partialSale = s.id;
      ids.partialInvoice = inv.id;
    });

    it('crédit total : rien encaissé, aucun mouvement de caisse, facture entièrement due', async () => {
      const res = (await sell({ payments: [], credit: { customerId: ids.a, amount: 1000 } }).expect(201)).body;
      const s = res.sale;
      expect([num(s.paidTotal), num(s.creditAmount)]).toEqual([0, 1000]);
      expect(await movements(s.id)).toHaveLength(0);
      const inv = await invoiceOf(s.id);
      expect(creditLines(res.ticket)).toEqual(['À crédit 1 000 F', `Facture ${inv.number}`]);
      expect([num(inv.posPaidAmount), num(inv.balance), inv.paymentStatus]).toEqual([0, 1000, 'UNPAID']);
      expect(await outstanding(ids.a)).toBe(1600);
    });

    it('refuse un dépassement de limite sans autorisation, en annulant toute la vente', async () => {
      const before = await snapshot();
      // Encours 1 600 + 9 000 > limite 10 000.
      const res = await sell({ payments: [], credit: { customerId: ids.a, amount: 9000 } }, 18).expect(409);
      expect([res.body.code, res.body.outstanding, res.body.limit]).toEqual(['CREDIT_LIMIT_EXCEEDED', '1600', '10000']);
      const after = await snapshot();
      expect([after.sales, after.invoices, after.moves, after.stock]).toEqual([before.sales, before.invoices, before.moves, before.stock]);
      expect(after.voided).toBe(before.voided + 1); // numéro de ticket tracé, jamais réutilisé
      // Client sans limite : tout crédit exige une autorisation ; client désactivé refusé.
      expect((await sell({ payments: [{ method: 'CASH', amount: 500 }], credit: { customerId: ids.noLimit, amount: 500 } }).expect(409)).body.code).toBe('CREDIT_LIMIT_EXCEEDED');
      expect((await sell({ payments: [{ method: 'CASH', amount: 500 }], credit: { customerId: ids.inactive, amount: 500 } }).expect(409)).body.code).toBe('CUSTOMER_INACTIVE');
      await sell({ payments: [{ method: 'CASH', amount: 500 }], credit: { customerId: randomUUID(), amount: 500 } }).expect(404);
      expect(await outstanding(ids.a)).toBe(1600);
    });

    it('accepte un dépassement avec une autorisation valide, consommée une seule fois', async () => {
      const ov = (await api(app, manager, plateau).post(`/api/customers/${ids.a}/credit-overrides`).send({ establishmentId: plateau, maxAmount: 9000, reason: 'Mariage Kouassi' }).expect(201)).body;
      await api(app, cashier, plateau).post(`/api/customers/${ids.a}/credit-overrides`).send({ establishmentId: plateau, maxAmount: 9000, reason: 'Essai' }).expect(403);
      const key = randomUUID();
      const body = { clientRequestId: key, payments: [], credit: { customerId: ids.a, amount: 9000, overrideId: ov.id } };
      const s = (await sell(body, 18).expect(201)).body.sale;
      expect((await sell(body, 18).expect(201)).body.sale.id).toBe(s.id); // rejeu : l'autorisation n'est pas consommée deux fois
      const used = await prisma.creditOverride.findUniqueOrThrow({ where: { id: ov.id } });
      expect([!!used.usedAt, num(used.usedAmount), used.usedReference]).toEqual([true, 9000, `Ticket ${s.number}`]);
      expect(await prisma.auditLog.count({ where: { action: 'CREDIT_OVERRIDE_USED', entityId: ov.id } })).toBe(1);
      expect(num((await invoiceOf(s.id)).balance)).toBe(9000);
      expect(await outstanding(ids.a)).toBe(10600);
      // Même autorisation pour une autre vente : refusée, rien n'est créé.
      const before = await snapshot();
      expect((await sell({ payments: [], credit: { customerId: ids.a, amount: 500, overrideId: ov.id } }, 1).expect(409)).body.code).toBe('CREDIT_OVERRIDE_INVALID');
      const after = await snapshot();
      expect([after.sales, after.invoices]).toEqual([before.sales, before.invoices]);
    });

    it('ne laisse jamais deux ventes simultanées dépasser la limite', async () => {
      // Limite 3 000 : deux ventes de 2 000 à crédit en même temps → une seule passe.
      const res = await Promise.all([sell({ payments: [], credit: { customerId: ids.d, amount: 2000 } }, 4), sell({ payments: [], credit: { customerId: ids.d, amount: 2000 } }, 4)]);
      expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await outstanding(ids.d)).toBe(2000);
      expect(await prisma.invoice.count({ where: { customerId: ids.d } })).toBe(1);
    });

    it('se corrige par l’avoir et s’encaisse par la facture, jamais par la caisse', async () => {
      // Ticket facturé : pas d'annulation ni de remboursement en caisse.
      expect((await api(app, manager, plateau).post(`/api/sales/${ids.partialSale}/cancel`).send({ reason: 'Erreur' }).expect(409)).body.code).toBe('INVOICED_TICKET');
      // Encaissement du reste dû par la facture (paiement client du module 7).
      const paid = (await api(app, manager, plateau).post(`/api/invoices/${ids.partialInvoice}/payments`).send({ method: 'BANK_TRANSFER', amount: 600, reference: 'VIR-1' }).expect(201)).body;
      expect([paid.paymentStatus, num(paid.balance)]).toEqual(['PAID', 0]);
    });
  });

  describe('Base de données', () => {
    it('garde la contrainte du ticket : crédit ≤ total, encaissé + crédit = total, aucune monnaie sur une vente à crédit', async () => {
      const ref = await prisma.sale.findFirstOrThrow();
      const base = { companyId: ref.companyId, establishmentId: ref.establishmentId, registerId: ref.registerId, sessionId: ref.sessionId, cashierId: ref.cashierId, grossTotal: 1000n, lineDiscountTotal: 0n, ticketDiscountAmount: 0n, total: 1000n, taxTotal: 0n, costTotal: 0 };
      await expect(prisma.sale.create({ data: { ...base, number: 'T-1', paidTotal: 0n, changeGiven: 0n, creditAmount: 1001n } })).rejects.toThrow();
      await expect(prisma.sale.create({ data: { ...base, number: 'T-2', paidTotal: 500n, changeGiven: 0n, creditAmount: 600n } })).rejects.toThrow();
      await expect(prisma.sale.create({ data: { ...base, number: 'T-3', paidTotal: 600n, changeGiven: 200n, creditAmount: 600n } })).rejects.toThrow();
      await expect(prisma.sale.create({ data: { ...base, number: 'T-4', paidTotal: 500n, changeGiven: 0n, creditAmount: -500n } })).rejects.toThrow();
      const onCredit = await prisma.sale.findFirstOrThrow({ where: { creditAmount: { gt: 0 } } });
      await expect(prisma.$executeRaw`UPDATE sales SET credit_amount = 0, paid_total = total WHERE id = ${onCredit.id}::uuid`).rejects.toThrow(/seules les colonnes/);
      // Une seule facture par ticket, même écrite directement.
      const inv = await prisma.invoice.findFirstOrThrow({ where: { saleId: onCredit.id } });
      await expect(prisma.invoice.create({ data: { companyId: inv.companyId, establishmentId: inv.establishmentId, customerId: inv.customerId, source: 'SALE', saleId: onCredit.id, total: 1000n, taxTotal: 0n, createdById: inv.createdById } })).rejects.toThrow();
    });
  });
});
