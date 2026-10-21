import { BadRequestException } from '@nestjs/common';
import * as argon2 from 'argon2';

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/** Règle minimale : 8 caractères, au moins une lettre et un chiffre. */
export function assertPasswordPolicy(plain: string) {
  if (plain.length < 8 || plain.length > 128 || !/[A-Za-z]/.test(plain) || !/\d/.test(plain)) {
    throw new BadRequestException(
      'Le mot de passe doit contenir au moins 8 caractères, dont au moins une lettre et un chiffre.',
    );
  }
}
