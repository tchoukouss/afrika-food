import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { env } from './config/env';

// Les identifiants BigInt (journal d'audit…) sont renvoyés en texte dans le JSON.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

/** Configuration commune à l'application et aux tests. */
export function configureApp(app: INestApplication) {
  const express = app as NestExpressApplication;
  // Derrière un proxy (Nginx…), pour récupérer la vraie IP du client.
  express.set('trust proxy', 'loopback');
  app.setGlobalPrefix('api');
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: env().corsOrigins, credentials: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();
}
