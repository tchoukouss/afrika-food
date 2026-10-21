import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { CookieOptions, Request, Response } from 'express';
import { env } from '../config/env';
import { AllowPendingPassword } from './auth.guard';
import { AuthService, IssuedTokens } from './auth.service';
import { AuthUser, CurrentUser, Public } from './decorators';
import { ChangePasswordDto, LoginDto } from './dto/auth.dto';

export const REFRESH_COOKIE = 'af_refresh';

function cookieOptions(expires?: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: env().isProduction,
    // Strict + chemin restreint : le cookie n'est jamais envoyé par un autre site
    // ni sur les autres routes de l'API (protection CSRF).
    sameSite: 'strict',
    path: '/api/auth',
    expires,
  };
}

@ApiTags('Authentification')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private sendTokens(res: Response, tokens: IssuedTokens) {
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, cookieOptions(tokens.refreshExpiresAt));
    return { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const tokens = await this.auth.login(dto.email, dto.password);
    return { ...this.sendTokens(res, tokens), user: await this.auth.me(tokens.userId) };
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    try {
      return this.sendTokens(res, await this.auth.refresh(req.cookies?.[REFRESH_COOKIE]));
    } catch (e) {
      res.clearCookie(REFRESH_COOKIE, cookieOptions());
      throw e;
    }
  }

  @ApiBearerAuth()
  @AllowPendingPassword()
  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentUser() me: AuthUser, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(me.sessionId);
    res.clearCookie(REFRESH_COOKIE, cookieOptions());
  }

  @ApiBearerAuth()
  @AllowPendingPassword()
  @Get('me')
  me(@CurrentUser() me: AuthUser) {
    return this.auth.me(me.userId);
  }

  @ApiBearerAuth()
  @AllowPendingPassword()
  @Post('change-password')
  @HttpCode(204)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async changePassword(@CurrentUser() me: AuthUser, @Body() dto: ChangePasswordDto) {
    await this.auth.changePassword(me.userId, me.sessionId, dto.currentPassword, dto.newPassword);
  }
}
