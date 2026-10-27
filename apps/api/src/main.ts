import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { env } from './config/env';
import { configureApp } from './setup';

async function bootstrap() {
  try {
    process.loadEnvFile();
  } catch {
    // Pas de fichier .env : variables fournies par l'environnement (production).
  }
  const config = env();
  const app = await NestFactory.create(AppModule);
  configureApp(app);

  if (!config.isProduction) {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('AFRIKA FOOD API')
        .setDescription('ERP multisite pâtisserie / boulangerie / restaurant. En-tête X-Establishment-Id pour choisir l\'établissement.')
        .setVersion('0.1.0')
        .addBearerAuth()
        .addGlobalParameters({ name: 'X-Establishment-Id', in: 'header', required: false, schema: { type: 'string', format: 'uuid' } })
        .build(),
    );
    SwaggerModule.setup('api/docs', app, doc);
  }

  // Écoute locale uniquement : l'API n'est joignable que via le reverse proxy.
  await app.listen(config.port, '127.0.0.1');
  Logger.log(`AFRIKA FOOD API sur http://localhost:${config.port}/api (docs : /api/docs)`, 'Bootstrap');
}

bootstrap();
