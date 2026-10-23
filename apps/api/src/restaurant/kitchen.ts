import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { RestaurantItemStatus } from "@prisma/client";
import { IsIn, IsOptional, IsUUID } from "class-validator";
import { AuditService } from "../audit/audit.service";
import { AuthUser, CurrentUser } from "../auth/decorators";
import { PrismaService, Tx } from "../prisma/prisma.service";
import { D } from "../stock/common";
import { assertAny, lockOrders, readableWith, SENT_STATUSES } from "./common";
import { RestaurantPrinting } from "./printing";

type KitchenStatus = "IN_PREPARATION" | "READY" | "SERVED";

export class KitchenStatusDto {
  @IsIn(["IN_PREPARATION", "READY", "SERVED"]) status: KitchenStatus;
}

class KitchenQuery {
  @IsOptional() @IsUUID() establishmentId?: string;
  @IsOptional() @IsUUID() stationId?: string;
}

const rank = (s: RestaurantItemStatus) =>
  SENT_STATUSES.indexOf(s as (typeof SENT_STATUSES)[number]);

@Injectable()
export class KitchenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly printing: RestaurantPrinting,
  ) {}

  /** Bons en cours (reçus, en préparation, prêts), les plus anciens et urgents d'abord. */
  async queue(me: AuthUser, q: KitchenQuery) {
    const ests = readableWith(
      me,
      ["restaurant.kitchen", "restaurant.orders"],
      q.establishmentId,
    );
    const items = await this.prisma.restaurantOrderItem.findMany({
      where: {
        status: { in: ["NEW", "IN_PREPARATION", "READY"] },
        order: { companyId: me.companyId, establishmentId: { in: ests } },
      },
      include: { order: true },
      orderBy: { position: "asc" },
    });
    const ticketIds = [...new Set(items.map((i) => i.kitchenTicketId!))];
    const tickets = await this.prisma.restaurantKitchenTicket.findMany({
      where: { id: { in: ticketIds } },
    });
    const [tables, stations] = await Promise.all([
      this.prisma.restaurantTable.findMany({
        where: {
          id: {
            in: items
              .map((i) => i.order.tableId)
              .filter((x): x is string => !!x),
          },
        },
        select: { id: true, code: true },
      }),
      this.prisma.restaurantStation.findMany({
        where: {
          id: {
            in: tickets.map((t) => t.stationId).filter((x): x is string => !!x),
          },
        },
        select: { id: true, name: true, kind: true },
      }),
    ]);
    return tickets
      .filter((t) => !q.stationId || t.stationId === q.stationId)
      .map((t) => {
        // Commande actuelle des articles du bon (après un transfert ou un regroupement, pas forcément celle d'origine).
        const order = items.find((i) => i.kitchenTicketId === t.id)!.order;
        return {
          id: t.id,
          number: t.number,
          createdAt: t.createdAt,
          urgent: t.urgent || order.urgent,
          station: stations.find((s) => s.id === t.stationId) ?? null,
          order: {
            id: order.id,
            number: order.number,
            mode: order.mode,
            table: tables.find((x) => x.id === order.tableId)?.code ?? null,
            customerName: order.customerName,
            covers: order.covers,
            note: order.note,
          },
          items: items
            .filter((i) => i.kitchenTicketId === t.id)
            .map((i) => ({
              id: i.id,
              productName: i.productName,
              quantity: D(i.quantity).sub(i.cancelledQuantity),
              note: i.note,
              options: i.options,
              parentItemId: i.parentItemId,
              status: i.status,
              statusChangedAt: i.statusChangedAt,
            })),
        };
      })
      .sort(
        (a, b) =>
          Number(b.urgent) - Number(a.urgent) ||
          a.createdAt.getTime() - b.createdAt.getTime(),
      );
  }

  /**
   * Avance des statuts : reçue → en préparation → prête → servie, jamais en
   * arrière. La cuisine fait avancer ; le personnel de salle peut aussi
   * marquer « servi » (décision R29).
   */
  private async advance(
    tx: Tx,
    me: AuthUser,
    itemIds: string[],
    status: KitchenStatus,
  ) {
    const items = await tx.restaurantOrderItem.findMany({
      where: { id: { in: itemIds } },
    });
    const movable = items.filter(
      (i) => rank(i.status) >= 0 && rank(i.status) < rank(status),
    );
    if (!movable.length)
      throw new ConflictException("Statut déjà atteint ou article annulé");
    const now = new Date();
    await tx.restaurantOrderItem.updateMany({
      where: { id: { in: movable.map((i) => i.id) } },
      data: { status, statusChangedAt: now, statusChangedById: me.userId },
    });
    return movable;
  }

  private permissionsFor(status: KitchenStatus) {
    return status === "SERVED"
      ? ["restaurant.kitchen", "restaurant.orders"]
      : ["restaurant.kitchen"];
  }

  async setItemStatus(me: AuthUser, itemId: string, dto: KitchenStatusDto) {
    const item = await this.prisma.restaurantOrderItem.findFirst({
      where: { id: itemId, order: { companyId: me.companyId } },
      include: { order: true },
    });
    if (!item) throw new NotFoundException("Article introuvable");
    assertAny(
      me,
      item.order.establishmentId,
      ...this.permissionsFor(dto.status),
    );
    await this.prisma.$transaction(async (tx) => {
      await lockOrders(tx, [item.orderId]);
      const moved = await this.advance(tx, me, [itemId], dto.status);
      await this.audit.record(
        {
          action: "RESTAURANT_ITEM_STATUS",
          entityType: "RestaurantOrder",
          entityId: item.orderId,
          establishmentId: item.order.establishmentId,
          newValues: {
            product: item.productName,
            from: moved[0].status,
            to: dto.status,
          },
        },
        tx,
      );
    });
    return this.prisma.restaurantOrderItem.findUniqueOrThrow({
      where: { id: itemId },
    });
  }

  /** Action groupée sur un bon : tous ses articles qui peuvent avancer. */
  async setTicketStatus(me: AuthUser, ticketId: string, dto: KitchenStatusDto) {
    const ticket = await this.prisma.restaurantKitchenTicket.findFirst({
      where: { id: ticketId, companyId: me.companyId },
    });
    if (!ticket) throw new NotFoundException("Bon introuvable");
    assertAny(me, ticket.establishmentId, ...this.permissionsFor(dto.status));
    await this.prisma.$transaction(async (tx) => {
      await lockOrders(tx, [ticket.orderId]);
      const items = await tx.restaurantOrderItem.findMany({
        where: { kitchenTicketId: ticketId },
        select: { id: true },
      });
      const moved = await this.advance(
        tx,
        me,
        items.map((i) => i.id),
        dto.status,
      );
      await this.audit.record(
        {
          action: "RESTAURANT_TICKET_STATUS",
          entityType: "RestaurantKitchenTicket",
          entityId: ticketId,
          establishmentId: ticket.establishmentId,
          newValues: {
            number: ticket.number,
            status: dto.status,
            items: moved.length,
          },
        },
        tx,
      );
    });
    return { ok: true };
  }

  async reprintTicket(me: AuthUser, ticketId: string) {
    const ticket = await this.prisma.restaurantKitchenTicket.findFirst({
      where: { id: ticketId, companyId: me.companyId },
    });
    if (!ticket) throw new NotFoundException("Bon introuvable");
    assertAny(
      me,
      ticket.establishmentId,
      "restaurant.kitchen",
      "restaurant.orders",
    );
    const station = ticket.stationId
      ? await this.prisma.restaurantStation.findUnique({
          where: { id: ticket.stationId },
        })
      : null;
    const job = await this.prisma.$transaction(async (tx) => {
      const j = (await this.printing.createJob(
        tx,
        me,
        {
          establishmentId: ticket.establishmentId,
          kind: "KITCHEN",
          kitchenTicketId: ticketId,
          stationId: ticket.stationId,
        },
        station ?? {
          printerType: "BROWSER",
          printerHost: null,
          printerPort: 9100,
          paperWidth: 80,
        },
        true,
      ))!;
      await this.audit.record(
        {
          action: "RESTAURANT_TICKET_REPRINTED",
          entityType: "RestaurantKitchenTicket",
          entityId: ticketId,
          establishmentId: ticket.establishmentId,
          newValues: { number: ticket.number },
        },
        tx,
      );
      return j;
    });
    const print =
      job.status === "PENDING" ? await this.printing.deliver(job.id) : job;
    return { print, ...(await this.printing.lines(job)) };
  }

  /** Relance d'une impression en échec, ou repli sur le navigateur. */
  async retryPrint(me: AuthUser, jobId: string, toBrowser: boolean) {
    const job = await this.printing.find(me, jobId);
    assertAny(
      me,
      job.establishmentId,
      ...(job.kind === "KITCHEN"
        ? ["restaurant.kitchen", "restaurant.orders"]
        : ["restaurant.orders"]),
    );
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM restaurant_print_jobs WHERE id = ${jobId}::uuid FOR UPDATE`;
      const j = await tx.restaurantPrintJob.findUniqueOrThrow({
        where: { id: jobId },
      });
      if (j.status !== "FAILED")
        throw new BadRequestException(
          "Seule une impression en échec peut être relancée",
        );
      await this.audit.record(
        {
          action: toBrowser
            ? "RESTAURANT_PRINT_BROWSER"
            : "RESTAURANT_PRINT_RETRY",
          entityType: "RestaurantPrintJob",
          entityId: jobId,
          establishmentId: j.establishmentId,
          newValues: { kind: j.kind },
        },
        tx,
      );
      return toBrowser
        ? tx.restaurantPrintJob.update({
            where: { id: jobId },
            data: { status: "BROWSER", attempts: { increment: 1 } },
          })
        : j;
    });
    const print = toBrowser ? updated : await this.printing.deliver(jobId);
    return { print, ...(await this.printing.lines(job)) };
  }
}

@ApiTags("Restaurant")
@ApiBearerAuth()
@Controller("restaurant")
export class KitchenController {
  constructor(private readonly service: KitchenService) {}

  @Get("kitchen")
  queue(@CurrentUser() me: AuthUser, @Query() q: KitchenQuery) {
    return this.service.queue(me, q);
  }

  @Post("kitchen/items/:id/status")
  setItemStatus(
    @CurrentUser() me: AuthUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: KitchenStatusDto,
  ) {
    return this.service.setItemStatus(me, id, dto);
  }

  @Post("kitchen/tickets/:id/status")
  setTicketStatus(
    @CurrentUser() me: AuthUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: KitchenStatusDto,
  ) {
    return this.service.setTicketStatus(me, id, dto);
  }

  @Post("kitchen/tickets/:id/reprint")
  reprint(@CurrentUser() me: AuthUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.service.reprintTicket(me, id);
  }

  @Post("print-jobs/:id/retry")
  retry(@CurrentUser() me: AuthUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.service.retryPrint(me, id, false);
  }

  @Post("print-jobs/:id/browser")
  browser(@CurrentUser() me: AuthUser, @Param("id", ParseUUIDPipe) id: string) {
    return this.service.retryPrint(me, id, true);
  }
}
