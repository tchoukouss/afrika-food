import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { ADMIN_EMAIL, ADMIN_PASSWORD, api, createAndLogin, createTestApp, login, resetDatabase, Session } from './helpers';

type User = Session & { id: string };
const year = new Date().getUTCFullYear();
const num = (v: unknown) => Number(v);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe('Module 7 — Étape 5 : factures, avoirs et créances', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: Session;
  let manager: User; // Responsable Plateau : tous les droits
  let cashier: User; // Caissier Plateau : encaisse, lit les factures, sans les gérer
  let accountant: User; // Comptable Plateau : factures, paiements hors caisse, sans remboursement
  let managerYop: User;
  let waiter: User;
  let plateau: string;
  let yopougon: string;
  const ids: Record<string, string> = {};

  const invoice = (u: Session, body: object, est = plateau) => api(app, u, est).post('/api/invoices').send({ establishmentId: est, ...body });
  const manual = (u: Session, amount: number, est = plateau, customerId = ids.customer) =>
    invoice(u, { source: 'MANUAL', customerId, lines: [{ kind: 'FEE', label: 'Prestation traiteur', quantity: 1, unitPrice: amount, taxRate: 18 }] }, est);
  const issue = (u: Session, id: string, est = plateau) => api(app, u, est).post(`/api/invoices/${id}/issue`);
  const get = async (id: string, u: Session = manager) => (await api(app, u, plateau).get(`/api/invoices/${id}`).expect(200)).body;
  const allocate = (id: string, body: object, u: Session = accountant) => api(app, u, plateau).post(`/api/invoices/${id}/allocations`).send(body);
  const credit = (id: string, body: object, u: Session = manager) => api(app, u, plateau).post(`/api/invoices/${id}/credit-notes`).send({ reason: 'Correction client', ...body });
  const transfer = async (amount: number, ref: string) =>
    (await api(app, accountant, plateau).post('/api/customer-payments').send({ establishmentId: plateau, customerId: ids.customer, method: 'BANK_TRANSFER', amount, reference: ref }).expect(201)).body.id as string;
  const draftAndIssue = async (amount: number) => {
    const d = (await manual(manager, amount).expect(201)).body;
    return (await issue(manager, d.id).expect(201)).body;
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDatabase(prisma);
    admin = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const roles = Object.fromEntries((await api(app, admin).get('/api/roles').expect(200)).body.map((r: { code: string; id: string }) => [r.code, r.id]));
    plateau = (await api(app, admin).post('/api/establishments').send({ code: 'PLT', name: 'Pâtisserie Plateau', type: 'PATISSERIE' }).expect(201)).body.id;
    yopougon = (await api(app, admin).post('/api/establishments').send({ code: 'YOP', name: 'Restaurant Yopougon', type: 'RESTAURANT' }).expect(201)).body.id;
    const user = (email: string, role: string, est: string) => createAndLogin(app, admin, { email, fullName: email.split('@')[0], roles: [{ roleId: roles[role], establishmentId: est }] });
    manager = await user('resp@test.ci', 'MANAGER', plateau);
    cashier = await user('caisse@test.ci', 'CASHIER', plateau);
    accountant = await user('compta@test.ci', 'ACCOUNTANT', plateau);
    managerYop = await user('respyop@test.ci', 'MANAGER', yopougon);
    waiter = await user('serveur@test.ci', 'WAITER', plateau);
    const store = await user('mag@test.ci', 'STOREKEEPER', plateau);

    ids.coca = (await api(app, admin).post('/api/products').send({ code: 'COCA', name: 'Coca 33 cl', type: 'RESOLD', basePrice: 500, taxRate: 18 }).expect(201)).body.id;
    const supplier = (await api(app, admin).post('/api/suppliers').send({ code: 'SOL', name: 'Solibra' }).expect(201)).body.id;
    await api(app, store, plateau)
      .post('/api/goods-receipts')
      .send({ establishmentId: plateau, supplierId: supplier, items: [{ productId: ids.coca, purchaseUnitLabel: 'unité', quantityPerPurchaseUnit: 1, receivedQuantity: 100, unitPrice: 300, expiryDate: inDays(90) }] })
      .expect(201);
    const register = async (est: string, code: string) => (await api(app, admin).post('/api/cash-registers').send({ establishmentId: est, code, name: `Caisse ${code}`, printerType: 'NONE' }).expect(201)).body.id;
    const [c1, c2] = [await register(plateau, 'C1'), await register(plateau, 'C2')];
    ids.sessCashier = (await api(app, cashier, plateau).post('/api/cash-sessions').send({ registerId: c1, openingFloat: 10000 }).expect(201)).body.id;
    ids.sessManager = (await api(app, manager, plateau).post('/api/cash-sessions').send({ registerId: c2, openingFloat: 50000 }).expect(201)).body.id;

    // Client à 30 jours ; client « comptant ».
    ids.customer = (await api(app, manager, plateau).post('/api/customers').send({ type: 'BUSINESS', name: 'Société Ivoire Events', phone: '0102030405', paymentTermDays: 30 }).expect(201)).body.id;
    ids.cash = (await api(app, manager, plateau).post('/api/customers').send({ type: 'INDIVIDUAL', name: 'Awa Koné' }).expect(201)).body.id;

    // Commande confirmée : 10 cocas réservés + traiteur, livraison à 2 000 F.
    const o = (await api(app, manager, plateau)
      .post('/api/customer-orders')
      .send({ establishmentId: plateau, customerId: ids.customer, lines: [{ kind: 'PRODUCT', productId: ids.coca, quantity: 10 }, { kind: 'FEE', label: 'Traiteur', quantity: 1, unitPrice: 50000, taxRate: 18 }] })
      .expect(201)).body;
    await api(app, manager, plateau).post(`/api/customer-orders/${o.id}/status`).send({ status: 'CONFIRMED' }).expect(201);
    await api(app, manager, plateau).post(`/api/customer-orders/${o.id}/deliveries`).send({ address: 'Cocody Angré', fee: 2000, feeLabel: 'Livraison Angré' }).expect(201);
    ids.order = o.id;
    ids.draftOrder = (await api(app, manager, plateau).post('/api/customer-orders').send({ establishmentId: plateau, customerId: ids.customer, lines: [{ kind: 'FEE', label: 'Divers', quantity: 1, unitPrice: 1000 }] }).expect(201)).body.id;

    // Ticket de caisse : 2 cocas payés en espèces.
    const sale = (await api(app, cashier, plateau).post('/api/sales').send({ sessionId: ids.sessCashier, lines: [{ productId: ids.coca, quantity: 2 }], payments: [{ method: 'CASH', amount: 1000 }] }).expect(201)).body.sale;
    ids.sale = sale.id;
    ids.stockMoves = String(await prisma.stockMovement.count());
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Brouillon et émission', () => {
    it('crée la facture d’une commande en brouillon, sans numéro, prix et TVA figés', async () => {
      const key = randomUUID();
      const d = (await invoice(manager, { clientRequestId: key, source: 'ORDER', orderId: ids.order, deliveryFeeTaxRate: 18 }).expect(201)).body;
      expect((await invoice(manager, { clientRequestId: key, source: 'ORDER', orderId: ids.order }).expect(201)).body.id).toBe(d.id);
      expect([d.number, d.status, d.paymentStatus, num(d.total), d.customer.id]).toEqual([null, 'DRAFT', null, 5000 + 50000 + 2000, ids.customer]);
      expect(d.lines.map((l: { kind: string; label: string; lineTotal: string; taxRate: string }) => [l.kind, l.label, num(l.lineTotal), num(l.taxRate)])).toEqual([
        ['PRODUCT', 'Coca 33 cl', 5000, 18],
        ['FEE', 'Traiteur', 50000, 18],
        ['FEE', 'Livraison Angré', 2000, 18],
      ]);
      expect(num(d.taxTotal)).toBe(763 + 7627 + 305);
      await invoice(manager, { source: 'ORDER', orderId: ids.order }).expect(409); // une seule facture en cours par commande
      await invoice(manager, { source: 'ORDER', orderId: ids.draftOrder }).expect(409); // commande en brouillon
      await invoice(manager, { source: 'ORDER', orderId: ids.order, customerId: ids.cash }).expect(400);
      await invoice(manager, { source: 'MANUAL', customerId: ids.customer, lines: [{ kind: 'PRODUCT', productId: ids.coca, quantity: 1 }] }).expect(400); // produit sans sortie de stock
      // Hausse de prix après le brouillon : la facture garde ses prix.
      await api(app, admin).put(`/api/products/${ids.coca}/price`).send({ price: 900 }).expect(200);
      expect(num((await get(d.id)).lines[0].unitPrice)).toBe(500);
      expect(await prisma.auditLog.count({ where: { action: 'INVOICE_DRAFTED', entityId: d.id } })).toBe(1);
      ids.orderInvoice = d.id;
    });

    it('émet atomiquement avec le numéro FAC et l’échéance du client, puis fige la facture', async () => {
      await issue(cashier, ids.orderInvoice).expect(403);
      const i = (await issue(accountant, ids.orderInvoice).expect(201)).body;
      expect([i.number, i.status, i.paymentTermDays, i.dueDate.slice(0, 10), i.paymentStatus, i.overdue, num(i.balance)]).toEqual([
        `PLT-FAC-${year}-000001`,
        'ISSUED',
        30,
        inDays(30),
        'UNPAID',
        false,
        57000,
      ]);
      expect(await prisma.auditLog.count({ where: { action: 'INVOICE_ISSUED', entityId: i.id } })).toBe(1);
      await issue(accountant, ids.orderInvoice).expect(409);
      await api(app, manager, plateau).patch(`/api/invoices/${i.id}`).send({ notes: 'Trop tard' }).expect(409);
      const line = i.lines[0].id;
      await expect(prisma.$executeRaw`UPDATE invoices SET total = 1 WHERE id = ${i.id}::uuid`).rejects.toThrow(/seul son état/);
      await expect(prisma.$executeRaw`UPDATE invoices SET number = 'X' WHERE id = ${i.id}::uuid`).rejects.toThrow(/seul son état/);
      await expect(prisma.$executeRaw`UPDATE invoice_lines SET unit_price = 1 WHERE id = ${line}::uuid`).rejects.toThrow(/lignes figées/);
      await expect(prisma.$executeRaw`DELETE FROM invoices WHERE id = ${i.id}::uuid`).rejects.toThrow(/suppression interdite/);
    });

    it('numérote sans trou, par établissement et par année, même en émissions simultanées', async () => {
      const drafts = [];
      for (let n = 0; n < 4; n++) drafts.push((await manual(manager, 10000).expect(201)).body.id);
      // Une émission refusée (client désactivé) ne consomme aucun numéro.
      const inactive = (await api(app, manager, plateau).post('/api/customers').send({ type: 'INDIVIDUAL', name: 'Client parti' }).expect(201)).body.id;
      const refused = (await manual(manager, 5000, plateau, inactive).expect(201)).body.id;
      await api(app, manager, plateau).patch(`/api/customers/${inactive}`).send({ isActive: false }).expect(200);
      await issue(manager, refused).expect(409);
      const res = await Promise.all(drafts.map((d) => issue(manager, d)));
      expect(res.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      expect(res.map((r) => r.body.number).sort()).toEqual([2, 3, 4, 5].map((n) => `PLT-FAC-${year}-00000${n}`));
      const yop = (await manual(managerYop, 8000, yopougon).expect(201)).body;
      expect((await issue(managerYop, yop.id, yopougon).expect(201)).body.number).toBe(`YOP-FAC-${year}-000001`);
      const seq = await prisma.$queryRaw<{ scope_key: string; year: number; last_value: number }[]>`SELECT scope_key, year, last_value FROM document_sequences WHERE doc_type = 'INVOICE' ORDER BY last_value DESC`;
      expect(seq.map((s) => [s.scope_key, s.year, s.last_value])).toEqual([[plateau, year, 5], [yopougon, year, 1]]);
      // Brouillon abandonné : jamais numéroté, jamais supprimé.
      const c = (await api(app, manager, plateau).post(`/api/invoices/${refused}/cancel`).send({ reason: 'Client parti' }).expect(201)).body;
      expect([c.status, c.number]).toEqual(['CANCELLED', null]);
      ids.manualA = res[0].body.id;
      ids.manualB = res[1].body.id;
      ids.manualC = res[2].body.id;
      ids.manualD = res[3].body.id;
      ids.yopInvoice = yop.id;
    });
  });

  describe('Règlements', () => {
    it('suit le paiement partiel, l’acompte imputé, puis le paiement complet', async () => {
      const inv = ids.orderInvoice;
      // Paiement partiel par virement.
      const t = await transfer(20000, 'VIR-100');
      const a = (await allocate(inv, { paymentId: t, amount: 20000 }).expect(201)).body;
      expect([a.paymentStatus, num(a.paid), num(a.balance)]).toEqual(['PARTIALLY_PAID', 20000, 37000]);
      // Acompte de la commande imputé sur la facture.
      const dep = (await api(app, manager, plateau).post('/api/deposits').send({ establishmentId: plateau, customerId: ids.customer, orderId: ids.order, payment: { method: 'CASH', amount: 15000, sessionId: ids.sessManager } }).expect(201)).body;
      const b = (await allocate(inv, { depositId: dep.id, amount: 15000 }).expect(201)).body;
      expect([num(b.paid), num(b.balance)]).toEqual([35000, 22000]);
      const d = (await api(app, manager, plateau).get(`/api/deposits/${dep.id}`).expect(200)).body;
      expect([num(d.applied), num(d.available), d.status]).toEqual([15000, 0, 'RECEIVED']);
      await api(app, manager, plateau).post(`/api/deposits/${dep.id}/refund`).send({ method: 'CASH', amount: 1, sessionId: ids.sessManager, reason: 'Essai' }).expect(409);
      await api(app, manager, plateau).post(`/api/deposits/${dep.id}/cancel`).send({ reason: 'Essai' }).expect(409);
      await allocate(inv, { depositId: dep.id, amount: 1 }).expect(409); // acompte déjà imputé

      // Jamais au-delà du reste dû ni du paiement, même en simultané.
      const big = await transfer(50000, 'VIR-101');
      await allocate(inv, { paymentId: big, amount: 22001 }).expect(409);
      const res = await Promise.all([allocate(inv, { paymentId: big, amount: 15000 }), allocate(inv, { paymentId: big, amount: 15000 })]);
      expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(num((await get(inv)).balance)).toBe(7000);
      await allocate(inv, { paymentId: big, amount: 1000 }, waiter).expect(403);

      // Solde encaissé à la caisse par le caissier.
      const key = randomUUID();
      const paid = (await api(app, cashier, plateau).post(`/api/invoices/${inv}/payments`).send({ clientRequestId: key, method: 'CASH', amount: 7000, sessionId: ids.sessCashier }).expect(201)).body;
      await api(app, cashier, plateau).post(`/api/invoices/${inv}/payments`).send({ clientRequestId: key, method: 'CASH', amount: 7000, sessionId: ids.sessCashier }).expect(201);
      expect(await prisma.customerPayment.count({ where: { clientRequestId: key } })).toBe(1);
      expect([paid.paymentStatus, num(paid.paid), num(paid.balance), paid.allocations.length]).toEqual(['PAID', 57000, 0, 4]);
      await allocate(inv, { paymentId: big, amount: 1 }).expect(409);
      const sum = await prisma.paymentAllocation.aggregate({ where: { invoiceId: inv, releasedAt: null }, _sum: { amount: true } });
      expect(num(sum._sum.amount)).toBe(57000);
      ids.bigTransfer = big;
    });

    it('calcule l’échéance et le retard à la lecture, et l’encours du client', async () => {
      const inv = ids.manualA;
      expect((await get(inv)).overdue).toBe(false);
      // Échéance dépassée (simulée en base, protection levée le temps du test).
      await prisma.$executeRawUnsafe('ALTER TABLE invoices DISABLE TRIGGER invoices_guard');
      await prisma.$executeRaw`UPDATE invoices SET due_date = CURRENT_DATE - 1 WHERE id = ${inv}::uuid`;
      await prisma.$executeRawUnsafe('ALTER TABLE invoices ENABLE TRIGGER invoices_guard');
      const late = await get(inv);
      expect([late.overdue, late.paymentStatus, num(late.balance)]).toEqual([true, 'UNPAID', 10000]);
      const overdue = (await api(app, accountant, plateau).get('/api/invoices?overdue=true').expect(200)).body;
      expect(overdue.map((x: { id: string }) => x.id)).toEqual([inv]);
      // Encours du groupe (décision D9) : 4 × 10 000 au Plateau + 8 000 à Yopougon ; la facture de commande est payée.
      const c = (await api(app, manager, plateau).get(`/api/customers/${ids.customer}/credit?establishmentId=${plateau}`).expect(200)).body;
      expect(num(c.outstanding)).toBe(48000);
    });

    it('facture un ticket une seule fois, sans seconde vente ni encaissement', async () => {
      const before = { sales: await prisma.sale.count(), cash: await prisma.cashMovement.count() };
      await invoice(manager, { source: 'SALE', saleId: ids.sale }).expect(400); // client obligatoire
      const d = (await invoice(manager, { source: 'SALE', saleId: ids.sale, customerId: ids.cash }).expect(201)).body;
      await invoice(manager, { source: 'SALE', saleId: ids.sale, customerId: ids.cash }).expect(409);
      const i = (await issue(manager, d.id).expect(201)).body;
      expect([i.source, i.sale.id, num(i.total), num(i.posPaidAmount), i.paymentStatus, num(i.balance), i.dueDate.slice(0, 10)]).toEqual(['SALE', ids.sale, 1000, 1000, 'PAID', 0, inDays(0)]);
      expect(i.lines.map((l: { label: string; quantity: string; lineTotal: string }) => [l.label, num(l.quantity), num(l.lineTotal)])).toEqual([['Coca 33 cl', 2, 1000]]);
      expect([await prisma.sale.count(), await prisma.cashMovement.count()]).toEqual([before.sales, before.cash]);
      // Ticket facturé : plus d'annulation ni de remboursement en caisse (correction par avoir) — 409 métier, aucune écriture.
      const writes = async () => [
        await prisma.saleReturn.count(),
        await prisma.cashMovement.count(),
        await prisma.stockMovement.count(),
        await prisma.customerRefund.count(),
        (await prisma.sale.findUniqueOrThrow({ where: { id: ids.sale } })).status,
      ];
      const snapshot = await writes();
      const item = (await prisma.saleItem.findFirstOrThrow({ where: { saleId: ids.sale } })).id;
      const attempts = [
        await api(app, manager, plateau).post(`/api/sales/${ids.sale}/cancel`).send({ reason: 'Erreur de saisie' }),
        await api(app, manager, plateau)
          .post(`/api/sales/${ids.sale}/refund`)
          .send({ sessionId: ids.sessManager, reason: 'Client mécontent', lines: [{ saleItemId: item, quantity: 1, disposition: 'RESTOCK' }] }),
      ];
      for (const r of attempts) {
        expect([r.status, r.body.code]).toEqual([409, 'INVOICED_TICKET']);
        expect(r.body.message).toMatch(/Ticket déjà facturé.*avoir/);
      }
      expect(await writes()).toEqual(snapshot);
      expect(snapshot[4]).toBe('COMPLETED');
      expect(await prisma.saleReturn.count({ where: { saleId: ids.sale } })).toBe(0);
      await expect(
        prisma.saleReturn.create({ data: { companyId: i.companyId, establishmentId: plateau, saleId: ids.sale, sessionId: ids.sessCashier, number: 'TEST-RMB', kind: 'CANCEL', total: 1000n, reason: 'Test', createdById: manager.id } }),
      ).rejects.toThrow(/correction par avoir/);
      // Index unique : une seule facture par ticket, même écrite directement.
      await expect(
        prisma.invoice.create({ data: { companyId: i.companyId, establishmentId: plateau, customerId: ids.cash, source: 'SALE', saleId: ids.sale, total: 1000n, taxTotal: 0n, createdById: manager.id } }),
      ).rejects.toThrow();
      ids.saleInvoice = i.id;
    });
  });

  describe('Avoirs', () => {
    it('établit un avoir partiel AVR sur une facture non payée, plafonné au montant corrigeable', async () => {
      const inv = ids.manualB;
      const line = (await get(inv)).lines[0].id;
      await credit(inv, { lines: [{ invoiceLineId: line, amount: 3000 }] }, cashier).expect(403);
      await credit(inv, { lines: [{ invoiceLineId: line, amount: 3000 }], settlement: { mode: 'CUSTOMER_CREDIT' } }).expect(400); // rien de payé
      const key = randomUUID();
      const cn = (await credit(inv, { clientRequestId: key, lines: [{ invoiceLineId: line, amount: 3000 }] }).expect(201)).body;
      expect((await credit(inv, { clientRequestId: key, lines: [{ invoiceLineId: line, amount: 3000 }] }).expect(201)).body.id).toBe(cn.id);
      expect([cn.number, num(cn.total), num(cn.taxTotal), num(cn.reducedDue), num(cn.customerCredit), num(cn.refundAmount), cn.invoice.id]).toEqual([`PLT-AVR-${year}-000001`, 3000, 458, 3000, 0, 0, inv]);
      const after = await get(inv);
      expect([after.status, num(after.credited), num(after.balance), num(after.correctable), num(after.lines[0].credited)]).toEqual(['ISSUED', 3000, 7000, 7000, 3000]);
      await credit(inv, { lines: [{ invoiceLineId: line, amount: 7001 }] }).expect(409);
      await credit(inv, { lines: [{ invoiceLineId: randomUUID(), amount: 1 }] }).expect(400);
      expect(await prisma.auditLog.count({ where: { action: 'CREDIT_NOTE_ISSUED', entityId: cn.id } })).toBe(1);
      // Deux avoirs simultanés de 5 000 sur 7 000 corrigeables : un seul passe.
      const res = await Promise.all([credit(inv, { lines: [{ invoiceLineId: line, amount: 5000 }] }), credit(inv, { lines: [{ invoiceLineId: line, amount: 5000 }] })]);
      expect(res.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(num((await get(inv)).correctable)).toBe(2000);
    });

    it('annule la facture par un avoir total', async () => {
      const inv = ids.manualC;
      const cn = (await credit(inv, { full: true, reason: 'Prestation annulée' }).expect(201)).body;
      expect([num(cn.total), num(cn.taxTotal)]).toEqual([10000, 1525]); // reliquat exact de TVA
      const after = await get(inv);
      expect([after.status, num(after.balance), num(after.correctable), after.paymentStatus, after.cancelReason]).toEqual(['CANCELLED', 0, 0, null, `Avoir total ${cn.number} : Prestation annulée`]);
      await credit(inv, { full: true }).expect(409);
      await allocate(inv, { paymentId: ids.bigTransfer, amount: 1000 }).expect(409);
      const draft = (await manual(manager, 1000).expect(201)).body.id;
      await credit(draft, { full: true }).expect(409); // brouillon : se modifie
    });

    it('sur une facture payée : crédit client ou remboursement, selon les droits', async () => {
      const inv = ids.orderInvoice; // payée : 20 000 virement + 15 000 acompte + 15 000 virement + 7 000 caisse
      const coca = (await get(inv)).lines[0].id;
      await credit(inv, { lines: [{ invoiceLineId: coca, quantity: 4 }] }).expect(400); // règlement à indiquer
      // Crédit client : la répartition la plus récente (caisse, 7 000) est libérée de 2 000.
      const c1 = (await credit(inv, { lines: [{ invoiceLineId: coca, quantity: 4 }], settlement: { mode: 'CUSTOMER_CREDIT' } }, accountant).expect(201)).body;
      expect([num(c1.total), num(c1.reducedDue), num(c1.customerCredit)]).toEqual([2000, 0, 2000]);
      const cashPay = (await get(inv)).allocations.find((a: { payment: { method: string }; releasedAt: string | null; depositId: string | null }) => a.payment.method === 'CASH' && !a.releasedAt && !a.depositId);
      expect(num((await api(app, accountant, plateau).get(`/api/customer-payments/${cashPay.payment.id}`).expect(200)).body.unallocated)).toBe(2000);
      let after = await get(inv);
      expect([after.paymentStatus, num(after.paid), num(after.credited), num(after.balance)]).toEqual(['PAID', 55000, 2000, 0]);

      // Remboursement : « rembourser » exigé ; par la caisse de celui qui rembourse.
      const refund = { mode: 'REFUND', refund: { method: 'CASH', amount: 5000, sessionId: ids.sessManager } };
      await credit(inv, { lines: [{ invoiceLineId: coca, amount: 1000 }], settlement: refund }, accountant).expect(403);
      await credit(inv, { lines: [{ invoiceLineId: coca, amount: 1000 }], settlement: refund }).expect(400); // montant ≠ part payée à rembourser
      const traiteur = after.lines[1].id;
      const c2 = (await credit(inv, { lines: [{ invoiceLineId: traiteur, amount: 5000 }], settlement: refund, reason: 'Service incomplet' }).expect(201)).body;
      expect([num(c2.refundAmount), c2.refunds.length]).toEqual([5000, 1]);
      const mv = await prisma.cashMovement.findUniqueOrThrow({ where: { id: c2.refunds[0].cashMovementId } });
      expect([mv.type, num(mv.amount), mv.sessionId]).toEqual(['CUSTOMER_REFUND', -5000, ids.sessManager]);
      after = await get(inv);
      expect([after.paymentStatus, num(after.paid), num(after.credited), num(after.balance), num(after.correctable)]).toEqual(['PAID', 50000, 7000, 0, 50000]);
    });

    it('rembourse un ticket facturé par avoir, sans crédit client possible', async () => {
      const inv = ids.saleInvoice;
      await credit(inv, { full: true, settlement: { mode: 'CUSTOMER_CREDIT' } }).expect(409); // payé à la caisse
      const cn = (await credit(inv, { full: true, settlement: { mode: 'REFUND', refund: { method: 'CASH', amount: 1000, sessionId: ids.sessManager } } }).expect(201)).body;
      expect(num(cn.refundAmount)).toBe(1000);
      expect((await get(inv)).status).toBe('CANCELLED');
      // Toujours aucune annulation possible en caisse : pas de double remboursement.
      expect((await api(app, manager, plateau).post(`/api/sales/${ids.sale}/cancel`).send({ reason: 'Encore' })).status).toBe(409);
      expect((await invoice(manager, { source: 'SALE', saleId: ids.sale, customerId: ids.cash })).status).toBe(409); // jamais refacturé
    });

    it('ne touche jamais au stock', async () => {
      expect(await prisma.stockMovement.count()).toBe(num(ids.stockMoves) + 0);
      const o = await prisma.customerOrderLine.findFirstOrThrow({ where: { orderId: ids.order, kind: 'PRODUCT' } });
      expect(num(o.deliveredQuantity)).toBe(0); // la facture ne fait aucune sortie
    });
  });

  describe('Droits, isolation et protections', () => {
    it('limite factures et avoirs à l’établissement et aux droits', async () => {
      await api(app, managerYop, yopougon).get(`/api/invoices/${ids.orderInvoice}`).expect(404);
      expect((await api(app, managerYop, yopougon).get('/api/invoices').expect(200)).body.map((x: { id: string }) => x.id)).toEqual([ids.yopInvoice]);
      await manual(managerYop, 1000, plateau).expect(403);
      await issue(managerYop, ids.manualD, yopougon).expect(404);
      await manual(cashier, 1000).expect(403);
      expect((await api(app, cashier, plateau).get(`/api/invoices/${ids.orderInvoice}`).expect(200)).body.canManage).toBe(false);
      await api(app, waiter, plateau).get(`/api/invoices/${ids.orderInvoice}`).expect(404);
      expect((await api(app, waiter, plateau).get('/api/invoices').expect(200)).body).toHaveLength(0);
      const cn = await prisma.creditNote.findFirstOrThrow();
      await api(app, managerYop, yopougon).get(`/api/credit-notes/${cn.id}`).expect(404);
      // Litige : état enregistré, motif obligatoire.
      await api(app, manager, plateau).post(`/api/invoices/${ids.manualD}/dispute`).send({ reason: '' }).expect(400);
      expect((await api(app, manager, plateau).post(`/api/invoices/${ids.manualD}/dispute`).send({ reason: 'Montant contesté' }).expect(201)).body.status).toBe('DISPUTED');
      expect((await api(app, manager, plateau).post(`/api/invoices/${ids.manualD}/resolve-dispute`).send({ reason: 'Accord trouvé' }).expect(201)).body.status).toBe('ISSUED');
    });

    it('protège avoirs, lignes et répartitions en base', async () => {
      const cn = await prisma.creditNote.findFirstOrThrow({ include: { lines: true } });
      const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: ids.manualD }, include: { lines: true } });
      await expect(prisma.$executeRaw`UPDATE credit_notes SET total = 1 WHERE id = ${cn.id}::uuid`).rejects.toThrow(/ajout seul/i);
      await expect(prisma.$executeRaw`DELETE FROM credit_notes WHERE id = ${cn.id}::uuid`).rejects.toThrow(/ajout seul/i);
      await expect(prisma.$executeRaw`DELETE FROM credit_note_lines WHERE id = ${cn.lines[0].id}::uuid`).rejects.toThrow(/ajout seul/i);
      await expect(prisma.invoiceLine.create({ data: { ...inv.lines[0], id: undefined, position: 9 } })).rejects.toThrow(/lignes figées/);
      // Avoir et répartition au-delà de la facture, écrits directement.
      await expect(
        prisma.creditNote.create({
          data: { companyId: inv.companyId, establishmentId: plateau, customerId: inv.customerId, invoiceId: inv.id, number: 'TEST-AVR', total: 10001n, taxTotal: 0n, reason: 'Test', reducedDue: 10001n, customerCredit: 0n, refundAmount: 0n, createdById: manager.id },
        }),
      ).rejects.toThrow(/Avoir superieur/);
      await expect(prisma.paymentAllocation.create({ data: { paymentId: ids.bigTransfer, target: 'INVOICE', invoiceId: inv.id, amount: 10001n, createdById: manager.id } })).rejects.toThrow(/Repartition superieure/);
    });
  });
});
