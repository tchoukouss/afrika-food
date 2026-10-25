import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PrinterType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AuditService, diff } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { StockEngine } from '../stock/engine';
import { assertCan, emptyToNull, establishmentsWithAny, loadEstablishment, trim, uniqueViolation } from './common';
import { columnsFor, escPos, NetworkPrinter, renderTicket } from './printer';

/** Adresse IPv4 d'un réseau local (imprimante de la boutique) : jamais une adresse Internet. */
const PRIVATE_IPV4 = /^(10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|127(\.\d{1,3}){3})$/;

export class CreateRegisterDto {
  @IsUUID() establishmentId: string;
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z0-9-]{1,12}$/, { message: 'Code : 1 à 12 caractères (lettres, chiffres, tiret)' })
  code: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(60) name: string;
  /** Emplacement de stock des ventes (par défaut : Magasin principal). */
  @IsOptional() @IsUUID() stockLocationId?: string;
  @IsOptional() @IsEnum(PrinterType) printerType?: PrinterType;
  @IsOptional() @Transform(emptyToNull) @Matches(PRIVATE_IPV4, { message: 'Adresse IP de l’imprimante : réseau local uniquement (ex. 192.168.1.50)' })
  printerHost?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(65535) printerPort?: number;
  @IsOptional() @IsIn([58, 80]) paperWidth?: number;
  @IsOptional() @IsBoolean() autoPrint?: boolean;
}

export class UpdateRegisterDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(60) name?: string;
  @IsOptional() @IsUUID() stockLocationId?: string;
  @IsOptional() @IsEnum(PrinterType) printerType?: PrinterType;
  @IsOptional() @Transform(emptyToNull) @Matches(PRIVATE_IPV4, { message: 'Adresse IP de l’imprimante : réseau local uniquement (ex. 192.168.1.50)' })
  printerHost?: string | null;
  @IsOptional() @IsInt() @Min(1) @Max(65535) printerPort?: number;
  @IsOptional() @IsIn([58, 80]) paperWidth?: number;
  @IsOptional() @IsBoolean() autoPrint?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class RegisterQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
}

/** Droits de configuration d'une caisse : responsable de l'établissement (décision 17). */
export const REGISTER_ADMIN = ['cash.view_all', 'cash.movements'];

@Injectable()
export class RegistersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: StockEngine,
    private readonly printer: NetworkPrinter,
  ) {}

  async list(me: AuthUser, q: RegisterQuery) {
    const ids = establishmentsWithAny(me, ['cash.operate', 'cash.view_all'], q.establishmentId);
    const rows = await this.prisma.cashRegister.findMany({
      where: { companyId: me.companyId, establishmentId: { in: ids } },
      orderBy: [{ establishmentId: 'asc' }, { code: 'asc' }],
      include: { sessions: { where: { status: 'OPEN' }, select: { id: true, number: true, cashierId: true, openedAt: true } } },
    });
    const [locations, users, ests] = await Promise.all([
      this.prisma.stockLocation.findMany({ where: { id: { in: rows.map((r) => r.stockLocationId) } }, select: { id: true, name: true } }),
      this.prisma.user.findMany({ where: { id: { in: rows.flatMap((r) => r.sessions.map((s) => s.cashierId)) } }, select: { id: true, fullName: true } }),
      this.prisma.establishment.findMany({ where: { id: { in: rows.map((r) => r.establishmentId) } }, select: { id: true, code: true, name: true } }),
    ]);
    return rows.map(({ sessions, ...r }) => ({
      ...r,
      establishment: ests.find((e) => e.id === r.establishmentId) ?? null,
      stockLocation: locations.find((l) => l.id === r.stockLocationId) ?? null,
      openSession: sessions[0] ? { ...sessions[0], cashier: users.find((u) => u.id === sessions[0].cashierId)?.fullName ?? null } : null,
      canManage: REGISTER_ADMIN.every((p) => me.access.can(p, r.establishmentId)),
    }));
  }

  private checkPrinter(type: PrinterType, host: string | null | undefined) {
    if (type === 'NETWORK' && !host) throw new BadRequestException('Adresse IP obligatoire pour une imprimante réseau');
  }

  async create(me: AuthUser, dto: CreateRegisterDto) {
    assertCan(me, dto.establishmentId, ...REGISTER_ADMIN);
    const printerType = dto.printerType ?? 'BROWSER';
    this.checkPrinter(printerType, dto.printerHost);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const est = await loadEstablishment(tx, me, dto.establishmentId);
        const location = await this.engine.resolveLocation(tx, me.companyId, est.id, dto.stockLocationId);
        const reg = await tx.cashRegister.create({
          data: {
            companyId: me.companyId,
            establishmentId: est.id,
            code: dto.code,
            name: dto.name,
            stockLocationId: location.id,
            printerType,
            printerHost: dto.printerHost ?? null,
            printerPort: dto.printerPort ?? 9100,
            paperWidth: dto.paperWidth ?? 80,
            autoPrint: dto.autoPrint ?? true,
          },
        });
        await this.audit.record({ action: 'CASH_REGISTER_CREATED', entityType: 'CashRegister', entityId: reg.id, establishmentId: est.id, newValues: reg }, tx);
        return reg;
      });
    } catch (e) {
      if (uniqueViolation(e, 'code')) throw new ConflictException(`Le code de caisse « ${dto.code} » existe déjà dans cet établissement`);
      throw e;
    }
  }

  private async find(me: AuthUser, id: string) {
    const reg = await this.prisma.cashRegister.findFirst({ where: { id, companyId: me.companyId } });
    if (!reg) throw new NotFoundException('Caisse introuvable');
    return reg;
  }

  async update(me: AuthUser, id: string, dto: UpdateRegisterDto) {
    const reg = await this.find(me, id);
    assertCan(me, reg.establishmentId, ...REGISTER_ADMIN);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM cash_registers WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.cashRegister.findUniqueOrThrow({ where: { id } });
      const open = await tx.cashSession.count({ where: { registerId: id, status: 'OPEN' } });
      if (open && (dto.isActive === false || (dto.stockLocationId && dto.stockLocationId !== current.stockLocationId))) {
        throw new ConflictException('Une session est ouverte sur cette caisse : clôturez-la avant de la désactiver ou de changer son emplacement de stock');
      }
      const data = { ...dto };
      if (dto.stockLocationId) data.stockLocationId = (await this.engine.resolveLocation(tx, me.companyId, current.establishmentId, dto.stockLocationId)).id;
      this.checkPrinter(dto.printerType ?? current.printerType, dto.printerHost === undefined ? current.printerHost : dto.printerHost);
      const { oldValues, newValues, changed } = diff(current as unknown as Record<string, unknown>, data);
      if (!changed) return current;
      const updated = await tx.cashRegister.update({ where: { id }, data });
      await this.audit.record({ action: 'CASH_REGISTER_UPDATED', entityType: 'CashRegister', entityId: id, establishmentId: current.establishmentId, oldValues, newValues }, tx);
      return updated;
    });
  }

  /** Ticket de test envoyé à l'imprimante réseau de la caisse. */
  async testPrint(me: AuthUser, id: string) {
    const reg = await this.find(me, id);
    assertCan(me, reg.establishmentId, ...REGISTER_ADMIN);
    if (reg.printerType !== 'NETWORK' || !reg.printerHost) throw new BadRequestException('Cette caisse n’a pas d’imprimante réseau');
    const [est, company] = await Promise.all([
      this.prisma.establishment.findUniqueOrThrow({ where: { id: reg.establishmentId } }),
      this.prisma.company.findUniqueOrThrow({ where: { id: me.companyId } }),
    ]);
    const lines = renderTicket(
      {
        company,
        establishment: est,
        register: reg,
        number: '',
        createdAt: new Date(),
        cashier: null,
        status: 'COMPLETED',
        items: [],
        grossTotal: 0n,
        lineDiscountTotal: 0n,
        ticketDiscountAmount: 0n,
        total: 0n,
        taxTotal: 0n,
        payments: [],
        changeGiven: 0n,
        refundedTotal: 0n,
        creditAmount: 0n,
      },
      { width: columnsFor(reg.paperWidth), test: true },
    );
    try {
      await this.printer.send(reg.printerHost, reg.printerPort, escPos(lines));
      return { ok: true, message: 'Ticket de test envoyé à l’imprimante' };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
}

@ApiTags('Caisse')
@ApiBearerAuth()
@Controller('cash-registers')
export class RegistersController {
  constructor(private readonly service: RegistersService) {}

  // Caissiers (pour ouvrir une session) et responsables : filtrage par le service.
  @Get()
  list(@CurrentUser() me: AuthUser, @Query() q: RegisterQuery) {
    return this.service.list(me, q);
  }

  @Post()
  @RequirePermissions(...REGISTER_ADMIN)
  @AnyEstablishmentScope()
  create(@CurrentUser() me: AuthUser, @Body() dto: CreateRegisterDto) {
    return this.service.create(me, dto);
  }

  @Patch(':id')
  @RequirePermissions(...REGISTER_ADMIN)
  @AnyEstablishmentScope()
  update(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRegisterDto) {
    return this.service.update(me, id, dto);
  }

  @Post(':id/test-print')
  @RequirePermissions(...REGISTER_ADMIN)
  @AnyEstablishmentScope()
  testPrint(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.testPrint(me, id);
  }
}
