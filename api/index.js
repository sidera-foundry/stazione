// Single Vercel Function behind every /api/* path (see the rewrite in vercel.json).
import { handleRequest } from '../lib/app.js';

export const GET = handleRequest;
export const POST = handleRequest;
export const PUT = handleRequest;
export const PATCH = handleRequest;
export const DELETE = handleRequest;
