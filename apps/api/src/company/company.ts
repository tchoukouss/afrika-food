import { Body, Controller, Get, Injectable, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';
import { AuditService, diff } from '../audit/audit.service';
import { AuthUser, CurrentUser, GroupScope, RequirePermissions } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class UpdateCompanyDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) legalName?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(60) taxId?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(255) address?: string;
  @IsOptional() @IsUrl() logoUrl?: string;
}

@Injectable()
export class CompanyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  get(companyId: string) {
    return this.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  }

  update(me: AuthUser, dto: UpdateCompanyDto) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM companies WHERE id = ${me.companyId}::uuid FOR UPDATE`;
      const before = await tx.company.findUniqueOrThrow({ where: { id: me.companyId } });
      const { oldValues, newValues, changed } = diff(before, dto);
      if (!changed) return before;
      const updated = await tx.company.update({ where: { id: me.companyId }, data: newValues });
      await this.audit.record({ action: 'COMPANY_UPDATED', entityType: 'Company', entityId: me.companyId, establishmentId: null, oldValues, newValues }, tx);
      return updated;
    });
  }
}

@ApiTags('Entreprise')
@ApiBearerAuth()
@Controller('company')
export class CompanyController {
  constructor(private readonly service: CompanyService) {}

  @Get()
  get(@CurrentUser() me: AuthUser) {
    return this.service.get(me.companyId);
  }

  @Patch()
  @RequirePermissions('company.manage')
  @GroupScope()
  update(@CurrentUser() me: AuthUser, @Body() dto: UpdateCompanyDto) {
    return this.service.update(me, dto);
  }
}
