import { PrismaClient } from '@prisma/client';
import { bootstrapData } from './bootstrap-data';

async function main() {
  try {
    process.loadEnvFile();
  } catch {
    // variables déjà dans l'environnement
  }
  const adminEmail = process.env.SEED_ADMIN_EMAIL;
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    throw new Error('Définir SEED_ADMIN_EMAIL et SEED_ADMIN_PASSWORD dans .env');
  }
  const prisma = new PrismaClient();
  try {
    const { company, adminCreated } = await bootstrapData(prisma, {
      companyName: process.env.SEED_COMPANY_NAME ?? 'AFRIKA FOOD',
      adminEmail,
      adminPassword,
      adminName: process.env.SEED_ADMIN_NAME ?? 'Administrateur',
    });
    console.log(`Entreprise : ${company.name}`);
    console.log(
      adminCreated
        ? `Administrateur créé : ${adminEmail} (changement de mot de passe exigé à la première connexion)`
        : 'Utilisateurs déjà présents : aucun administrateur créé.',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
