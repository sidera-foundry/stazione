// Recent commits and the current deploy. The deploy workflow overwrites build-info.json right before uploading,
// so the file always describes the code that is running; the committed copy is an empty placeholder.
import info from '../build-info.json' with { type: 'json' };

export const logRoutes = [
  ['GET', '/api/log', { auth: 'any' }, async () => info],
];
