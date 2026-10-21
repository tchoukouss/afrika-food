import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from './request-context';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    requestContext.run(
      {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent']?.slice(0, 500),
      },
      () => next(),
    );
  }
}
