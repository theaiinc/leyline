import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

export function requireClientApiKey(req: Request, res: Response, next: NextFunction): void {
  const expected = config.clientApiKey;
  if (!expected) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

  if (token !== expected) {
    res.status(401).json({
      error: {
        message: token ? 'Incorrect API key provided' : 'Missing bearer authentication',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    });
    return;
  }

  next();
}
