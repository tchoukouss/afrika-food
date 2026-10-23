import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Injectable,
  NotFoundException,
  OnModuleInit,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { PaymentDto, PresetSaleLine, SalesService } from '../sales/sales';
import { D, idempotent } from '../stock/common';
import { assertAny, emptyToNull, lockOrders, nextRestaurantNumber, trim } from './common';
import { isBillable, itemAmount, OrdersService } from './orders';
import { RestaurantPrinting } from './printing';

export class CreateBillDto {
  @IsOptional() @IsUUID() clientRequestId?: string;
  /** Articles de l'addition (séparation par articles) ; par défaut, tout ce qui reste à payer. */
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID('all', { each: true }) itemIds?: string[];
}

export class PrintBillDto {
  /** Caisse dont l'imprimante réseau imprime la note ; sinon impression par le navigateur. */
  @IsOptional() @IsUUID() registerId?: string;
}

export class CancelBillDto {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class BillLineDiscountDto {
  @IsUUID() itemId: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(100) discountPercent?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000_000) discountAmount?: number;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(500) discountReason?: string | null;
}

export class PayBillDto {
  @IsOptional() @IsUUID() clientRequestId?: string;
  /** Session de caisse ouverte de celui qui encaisse (décision R20). */
  @IsUUID() sessionId: string;
  @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => PaymentDto) payments: PaymentDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => BillLineDiscountDto) discounts?: BillLineDiscountDto[];
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(100) ticketDiscountPercent?: number;
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000_000) ticketDiscountAmount?: number;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(500) ticketDiscountReason?: string | null;
}

@Injectable()
export class BillsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sales: SalesService,
    private readonly orders: OrdersService,
    private readonly printing: RestaurantPrinting,
  ) {}

  /** Liaison avec la caisse (décisions R26 et R27). */
  onModuleInit() {
    this.sales.registerTicketReference((saleId) => this.ticketReference(saleId));
    this.sales.registerCancelHook((tx, me, sale) => this.onSaleCancelled(tx, me, sale.id, sale.number));
  }

  private async ticketReference(saleId: string) {
    const bill = await this.prisma.restaurantBill.findUnique({ where: { saleId }, include: { order: true } });
    if (!bill) return null;
    const table = bill.order.tableId ? await this.prisma.restaurantTable.findUnique({ where: { id: bill.order.tableId } }) : null;
    return `Commande ${bill.order.number}${table ? ` — Table ${table.code}` : ''}`;
  }

  private async findBill(me: AuthUser, id: string) {
    const bill = await this.prisma.restaurantBill.findFirst({ where: { id, companyId: me.companyId } });
    if (!bill) throw new NotFoundException('Addition introuvable');
    return bill;
  }

  // --- Préparation de l'addition ---------------------------------------------------------

  /** Addition de tout le reste à payer, ou d'une sélection d'articles (décision R17). */
  create(me: AuthUser, orderId: string, dto: CreateBillDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.restaurantBill
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((b) => b && { id: b.orderId, ownerId: b.createdById }),
      () => this.doCreate(me, orderId, dto),
      (id) => this.orders.get(me, id),
    );
  }

  private async doCreate(me: AuthUser, orderId: string, dto: CreateBillDto) {
    await this.prisma.$transaction(async (tx) => {
      await lockOrders(tx, [orderId]);
      const order = await tx.restaurantOrder.findFirst({ where: { id: orderId, companyId: me.companyId } });
      if (!order) throw new NotFoundException('Commande introuvable');
      assertAny(me, order.establishmentId, 'restaurant.orders');
      if (order.status !== 'OPEN') throw new ConflictException(`Commande ${order.number} non ouverte`);
      const open = (await tx.restaurantOrderItem.findMany({ where: { orderId }, orderBy: { position: 'asc' } })).filter((i) => isBillable(i) && !i.billId);
      let chosen = open;
      if (dto.itemIds?.length) {
        const ids = new Set(dto.itemIds);
        if (dto.itemIds.some((x) => !open.some((i) => i.id === x))) throw new BadRequestException('Article non envoyé, annulé ou déjà sur une addition');
        open.filter((i) => i.parentItemId && ids.has(i.parentItemId)).forEach((i) => ids.add(i.id)); // les suppléments suivent leur article
        chosen = open.filter((i) => ids.has(i.id));
      }
      if (!chosen.length) throw new BadRequestException('Rien à facturer : envoyez d’abord les articles en cuisine');
      const est = await tx.establishment.findUniqueOrThrow({ where: { id: order.establishmentId } });
      const lines = chosen.map((i) => ({ itemId: i.id, quantity: D(i.quantity).sub(i.cancelledQuantity), unitPrice: i.unitPrice, amount: itemAmount(i) }));
      const bill = await tx.restaurantBill.create({
        data: {
          companyId: me.companyId,
          establishmentId: est.id,
          orderId,
          number: await nextRestaurantNumber(tx, me.companyId, 'BILL', est),
          clientRequestId: dto.clientRequestId ?? null,
          total: lines.reduce((s, l) => s + l.amount, 0n),
          createdById: me.userId,
          items: { create: lines },
        },
      });
      await tx.restaurantOrderItem.updateMany({ where: { id: { in: chosen.map((i) => i.id) } }, data: { billId: bill.id } });
      await this.audit.record(
        { action: 'RESTAURANT_BILL_CREATED', entityType: 'RestaurantBill', entityId: bill.id, establishmentId: est.id, newValues: { number: bill.number, order: order.number, total: bill.total, items: lines.length } },
        tx,
      );
    });
    return this.orders.get(me, orderId);
  }

  /** Note provisoire : « ceci n'est pas un ticket de caisse » ; chaque impression est tracée. */
  async print(me: AuthUser, id: string, dto: PrintBillDto) {
    const bill = await this.findBill(me, id);
    assertAny(me, bill.establishmentId, 'restaurant.orders');
    if (bill.status !== 'OPEN') throw new ConflictException('Seule une addition non payée s’imprime (le ticket de caisse est imprimé au paiement)');
    const register = dto.registerId ? await this.prisma.cashRegister.findFirst({ where: { id: dto.registerId, establishmentId: bill.establishmentId } }) : null;
    if (dto.registerId && !register) throw new BadRequestException('Caisse invalide pour cet établissement');
    const job = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM restaurant_bills WHERE id = ${id}::uuid FOR UPDATE`;
      const j = (await this.printing.createJob(
        tx,
        me,
        { establishmentId: bill.establishmentId, kind: 'BILL', billId: id, registerId: register?.id ?? null },
        register ?? { printerType: 'BROWSER', printerHost: null, printerPort: 9100, paperWidth: 80 },
        true,
      ))!;
      const b = await tx.restaurantBill.update({ where: { id }, data: { printCount: { increment: 1 } } });
      await this.audit.record({ action: 'RESTAURANT_BILL_PRINTED', entityType: 'RestaurantBill', entityId: id, establishmentId: bill.establishmentId, newValues: { number: bill.number, printCount: b.printCount } }, tx);
      return j;
    });
    const print = job.status === 'PENDING' ? await this.printing.deliver(job.id) : job;
    return { print, ...(await this.printing.lines(job)) };
  }

  /** Annule une addition non payée : ses articles redeviennent à payer (rien n'est supprimé). */
  async cancel(me: AuthUser, id: string, dto: CancelBillDto) {
    const bill = await this.findBill(me, id);
    await this.prisma.$transaction(async (tx) => {
      await lockOrders(tx, [bill.orderId]);
      await tx.$queryRaw`SELECT id FROM restaurant_bills WHERE id = ${id}::uuid FOR UPDATE`;
      const b = await tx.restaurantBill.findUniqueOrThrow({ where: { id } });
      assertAny(me, b.establishmentId, 'restaurant.orders');
      if (b.status !== 'OPEN') throw new ConflictException(b.status === 'PAID' ? 'Addition payée : l’annulation se fait sur le ticket, à la caisse' : 'Addition déjà annulée');
      await tx.restaurantBill.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: me.userId, cancelReason: dto.reason } });
      await tx.restaurantOrderItem.updateMany({ where: { billId: id }, data: { billId: null } });
      await this.audit.record({ action: 'RESTAURANT_BILL_CANCELLED', entityType: 'RestaurantBill', entityId: id, establishmentId: b.establishmentId, newValues: { number: b.number }, reason: dto.reason }, tx);
    });
    return this.orders.get(me, bill.orderId);
  }

  // --- Encaissement par le module 5 --------------------------------------------------------

  /**
   * Encaisse l'addition entière (décision R18) par le circuit de la caisse :
   * plusieurs paiements possibles sur le même ticket (décision R17), remises
   * avec droit et motif, ticket portant le numéro de commande. Aucune nouvelle
   * sortie de stock : le coût réel des lots consommés à l'envoi est repris.
   */
  async pay(me: AuthUser, id: string, dto: PayBillDto) {
    const bill = await this.prisma.restaurantBill.findFirst({ where: { id, companyId: me.companyId }, include: { items: true, order: true } });
    if (!bill) throw new NotFoundException('Addition introuvable');
    const session = await this.prisma.cashSession.findFirst({ where: { id: dto.sessionId, companyId: me.companyId } });
    if (!session) throw new NotFoundException('Session de caisse introuvable');
    if (session.establishmentId !== bill.establishmentId) throw new BadRequestException('La session de caisse doit être dans l’établissement de la commande');
    if (bill.status !== 'OPEN') {
      // Renvoi d'un paiement déjà enregistré (double clic, coupure réseau) : rejoué par la caisse.
      const replay = bill.saleId && dto.clientRequestId ? await this.prisma.sale.findFirst({ where: { id: bill.saleId, clientRequestId: dto.clientRequestId } }) : null;
      if (!replay) throw new ConflictException(bill.status === 'PAID' ? `Addition ${bill.number} déjà payée` : `Addition ${bill.number} annulée`);
    }
    const items = await this.prisma.restaurantOrderItem.findMany({ where: { id: { in: bill.items.map((i) => i.itemId) } } });
    const table = bill.order.tableId ? await this.prisma.restaurantTable.findUnique({ where: { id: bill.order.tableId } }) : null;
    const discounts = new Map((dto.discounts ?? []).map((d) => [d.itemId, d]));
    if ([...discounts.keys()].some((k) => !bill.items.some((bi) => bi.itemId === k))) throw new BadRequestException('Remise sur un article absent de l’addition');
    const lines: PresetSaleLine[] = bill.items.map((bi) => {
      const it = items.find((i) => i.id === bi.itemId)!;
      const d = discounts.get(it.id);
      return {
        productId: it.productId,
        productCode: it.productCode,
        productName: it.productName,
        isMenu: it.isMenu,
        quantity: D(bi.quantity),
        unitPrice: bi.unitPrice,
        taxRate: D(it.taxRate),
        costTotal: D(it.costTotal),
        discountPercent: d?.discountPercent,
        discountAmount: d?.discountAmount,
        discountReason: d?.discountReason ?? null,
      };
    });
    const result = await this.sales.createPresetSale(me, {
      sessionId: dto.sessionId,
      clientRequestId: dto.clientRequestId,
      lines,
      ticketDiscountPercent: dto.ticketDiscountPercent,
      ticketDiscountAmount: dto.ticketDiscountAmount,
      ticketDiscountReason: dto.ticketDiscountReason,
      payments: dto.payments,
      reference: `Commande ${bill.order.number}${table ? ` — Table ${table.code}` : ''}`,
      inTransaction: (tx, saleId) => this.markPaid(tx, me, id, saleId),
    });
    return { ...(result as object), order: await this.orders.get(me, bill.orderId) };
  }

  /** Dans la transaction de la vente : l'addition passe payée ; commande soldée si tout est payé. */
  private async markPaid(tx: Tx, me: AuthUser, billId: string, saleId: string) {
    const bill = await tx.restaurantBill.findUniqueOrThrow({ where: { id: billId } });
    await lockOrders(tx, [bill.orderId]);
    await tx.$queryRaw`SELECT id FROM restaurant_bills WHERE id = ${billId}::uuid FOR UPDATE`;
    const b = await tx.restaurantBill.findUniqueOrThrow({ where: { id: billId } });
    if (b.status !== 'OPEN') throw new ConflictException(`Addition ${b.number} déjà payée ou annulée`);
    const now = new Date();
    await tx.restaurantBill.update({ where: { id: billId }, data: { status: 'PAID', saleId, paidAt: now } });
    await this.audit.record({ action: 'RESTAURANT_BILL_PAID', entityType: 'RestaurantBill', entityId: billId, establishmentId: b.establishmentId, newValues: { number: b.number, saleId, total: b.total } }, tx);

    const order = await tx.restaurantOrder.findUniqueOrThrow({ where: { id: b.orderId } });
    const items = await tx.restaurantOrderItem.findMany({ where: { orderId: order.id } });
    const paid = new Set((await tx.restaurantBill.findMany({ where: { orderId: order.id, status: 'PAID' } })).map((x) => x.id));
    const complete = !items.some((i) => i.status === 'DRAFT') && items.filter(isBillable).every((i) => i.billId && paid.has(i.billId));
    if (order.status === 'OPEN' && complete) {
      await tx.restaurantOrder.update({ where: { id: order.id }, data: { status: 'PAID', paidAt: now } });
      // Table à nettoyer après paiement complet (décision R8).
      if (order.tableId) await tx.restaurantTable.update({ where: { id: order.tableId }, data: { state: 'CLEANING' } });
      await this.audit.record({ action: 'RESTAURANT_ORDER_PAID', entityType: 'RestaurantOrder', entityId: order.id, establishmentId: order.establishmentId, newValues: { number: order.number } }, tx);
    }
  }

  /**
   * Ticket annulé à la caisse (décision R27) : l'addition est annulée, ses
   * articles redeviennent à payer et la commande se rouvre. Le stock ne bouge
   * pas (les plats ont été servis).
   */
  private async onSaleCancelled(tx: Tx, me: AuthUser, saleId: string, saleNumber: string) {
    const found = await tx.restaurantBill.findUnique({ where: { saleId } });
    if (!found) return;
    await lockOrders(tx, [found.orderId]);
    const bill = await tx.restaurantBill.findUniqueOrThrow({ where: { id: found.id } });
    const order = await tx.restaurantOrder.findUniqueOrThrow({ where: { id: bill.orderId } });
    if (order.status === 'PAID' && order.tableId && (await tx.restaurantOrder.findFirst({ where: { tableId: order.tableId, status: 'OPEN' } }))) {
      throw new ConflictException(`La table de la commande ${order.number} est occupée par une autre commande : transférez celle-ci avant d’annuler le ticket`);
    }
    await tx.restaurantBill.update({ where: { id: bill.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: me.userId, cancelReason: `Ticket ${saleNumber} annulé` } });
    await tx.restaurantOrderItem.updateMany({ where: { billId: bill.id }, data: { billId: null } });
    if (order.status === 'PAID') {
      await tx.restaurantOrder.update({ where: { id: order.id }, data: { status: 'OPEN', paidAt: null } });
      if (order.tableId) await tx.restaurantTable.updateMany({ where: { id: order.tableId, state: 'CLEANING' }, data: { state: 'AVAILABLE' } });
    }
    await this.audit.record(
      { action: 'RESTAURANT_BILL_REOPENED', entityType: 'RestaurantBill', entityId: bill.id, establishmentId: bill.establishmentId, newValues: { number: bill.number, order: order.number, sale: saleNumber } },
      tx,
    );
  }
}

@ApiTags('Restaurant')
@ApiBearerAuth()
@Controller('restaurant')
export class BillsController {
  constructor(private readonly service: BillsService) {}

  @Post('orders/:id/bills')
  @RequirePermissions('restaurant.orders')
  @AnyEstablishmentScope()
  create(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateBillDto) {
    return this.service.create(me, id, dto);
  }

  @Post('bills/:id/print')
  @RequirePermissions('restaurant.orders')
  @AnyEstablishmentScope()
  print(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PrintBillDto) {
    return this.service.print(me, id, dto);
  }

  @Post('bills/:id/cancel')
  @RequirePermissions('restaurant.orders')
  @AnyEstablishmentScope()
  cancel(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelBillDto) {
    return this.service.cancel(me, id, dto);
  }

  // Encaissement : « Créer une vente » et session de caisse ouverte, contrôlés par le module 5.
  @Post('bills/:id/pay')
  @RequirePermissions('sales.create')
  @AnyEstablishmentScope()
  pay(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PayBillDto) {
    return this.service.pay(me, id, dto);
  }
}
