import { Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { AuthUser, CurrentUser } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { ProductionService } from '../production/production';
import { attachItems, D } from '../stock/common';
import { readableWith, trim } from './common';
import { assertOrderAccess } from './orders';

class LotNumberQuery {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(40) lotNumber: string;
}

/**
 * Traçabilité du restaurant (décision R28) : commande → articles → lots
 * consommés → production → matières premières et fournisseurs (traçabilité du
 * module 4 réutilisée), et lot → produits finis → commandes et tickets.
 */
@Injectable()
export class RestaurantTraceability {
  constructor(
    private readonly prisma: PrismaService,
    private readonly production: ProductionService,
  ) {}

  async order(me: AuthUser, id: string) {
    const order = await this.prisma.restaurantOrder.findFirst({ where: { id, companyId: me.companyId } });
    if (!order) throw new NotFoundException('Commande introuvable');
    assertOrderAccess(me, order);
    const canTrace = me.access.global.has('stock.view') || me.access.can('stock.view', order.establishmentId);
    const items = await this.prisma.restaurantOrderItem.findMany({ where: { orderId: id, sentAt: { not: null } }, include: { consumptions: true }, orderBy: { position: 'asc' } });
    const lotIds = [...new Set(items.flatMap((i) => i.consumptions.map((c) => c.lotId)))];
    const lots = await this.prisma.stockLot.findMany({ where: { id: { in: lotIds } }, select: { id: true, lotNumber: true, expiryDate: true, origin: true } });
    const upstream = new Map<string, unknown>();
    if (canTrace) for (const lotId of lotIds) upstream.set(lotId, (await this.production.trace(me, lotId)).upstream);
    const result = [];
    for (const i of items) {
      const consumed = await attachItems(this.prisma, i.consumptions.filter((c) => c.kind === 'CONSUMED'));
      result.push({
        id: i.id,
        productName: i.productName,
        quantity: i.quantity,
        cancelledQuantity: i.cancelledQuantity,
        status: i.status,
        preparation: i.preparation,
        costTotal: i.costTotal,
        lots: consumed.map((c) => ({
          id: c.id,
          lotId: c.lotId,
          lotNumber: lots.find((l) => l.id === c.lotId)?.lotNumber ?? null,
          item: c.item,
          quantity: c.quantity,
          returned: i.consumptions.filter((x) => x.lotId === c.lotId && x.kind === 'RETURNED').reduce((s, x) => s.add(x.quantity), D(0)),
          lost: i.consumptions.filter((x) => x.lotId === c.lotId && x.kind === 'LOST').reduce((s, x) => s.add(x.quantity), D(0)),
          value: c.value,
          upstream: upstream.get(c.lotId) ?? null,
        })),
      });
    }
    return { order: { id: order.id, number: order.number, status: order.status }, canTrace, items: result };
  }

  /** Lot → lots fabriqués avec lui (récursivement) → commandes qui les ont consommés → tickets. */
  async lotOrders(me: AuthUser, lotId: string) {
    const root = await this.prisma.stockLot.findFirst({ where: { id: lotId, companyId: me.companyId } });
    if (!root) throw new NotFoundException('Lot introuvable');
    const readable = readableWith(me, ['stock.view', 'restaurant.orders']);
    if (!readable.length) throw new ForbiddenException('Accès refusé');

    const chain = new Map<string, { via: string | null; depth: number }>([[lotId, { via: null, depth: 0 }]]);
    let frontier = [lotId];
    for (let depth = 1; depth <= 6 && frontier.length; depth++) {
      const uses = await this.prisma.productionConsumption.findMany({ where: { lotId: { in: frontier }, quantity: { gt: 0 } }, select: { orderId: true } });
      const outputs = await this.prisma.productionOutput.findMany({ where: { orderId: { in: [...new Set(uses.map((u) => u.orderId))] } }, include: { order: { select: { number: true } } } });
      frontier = [];
      for (const o of outputs) {
        if (chain.has(o.lotId)) continue;
        chain.set(o.lotId, { via: o.order.number, depth });
        frontier.push(o.lotId);
      }
    }
    const lotIds = [...chain.keys()];
    const [lots, consumptions] = await Promise.all([
      attachItems(this.prisma, await this.prisma.stockLot.findMany({ where: { id: { in: lotIds } }, select: { id: true, lotNumber: true, rawMaterialId: true, productId: true, expiryDate: true } })),
      this.prisma.restaurantConsumption.findMany({
        where: { lotId: { in: lotIds }, kind: 'CONSUMED', item: { order: { companyId: me.companyId, establishmentId: { in: readable } } } },
        include: { item: { include: { order: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const billIds = [...new Set(consumptions.map((c) => c.item.billId).filter((x): x is string => !!x))];
    const bills = await this.prisma.restaurantBill.findMany({ where: { id: { in: billIds } }, select: { id: true, number: true, status: true, saleId: true } });
    const sales = await this.prisma.sale.findMany({ where: { id: { in: bills.map((b) => b.saleId).filter((x): x is string => !!x) } }, select: { id: true, number: true, status: true } });
    return {
      lot: { id: root.id, lotNumber: root.lotNumber },
      lots: lots.map((l) => ({ id: l.id, lotNumber: l.lotNumber, item: l.item, via: chain.get(l.id)!.via, depth: chain.get(l.id)!.depth })).sort((a, b) => a.depth - b.depth),
      orders: consumptions.map((c) => {
        const bill = bills.find((b) => b.id === c.item.billId) ?? null;
        return {
          orderId: c.item.order.id,
          orderNumber: c.item.order.number,
          orderStatus: c.item.order.status,
          createdAt: c.createdAt,
          lotNumber: lots.find((l) => l.id === c.lotId)?.lotNumber ?? null,
          product: c.item.productName,
          itemStatus: c.item.status,
          quantity: c.quantity,
          bill: bill && { number: bill.number, status: bill.status },
          sale: (bill && sales.find((s) => s.id === bill.saleId)) ?? null,
        };
      }),
    };
  }

  async lotOrdersByNumber(me: AuthUser, lotNumber: string) {
    const lot = await this.prisma.stockLot.findFirst({ where: { companyId: me.companyId, lotNumber: lotNumber.trim().toUpperCase() } });
    if (!lot) throw new NotFoundException('Lot introuvable');
    return this.lotOrders(me, lot.id);
  }
}

@ApiTags('Restaurant')
@ApiBearerAuth()
@Controller('restaurant')
export class TraceabilityController {
  constructor(private readonly service: RestaurantTraceability) {}

  @Get('orders/:id/trace')
  order(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.order(me, id);
  }

  @Get('traceability/lots/:id')
  lot(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.lotOrders(me, id);
  }

  @Get('traceability')
  byNumber(@CurrentUser() me: AuthUser, @Query() q: LotNumberQuery) {
    return this.service.lotOrdersByNumber(me, q.lotNumber);
  }
}
