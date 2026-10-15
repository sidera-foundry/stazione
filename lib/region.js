// Is the database next to the functions? On Vercel the functions run in one region (VERCEL_REGION, e.g. fra1) and a
// Neon database lives in one AWS region (in its host name, e.g. ...eu-central-1.aws.neon.tech). Far apart, every
// request crosses the distance several times and the station feels slow: the admin console says so and how to fix it.
// Only region names leave this file, never the connection string.

/** Vercel region → AWS region it runs in. */
const VERCEL_AWS = {
  iad1: 'us-east-1', cle1: 'us-east-2', pdx1: 'us-west-2', sfo1: 'us-west-1', yul1: 'ca-central-1', gru1: 'sa-east-1',
  fra1: 'eu-central-1', dub1: 'eu-west-1', lhr1: 'eu-west-2', cdg1: 'eu-west-3', arn1: 'eu-north-1',
  sin1: 'ap-southeast-1', syd1: 'ap-southeast-2', hnd1: 'ap-northeast-1', icn1: 'ap-northeast-2', kix1: 'ap-northeast-3',
  bom1: 'ap-south-1', hkg1: 'ap-east-1', cpt1: 'af-south-1',
};

/** null when they match or cannot be told; otherwise { functions, database, suggested }. */
export function regionCheck(env = process.env) {
  const functions = env.VERCEL_REGION;
  const m = /\.([a-z]{2}-[a-z]+-\d)\.aws\.neon\.tech\b/i.exec(env.DATABASE_URL || '');
  if (!functions || !m || !VERCEL_AWS[functions]) return null;
  const database = m[1].toLowerCase();
  if (VERCEL_AWS[functions] === database) return null;
  return { functions, database, suggested: Object.keys(VERCEL_AWS).find((k) => VERCEL_AWS[k] === database) || null };
}
