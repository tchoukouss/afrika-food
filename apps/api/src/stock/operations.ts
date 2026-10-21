import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AdjustmentDirection, AdjustmentStatus, LossCause } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { attachItems, D, establishmentFor, idempotent, ItemDto, itemOf, loadItem, lockRow, nextNumber, readableEstablishments, userNames } from './common';
import { StockEngine } from './engine';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const emptyToNull = ({ value }: { value: unknown }) => (typeof value === 'string' && value.trim() === '' ? null : typeof value === 'string' ? value.trim() : value);

export class LossDto extends ItemDto {
  /** Identifiant unique du formulaire (anti double envoi). */
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsUUID() establishmentId: string;
  @IsOptional() @IsUUID() locationId?: string;
  /** Lot précis (facultatif) ; sinon FEFO. */
  @IsOptional() @IsUUID() lotId?: string;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(1e9) quantity: number;
  @IsEnum(LossCause) cause: LossCause;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(500) comment?: string | null;
}

export class AdjustmentDto extends ItemDto {
  /** Identifiant unique du formulaire (anti double envoi). */
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsUUID() establishmentId: string;
  @IsOptional() @IsUUID() locationId?: string;
  @IsEnum(AdjustmentDirection) direction: AdjustmentDirection;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(1e9) quantity: number;
  /** Sortie : lot visé (facultatif). */
  @IsOptional() @IsUUID() lotId?: string;
  /** Entrée : coût unitaire du lot créé (proposé automatiquement s'il est absent). */
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(1e12) unitCost?: number;
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

export class DecideDto {
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(500) note?: string | null;
}

export class MoveDto extends ItemDto {
  /** Identifiant unique du formulaire (anti double envoi). */
  @IsOptional() @IsUUID() clientRequestId?: string;
  @IsUUID() establishmentId: string;
  @IsUUID() fromLocationId: string;
  @IsUUID() toLocationId: string;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(1e9) quantity: number;
  @IsOptional() @Transform(emptyToNull) @IsString() @MaxLength(255) reason?: string | null;
}

class OpsQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
  @IsOptional() @IsEnum(AdjustmentStatus) status?: AdjustmentStatus;
  @IsOptional() @IsEnum(LossCause) cause?: LossCause;
}

@Injectable()
export class StockOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: StockEngine,
  ) {}

  private scope(me: AuthUser, requested?: string) {
    const ids = readableEstablishments(me, 'stock.view');
    if (requested && !ids.includes(requested)) throw new BadRequestException('Établissement non accessible');
    return requested ? [requested] : ids;
  }

  // Pertes ------------------------------------------------------------------

  async listLosses(me: AuthUser, q: OpsQuery) {
    const rows = await this.prisma.stockLoss.findMany({
      where: { companyId: me.companyId, establishmentId: { in: this.scope(me, q.establishmentId) }, cause: q.cause },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    const names = await userNames(this.prisma, me.companyId, rows.map((r) => r.declaredById));
    return (await attachItems(this.prisma, rows)).map((r) => ({ ...r, declaredBy: names.get(r.declaredById) ?? null }));
  }

  /** Perte immédiate. Un lot périmé ne sort que par une perte « péremption ». */
  declareLoss(me: AuthUser, dto: LossDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.stockLoss
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((r) => r && { id: r.id, ownerId: r.declaredById }),
      () => this.doDeclareLoss(me, dto),
      (id) => this.prisma.stockLoss.findUniqueOrThrow({ where: { id } }),
    );
  }

  private async doDeclareLoss(me: AuthUser, dto: LossDto) {
    const item = itemOf(dto);
    if (dto.cause === 'TRANSIT') throw new BadRequestException('Les pertes en transit sont enregistrées à la réception du transfert');
    return this.prisma.$transaction(async (tx) => {
      // Pertes : magasin (« Ajuster le stock ») ou production (« Lancer / clôturer une production »).
      const est = await establishmentFor(tx, me, dto.establishmentId, 'stock.view');
      if (!me.access.can('stock.adjust', est.id) && !me.access.can('production.manage', est.id)) {
        throw new ForbiddenException("Vous n'avez pas la permission de déclarer une perte dans cet établissement");
      }
      const info = await loadItem(tx, me.companyId, item);
      const location = await this.engine.resolveLocation(tx, me.companyId, est.id, dto.locationId);
      const number = await nextNumber(tx, me.companyId, 'STOCK_LOSS', est);
      const loss = await tx.stockLoss.create({
        data: {
          companyId: me.companyId,
          establishmentId: est.id,
          locationId: location.id,
          number,
          ...item,
          lotId: dto.lotId ?? null,
          quantity: D(dto.quantity),
          cause: dto.cause,
          comment: dto.comment ?? null,
          estimatedValue: 0n,
          declaredById: me.userId,
          clientRequestId: dto.clientRequestId ?? null,
        },
      });
      const issued = await this.engine.issue(
        tx,
        { companyId: me.companyId, establishmentId: est.id, locationId: location.id, type: 'LOSS', originType: 'StockLoss', originId: loss.id, reason: dto.comment ?? dto.cause, userId: me.userId },
        item,
        D(dto.quantity),
        { lotId: dto.lotId, allowExpired: dto.cause === 'EXPIRED', itemName: info.name },
      );
      const value = BigInt(issued.reduce((s, i) => s.add(i.value), D(0)).toDecimalPlaces(0).toFixed(0));
      const updated = await tx.stockLoss.update({ where: { id: loss.id }, data: { estimatedValue: value, lotId: issued.length === 1 ? issued[0].lotId : loss.lotId } });
      await this.audit.record(
        { action: 'STOCK_LOSS_DECLARED', entityType: 'StockLoss', entityId: loss.id, establishmentId: est.id, reason: dto.comment ?? null, newValues: { number, item: info.name, quantity: dto.quantity, cause: dto.cause, value, lots: issued.map((i) => i.lotNumber) } },
        tx,
      );
      return updated;
    });
  }

  // Corrections (demande puis validation) -----------------------------------------

  async listAdjustments(me: AuthUser, q: OpsQuery) {
    const rows = await this.prisma.stockAdjustment.findMany({
      where: { companyId: me.companyId, establishmentId: { in: this.scope(me, q.establishmentId) }, status: q.status },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    const names = await userNames(this.prisma, me.companyId, rows.flatMap((r) => [r.requestedById, r.decidedById]));
    return (await attachItems(this.prisma, rows)).map((r) => ({
      ...r,
      requestedBy: names.get(r.requestedById) ?? null,
      decidedBy: r.decidedById ? names.get(r.decidedById) ?? null : null,
    }));
  }

  requestAdjustment(me: AuthUser, dto: AdjustmentDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.stockAdjustment
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((r) => r && { id: r.id, ownerId: r.requestedById }),
      () => this.doRequestAdjustment(me, dto),
      (id) => this.prisma.stockAdjustment.findUniqueOrThrow({ where: { id } }),
    );
  }

  private async doRequestAdjustment(me: AuthUser, dto: AdjustmentDto) {
    const item = itemOf(dto);
    return this.prisma.$transaction(async (tx) => {
      const est = await establishmentFor(tx, me, dto.establishmentId, 'stock.adjust');
      await loadItem(tx, me.companyId, item);
      const location = await this.engine.resolveLocation(tx, me.companyId, est.id, dto.locationId);
      if (dto.direction === 'IN' && dto.lotId) throw new BadRequestException('Une correction en entrée crée un nouveau lot');
      if (dto.direction === 'OUT' && dto.unitCost !== undefined) throw new BadRequestException('Le coût ne s’applique qu’aux entrées');
      const unitCost = dto.direction === 'IN' ? (dto.unitCost !== undefined ? D(dto.unitCost) : await this.engine.suggestedUnitCost(tx, me.companyId, item)) : null;
      if (dto.direction === 'IN' && unitCost === null) {
        throw new BadRequestException('Aucun coût connu pour cet article : indiquez le coût unitaire');
      }
      const adj = await tx.stockAdjustment.create({
        data: {
          companyId: me.companyId,
          establishmentId: est.id,
          locationId: location.id,
          number: await nextNumber(tx, me.companyId, 'STOCK_ADJUSTMENT', est),
          ...item,
          direction: dto.direction,
          quantity: D(dto.quantity),
          lotId: dto.lotId ?? null,
          unitCost,
          reason: dto.reason,
          requestedById: me.userId,
          clientRequestId: dto.clientRequestId ?? null,
        },
      });
      await this.audit.record({ action: 'STOCK_ADJUSTMENT_REQUESTED', entityType: 'StockAdjustment', entityId: adj.id, establishmentId: est.id, reason: dto.reason, newValues: { number: adj.number, ...item, direction: dto.direction, quantity: dto.quantity, unitCost } }, tx);
      return adj;
    });
  }

  /** Validation (applique le mouvement) ou refus, par un responsable. */
  async decideAdjustment(me: AuthUser, id: string, approve: boolean, dto: DecideDto) {
    return this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'stock_adjustments', id);
      const adj = await tx.stockAdjustment.findFirst({ where: { id, companyId: me.companyId } });
      if (!adj) throw new NotFoundException('Correction introuvable');
      await establishmentFor(tx, me, adj.establishmentId, 'inventory.validate');
      if (adj.status !== 'PENDING') throw new ConflictException('Cette correction a déjà été traitée');
      const item = { rawMaterialId: adj.rawMaterialId, productId: adj.productId };
      const ctx = {
        companyId: me.companyId,
        establishmentId: adj.establishmentId,
        locationId: adj.locationId,
        originType: 'StockAdjustment',
        originId: adj.id,
        reason: adj.reason,
        userId: me.userId,
      };
      if (approve) {
        if (adj.direction === 'IN') {
          const lot = await this.engine.createLot(tx, { companyId: me.companyId, item, origin: 'ADJUSTMENT', unitCost: D(adj.unitCost ?? 0), userId: me.userId });
          await this.engine.addToLot(tx, { ...ctx, type: 'ADJUSTMENT_IN' }, lot, D(adj.quantity));
        } else {
          // Une correction n'est pas une perte « péremption » : les lots périmés restent bloqués.
          const info = await loadItem(tx, me.companyId, item);
          await this.engine.issue(tx, { ...ctx, type: 'ADJUSTMENT_OUT' }, item, D(adj.quantity), { lotId: adj.lotId, itemName: info.name });
        }
      }
      const updated = await tx.stockAdjustment.update({
        where: { id },
        data: { status: approve ? 'APPROVED' : 'REJECTED', decidedById: me.userId, decidedAt: new Date(), decisionNote: dto.note ?? null },
      });
      await this.audit.record(
        { action: approve ? 'STOCK_ADJUSTMENT_APPROVED' : 'STOCK_ADJUSTMENT_REJECTED', entityType: 'StockAdjustment', entityId: id, establishmentId: adj.establishmentId, reason: dto.note ?? null, newValues: { number: adj.number, direction: adj.direction, quantity: adj.quantity } },
        tx,
      );
      return updated;
    });
  }

  // Déplacements entre emplacements ------------------------------------------------

  async listMoves(me: AuthUser, q: OpsQuery) {
    const rows = await this.prisma.locationMove.findMany({
      where: { companyId: me.companyId, establishmentId: { in: this.scope(me, q.establishmentId) } },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    const locations = await this.prisma.stockLocation.findMany({ where: { id: { in: rows.flatMap((r) => [r.fromLocationId, r.toLocationId]) } }, select: { id: true, name: true } });
    return (await attachItems(this.prisma, rows)).map((r) => ({
      ...r,
      fromLocation: locations.find((l) => l.id === r.fromLocationId)?.name,
      toLocation: locations.find((l) => l.id === r.toLocationId)?.name,
    }));
  }

  /** Déplacement interne : les lots gardent leur identité et leur coût. */
  move(me: AuthUser, dto: MoveDto) {
    return idempotent(
      me,
      dto.clientRequestId,
      () =>
        this.prisma.locationMove
          .findFirst({ where: { companyId: me.companyId, clientRequestId: dto.clientRequestId } })
          .then((r) => r && { id: r.id, ownerId: r.createdById }),
      () => this.doMove(me, dto),
      (id) => this.prisma.locationMove.findUniqueOrThrow({ where: { id } }),
    );
  }

  private async doMove(me: AuthUser, dto: MoveDto) {
    const item = itemOf(dto);
    if (dto.fromLocationId === dto.toLocationId) throw new BadRequestException('Emplacements identiques');
    return this.prisma.$transaction(async (tx) => {
      const est = await establishmentFor(tx, me, dto.establishmentId, 'stock.adjust');
      const info = await loadItem(tx, me.companyId, item);
      const from = await this.engine.resolveLocation(tx, me.companyId, est.id, dto.fromLocationId);
      const to = await this.engine.resolveLocation(tx, me.companyId, est.id, dto.toLocationId);
      const move = await tx.locationMove.create({
        data: {
          companyId: me.companyId,
          establishmentId: est.id,
          number: await nextNumber(tx, me.companyId, 'LOCATION_MOVE', est),
          fromLocationId: from.id,
          toLocationId: to.id,
          ...item,
          quantity: D(dto.quantity),
          reason: dto.reason ?? null,
          createdById: me.userId,
          clientRequestId: dto.clientRequestId ?? null,
        },
      });
      const base = { companyId: me.companyId, establishmentId: est.id, originType: 'LocationMove', originId: move.id, reason: dto.reason ?? null, userId: me.userId };
      const issued = await this.engine.issue(tx, { ...base, locationId: from.id, type: 'LOCATION_OUT' }, item, D(dto.quantity), { itemName: info.name });
      for (const i of issued) {
        const lot = await tx.stockLot.findUniqueOrThrow({ where: { id: i.lotId } });
        await this.engine.addToLot(tx, { ...base, locationId: to.id, type: 'LOCATION_IN' }, lot, i.quantity);
      }
      await this.audit.record({ action: 'STOCK_LOCATION_MOVE', entityType: 'LocationMove', entityId: move.id, establishmentId: est.id, newValues: { number: move.number, item: info.name, quantity: dto.quantity, from: from.name, to: to.name } }, tx);
      return move;
    });
  }
}

@ApiTags('Stock — opérations')
@ApiBearerAuth()
@Controller()
export class StockOperationsController {
  constructor(private readonly service: StockOperationsService) {}

  @Get('stock-losses')
  @RequirePermissions('stock.view')
  @AnyEstablishmentScope()
  listLosses(@CurrentUser() me: AuthUser, @Query() q: OpsQuery) {
    return this.service.listLosses(me, q);
  }

  @Post('stock-losses')
  // « Ajuster le stock » OU « Lancer / clôturer une production » : vérifié par le service.
  @RequirePermissions('stock.view')
  @AnyEstablishmentScope()
  declareLoss(@CurrentUser() me: AuthUser, @Body() dto: LossDto) {
    return this.service.declareLoss(me, dto);
  }

  @Get('stock-adjustments')
  @RequirePermissions('stock.view')
  @AnyEstablishmentScope()
  listAdjustments(@CurrentUser() me: AuthUser, @Query() q: OpsQuery) {
    return this.service.listAdjustments(me, q);
  }

  @Post('stock-adjustments')
  @RequirePermissions('stock.adjust')
  @AnyEstablishmentScope()
  requestAdjustment(@CurrentUser() me: AuthUser, @Body() dto: AdjustmentDto) {
    return this.service.requestAdjustment(me, dto);
  }

  @Post('stock-adjustments/:id/approve')
  @RequirePermissions('inventory.validate')
  @AnyEstablishmentScope()
  approve(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecideDto) {
    return this.service.decideAdjustment(me, id, true, dto);
  }

  @Post('stock-adjustments/:id/reject')
  @RequirePermissions('inventory.validate')
  @AnyEstablishmentScope()
  reject(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DecideDto) {
    return this.service.decideAdjustment(me, id, false, dto);
  }

  @Get('location-moves')
  @RequirePermissions('stock.view')
  @AnyEstablishmentScope()
  listMoves(@CurrentUser() me: AuthUser, @Query() q: OpsQuery) {
    return this.service.listMoves(me, q);
  }

  @Post('location-moves')
  @RequirePermissions('stock.adjust')
  @AnyEstablishmentScope()
  move(@CurrentUser() me: AuthUser, @Body() dto: MoveDto) {
    return this.service.move(me, dto);
  }
}
