import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

/**
 * Règles métier gardées par un trigger PostgreSQL (RAISE EXCEPTION, SQLSTATE
 * P0001) et traduites en conflit lisible. Seuls les messages listés ici sont
 * traduits : toute autre erreur garde son traitement habituel.
 */
const BUSINESS_RULES = [
  {
    // Trigger sale_returns_not_invoiced (module 7) : ticket facturé, correction par avoir.
    trigger: 'Ticket facture : correction par avoir uniquement',
    code: 'INVOICED_TICKET',
    message: 'Ticket déjà facturé : il ne s’annule ni ne se rembourse plus en caisse. Corrigez-le par un avoir sur sa facture.',
  },
];

// Traduit les erreurs Prisma connues en réponses HTTP compréhensibles,
// sans exposer de détail interne de la base.
@Catch(Prisma.PrismaClientKnownRequestError, Prisma.PrismaClientUnknownRequestError)
export class PrismaExceptionFilter extends BaseExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: Prisma.PrismaClientKnownRequestError | Prisma.PrismaClientUnknownRequestError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const rule = /P0001/.test(exception.message) ? BUSINESS_RULES.find((r) => exception.message.includes(r.trigger)) : undefined;
    if (rule) {
      return res.status(HttpStatus.CONFLICT).json({ statusCode: HttpStatus.CONFLICT, code: rule.code, message: rule.message });
    }
    // Erreur inconnue hors règle métier : traitement par défaut de Nest, inchangé.
    if (exception instanceof Prisma.PrismaClientUnknownRequestError) return super.catch(exception, host);
    switch (exception.code) {
      case 'P2002':
        return res.status(HttpStatus.CONFLICT).json({
          statusCode: HttpStatus.CONFLICT,
          message: 'Cette valeur existe déjà (doublon).',
          fields: exception.meta?.target,
        });
      case 'P2025':
        return res.status(HttpStatus.NOT_FOUND).json({
          statusCode: HttpStatus.NOT_FOUND,
          message: 'Élément introuvable.',
        });
      case 'P2034':
        // Conflit de transaction (sérialisation / interblocage) : le client peut réessayer.
        return res.status(HttpStatus.CONFLICT).json({
          statusCode: HttpStatus.CONFLICT,
          message: 'Opération concurrente détectée, veuillez réessayer.',
        });
      default:
        this.logger.error(exception);
        return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Erreur interne.',
        });
    }
  }
}
