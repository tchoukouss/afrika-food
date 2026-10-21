import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma, TransferStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEnum, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { attachItems, D, establishmentFor, idempotent, ItemDto, itemOf, loadItem, lockRow, nextNumber, userNames } from './common';
import { StockEngine } from './engine';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const emptyToNull = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? null : typeof value === 'string' ? value.trim() : value);

export class TransferItemDto extends ItemDto {
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(1e9) quantity: number;
}

export class CreateTransferDto {
  /** Identifiant unique du formulaire (anti double envoi). */
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsUUID() sourceEstablishmentId: string;
  @IsUUID() destEstablishmentId: string;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(1000) notes?: string | null;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => TransferItemDto) items: TransferItemDto[];
}

export class PrepareLineDto {
  @IsUUID() itemId: string;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(1e9) quantity: number;
}

export class PrepareDto {
  @IsOptional() @IsUUID() sourceLocationId?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PrepareLineDto) items: PrepareLineDto[];
}

export class ReceiveLineDto {
  @IsUUID() itemId: string;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(1e9) receivedQuantity: number;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(500) gapReason?: string | null;
}

export class ReceiveDto {
  @IsOptional() @IsUUID() destLocationId?: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ReceiveLineDto) items: ReceiveLineDto[];
}

export class ReasonDto {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

class TransferQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
  @IsOptional() @IsEnum(TransferStatus) status?: TransferStatus;
}

type Side = 'source' | 'dest';

/**
 * Transfert entre établissements :
 * Demande (destination) → Validation (source) → Préparation (source)
 * → Expédition (source, sortie FEFO du stock) → Réception (destination,
 * entrée des mêmes lots ; écart = perte « transit » de la source) → Clôture.
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: StockEngine,
  ) {}

  /** Établissements actifs (code et nom seulement), pour choisir la source d'un transfert. */
  establishments(me: AuthUser) {
    return this.prisma.establishment.findMany({
      where: { companyId: me.companyId, deletedAt: null, isActive: true },
      select: { id: true, code: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  async list(me: AuthUser, q: TransferQuery) {
    const ids = q.establishmentId ? [q.establishmentId] : me.access.establishmentsWith('stock.view');
    if (q.establishmentId && !me.access.can('stock.view', q.establishmentId)) throw new BadRequestException('Établissement non accessible');
    const rows = await this.prisma.stockTransfer.findMany({
      where: { companyId: me.companyId, status: q.status, OR: [{ sourceEstablishmentId: { in: ids } }, { destEstablishmentId: { in: ids } }] },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { _count: { select: { items: true } } },
    });
    return rows;
  }

  async get(me: AuthUser, id: string) {
    const t = await this.prisma.stockTransfer.findFirst({ where: { id, companyId: me.companyId }, include: { items: { include: { lots: true } } } });
    const visible = t && (me.access.can('stock.view', t.sourceEstablishmentId) || me.access.can('stock.view', t.destEstablishmentId));
    if (!t || !visible) throw new NotFoundException('Transfert introuvable');
    const [items, names, lots, losses] = await Promise.all([
      attachItems(this.prisma, t.items),
      userNames(this.prisma, me.companyId, [t.requestedById, t.validatedById, t.preparedById, t.shippedById, t.receivedById, t.closedById, t.cancelledById]),
      this.prisma.stockLot.findMany({ where: { id: { in: t.items.flatMap((i) => i.lots.map((l) => l.lotId)) } }, select: { id: true, lotNumber: true, expiryDate: true } }),
      this.prisma.stockLoss.findMany({ where: { transferId: id } }),
    ]);
    const name = (uid: string | null) => (uid ? names.get(uid) ?? null : null);
    return {
      ...t,
      items: items.map((i) => ({ ...i, lots: i.lots.map((l) => ({ ...l, lotNumber: lots.find((x) => x.id === l.lotId)?.lotNumber, expiryDate: lots.find((x) => x.id === l.lotId)?.expiryDate })) })),
      transitLosses: losses,
      people: {
        requestedBy: name(t.requestedById),
        validatedBy: name(t.validatedById),
        preparedBy: name(t.preparedById),
        shippedBy: name(t.shippedById),
        receivedBy: name(t.receivedById),
        closedBy: name(t.closedById),
        cancelledBy: name(t.cancelledById),
      },
    };
  }

  create(me: AuthUser, dto: CreateTransferDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.stockTransfer
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((r) => r && { id: r.id, ownerId: r.requestedById }),
      () => this.doCreate(me, dto),
      (id) => this.get(me, id),
    );
  }

  private async doCreate(me: AuthUser, dto: CreateTransferDto) {
    if (dto.sourceEstablishmentId === dto.destEstablishmentId) throw new BadRequestException('Source et destination identiques');
    const keys = dto.items.map((i) => i.rawMaterialId ?? i.productId);
    if (new Set(keys).size !== keys.length) throw new BadRequestException('Un article apparaît deux fois');
    const id = await this.prisma.$transaction(async (tx) => {
      // La demande est faite par l'établissement qui a besoin du stock.
      const dest = await establishmentFor(tx, me, dto.destEstablishmentId, 'stock.transfer');
      const source = await tx.establishment.findFirst({ where: { id: dto.sourceEstablishmentId, companyId: me.companyId, deletedAt: null, isActive: true } });
      if (!source) throw new BadRequestException('Établissement source invalide');
      for (const i of dto.items) await loadItem(tx, me.companyId, itemOf(i));
      const t = await tx.stockTransfer.create({
        data: {
          companyId: me.companyId,
          number: await nextNumber(tx, me.companyId, 'TRANSFER', source),
          sourceEstablishmentId: source.id,
          destEstablishmentId: dest.id,
          notes: dto.notes ?? null,
          requestedById: me.userId,
          clientRequestId: dto.clientRequestId ?? null,
          items: { create: dto.items.map((i) => ({ ...itemOf(i), requestedQuantity: D(i.quantity) })) },
        },
      });
      await this.audit.record({ action: 'TRANSFER_REQUESTED', entityType: 'StockTransfer', entityId: t.id, establishmentId: dest.id, newValues: { number: t.number, from: source.code, to: dest.code, items: dto.items } }, tx);
      return t.id;
    });
    return this.get(me, id);
  }

  /** Verrouille le transfert, vérifie son statut et la permission du bon côté. */
  private async step(tx: Tx, me: AuthUser, id: string, expected: TransferStatus[], side: Side) {
    await lockRow(tx, 'stock_transfers', id);
    const t = await tx.stockTransfer.findFirst({ where: { id, companyId: me.companyId }, include: { items: { include: { lots: true } } } });
    if (!t) throw new NotFoundException('Transfert introuvable');
    const estId = side === 'source' ? t.sourceEstablishmentId : t.destEstablishmentId;
    await establishmentFor(tx, me, estId, 'stock.transfer');
    if (!expected.includes(t.status)) throw new ConflictException(`Action impossible : le transfert est au statut ${t.status}`);
    return t;
  }

  async validate(me: AuthUser, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.step(tx, me, id, ['REQUESTED'], 'source');
      // La sortie de stock vers un autre site est autorisée par un responsable de la
      // source, pas par le magasinier qui prépare et expédie.
      if (!me.access.can('inventory.validate', t.sourceEstablishmentId)) {
        throw new ForbiddenException('La validation d’un transfert revient à un responsable de l’établissement source');
      }
      await tx.stockTransfer.update({ where: { id }, data: { status: 'VALIDATED', validatedById: me.userId, validatedAt: new Date() } });
      await this.audit.record({ action: 'TRANSFER_VALIDATED', entityType: 'StockTransfer', entityId: id, establishmentId: t.sourceEstablishmentId }, tx);
    });
    return this.get(me, id);
  }

  /** Préparation : quantités réellement préparées (0 possible) et emplacement de départ. */
  async prepare(me: AuthUser, id: string, dto: PrepareDto) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.step(tx, me, id, ['VALIDATED'], 'source');
      const location = await this.engine.resolveLocation(tx, me.companyId, t.sourceEstablishmentId, dto.sourceLocationId);
      for (const line of t.items) {
        const p = dto.items.find((x) => x.itemId === line.id);
        if (!p) throw new BadRequestException('Indiquez la quantité préparée pour chaque ligne');
        await tx.stockTransferItem.update({ where: { id: line.id }, data: { preparedQuantity: D(p.quantity) } });
      }
      if (dto.items.every((x) => x.quantity === 0)) throw new BadRequestException('Rien n’a été préparé : annulez plutôt le transfert');
      await tx.stockTransfer.update({ where: { id }, data: { status: 'PREPARED', sourceLocationId: location.id, preparedById: me.userId, preparedAt: new Date() } });
      await this.audit.record({ action: 'TRANSFER_PREPARED', entityType: 'StockTransfer', entityId: id, establishmentId: t.sourceEstablishmentId, newValues: { location: location.name, items: dto.items } }, tx);
    });
    return this.get(me, id);
  }

  /** Expédition : le stock quitte la source (FEFO, lots périmés exclus) et passe « en transit ». */
  async ship(me: AuthUser, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.step(tx, me, id, ['PREPARED'], 'source');
      const ctx = { companyId: me.companyId, establishmentId: t.sourceEstablishmentId, locationId: t.sourceLocationId!, type: 'TRANSFER_OUT' as const, originType: 'StockTransfer', originId: t.id, reason: t.number, userId: me.userId };
      for (const line of t.items) {
        const qty = D(line.preparedQuantity ?? 0);
        if (qty.isZero()) {
          await tx.stockTransferItem.update({ where: { id: line.id }, data: { shippedQuantity: D(0) } });
          continue;
        }
        const item = { rawMaterialId: line.rawMaterialId, productId: line.productId };
        const info = await loadItem(tx, me.companyId, item);
        const issued = await this.engine.issue(tx, ctx, item, qty, { itemName: info.name });
        for (const i of issued) {
          await tx.stockTransferLot.create({ data: { transferItemId: line.id, lotId: i.lotId, shippedQuantity: i.quantity, unitCost: i.unitCost } });
        }
        await tx.stockTransferItem.update({ where: { id: line.id }, data: { shippedQuantity: qty } });
      }
      await tx.stockTransfer.update({ where: { id }, data: { status: 'SHIPPED', shippedById: me.userId, shippedAt: new Date() } });
      await this.audit.record({ action: 'TRANSFER_SHIPPED', entityType: 'StockTransfer', entityId: id, establishmentId: t.sourceEstablishmentId }, tx);
    });
    return this.get(me, id);
  }

  /**
   * Réception à destination : les mêmes lots entrent (au même coût). Un manque
   * exige un motif et devient une perte « transit » de l'établissement source.
   */
  async receive(me: AuthUser, id: string, dto: ReceiveDto) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.step(tx, me, id, ['SHIPPED'], 'dest');
      const location = await this.engine.resolveLocation(tx, me.companyId, t.destEstablishmentId, dto.destLocationId);
      const source = await tx.establishment.findUniqueOrThrow({ where: { id: t.sourceEstablishmentId } });
      const ctx = { companyId: me.companyId, establishmentId: t.destEstablishmentId, locationId: location.id, type: 'TRANSFER_IN' as const, originType: 'StockTransfer', originId: t.id, reason: t.number, userId: me.userId };
      for (const line of t.items) {
        const shipped = D(line.shippedQuantity ?? 0);
        if (shipped.isZero()) continue;
        const r = dto.items.find((x) => x.itemId === line.id);
        if (!r) throw new BadRequestException('Indiquez la quantité reçue pour chaque ligne expédiée');
        let received = D(r.receivedQuantity);
        if (received.gt(shipped)) throw new BadRequestException('Quantité reçue supérieure à la quantité expédiée');
        const gap = shipped.sub(received);
        if (gap.gt(0) && !r.gapReason) throw new BadRequestException('Motif obligatoire pour une quantité manquante');

        // Répartition du reçu sur les lots expédiés, dans l'ordre FEFO de l'expédition.
        let lossValue = D(0);
        for (const tl of line.lots) {
          const take = Prisma.Decimal.min(received, tl.shippedQuantity);
          received = received.sub(take);
          if (take.gt(0)) {
            const lot = await tx.stockLot.findUniqueOrThrow({ where: { id: tl.lotId } });
            await this.engine.addToLot(tx, ctx, lot, take);
          }
          lossValue = lossValue.add(D(tl.shippedQuantity).sub(take).mul(tl.unitCost));
          await tx.stockTransferLot.update({ where: { id: tl.id }, data: { receivedQuantity: take } });
        }
        await tx.stockTransferItem.update({ where: { id: line.id }, data: { receivedQuantity: D(r.receivedQuantity), gapReason: r.gapReason ?? null } });

        if (gap.gt(0)) {
          const lostLots = line.lots.filter((tl) => D(tl.shippedQuantity).gt(0));
          await tx.stockLoss.create({
            data: {
              companyId: me.companyId,
              establishmentId: t.sourceEstablishmentId,
              locationId: null,
              number: await nextNumber(tx, me.companyId, 'STOCK_LOSS', source),
              rawMaterialId: line.rawMaterialId,
              productId: line.productId,
              lotId: lostLots.length === 1 ? lostLots[0].lotId : null,
              quantity: gap,
              cause: 'TRANSIT',
              comment: `${t.number} : ${r.gapReason}`,
              estimatedValue: BigInt(lossValue.toDecimalPlaces(0).toFixed(0)),
              transferId: t.id,
              declaredById: me.userId,
            },
          });
        }
      }
      await tx.stockTransfer.update({ where: { id }, data: { status: 'RECEIVED', destLocationId: location.id, receivedById: me.userId, receivedAt: new Date() } });
      await this.audit.record({ action: 'TRANSFER_RECEIVED', entityType: 'StockTransfer', entityId: id, establishmentId: t.destEstablishmentId, newValues: { location: location.name, items: dto.items } }, tx);
    });
    return this.get(me, id);
  }

  async close(me: AuthUser, id: string) {
    await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'stock_transfers', id);
      const t = await tx.stockTransfer.findFirst({ where: { id, companyId: me.companyId } });
      if (!t) throw new NotFoundException('Transfert introuvable');
      if (!me.access.can('stock.transfer', t.sourceEstablishmentId) && !me.access.can('stock.transfer', t.destEstablishmentId)) {
        throw new ForbiddenException("Vous n'avez pas la permission de clôturer ce transfert");
      }
      if (t.status !== 'RECEIVED') throw new ConflictException('Seul un transfert réceptionné peut être clôturé');
      await tx.stockTransfer.update({ where: { id }, data: { status: 'CLOSED', closedById: me.userId, closedAt: new Date() } });
      await this.audit.record({ action: 'TRANSFER_CLOSED', entityType: 'StockTransfer', entityId: id, establishmentId: t.destEstablishmentId }, tx);
    });
    return this.get(me, id);
  }

  /** Annulation possible tant que rien n'a été expédié (par la source ou la destination). */
  async cancel(me: AuthUser, id: string, dto: ReasonDto) {
    await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'stock_transfers', id);
      const t = await tx.stockTransfer.findFirst({ where: { id, companyId: me.companyId } });
      if (!t) throw new NotFoundException('Transfert introuvable');
      if (!me.access.can('stock.transfer', t.sourceEstablishmentId) && !me.access.can('stock.transfer', t.destEstablishmentId)) {
        throw new ForbiddenException("Vous n'avez pas la permission d'annuler ce transfert");
      }
      if (!['REQUESTED', 'VALIDATED', 'PREPARED'].includes(t.status)) throw new ConflictException('Un transfert expédié ne peut plus être annulé');
      await tx.stockTransfer.update({ where: { id }, data: { status: 'CANCELLED', cancelledById: me.userId, cancelledAt: new Date(), cancelReason: dto.reason } });
      await this.audit.record({ action: 'TRANSFER_CANCELLED', entityType: 'StockTransfer', entityId: id, establishmentId: t.sourceEstablishmentId, reason: dto.reason }, tx);
    });
    return this.get(me, id);
  }
}

@ApiTags('Transferts')
@ApiBearerAuth()
@Controller('stock-transfers')
export class TransfersController {
  constructor(private readonly service: TransfersService) {}

  @Get()
  @RequirePermissions('stock.view')
  @AnyEstablishmentScope()
  list(@CurrentUser() me: AuthUser, @Query() q: TransferQuery) {
    return this.service.list(me, q);
  }

  @Get('establishments')
  @RequirePermissions('stock.transfer')
  @AnyEstablishmentScope()
  establishments(@CurrentUser() me: AuthUser) {
    return this.service.establishments(me);
  }

  @Get(':id')
  @RequirePermissions('stock.view')
  @AnyEstablishmentScope()
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(me, id);
  }

  @Post()
  @RequirePermissions('stock.transfer')
  @AnyEstablishmentScope()
  create(@CurrentUser() me: AuthUser, @Body() dto: CreateTransferDto) {
    return this.service.create(me, dto);
  }

  @Post(':id/validate')
  @RequirePermissions('stock.transfer')
  @AnyEstablishmentScope()
  validate(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.validate(me, id);
  }

  @Post(':id/prepare')
  @RequirePermissions('stock.transfer')
  @AnyEstablishmentScope()
  prepare(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PrepareDto) {
    return this.service.prepare(me, id, dto);
  }

  @Post(':id/ship')
  @RequirePermissions('stock.transfer')
  @AnyEstablishmentScope()
  ship(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.ship(me, id);
  }

  @Post(':id/receive')
  @RequirePermissions('stock.transfer')
  @AnyEstablishmentScope()
  receive(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReceiveDto) {
    return this.service.receive(me, id, dto);
  }

  @Post(':id/close')
  @RequirePermissions('stock.transfer')
  @AnyEstablishmentScope()
  close(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.close(me, id);
  }

  @Post(':id/cancel')
  @RequirePermissions('stock.transfer')
  @AnyEstablishmentScope()
  cancel(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.service.cancel(me, id, dto);
  }
}
