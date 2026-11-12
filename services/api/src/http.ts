import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodError } from 'zod';
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export const route = (fn: (req: Request, res: Response) => Promise<any>): RequestHandler => (req, res, next) => { Promise.resolve(fn(req, res)).catch(next); };
export function errors(error: any, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof ZodError) { res.status(400).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }); return; }
  if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
  if (error.code === '23505') { res.status(409).json({ error: 'This record already exists.' }); return; }
  if (error.code === '23P01') { res.status(409).json({ error: 'This room is no longer available for those dates.' }); return; }
  console.error('Request failed:', error.code ?? error.name);
  res.status(500).json({ error: 'The request could not be completed. Please try again.' });
}
export type User = { id: string; name: string; email: string; role: 'guest' | 'hotel' | 'admin' };
export function user(res: Response, roles?: string[]): User {
  const value = res.locals.user as User | undefined;
  if (!value) throw new HttpError(401, 'Please sign in to continue.');
  if (roles && !roles.includes(value.role)) throw new HttpError(403, 'You do not have access to this feature.');
  return value;
}
