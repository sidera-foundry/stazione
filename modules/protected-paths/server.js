// Protected paths: refuses missions and locks that touch files agents must never change (.env files, keys, the
// deploy configuration...). A small, complete example of a module rule: a guard can only refuse an action, with a
// reason the agent reads; it can never allow something the core would refuse.
//
// Patterns, one per line in the module settings: * matches any characters except "/". A pattern without "/" is
// compared with the file name (".env*" protects src/.env.local too); a pattern with "/" with the whole path from
// the project root ("infra/*" protects every file directly in infra/, "infra/**" everything below it). Locking a whole
// folder that holds protected paths ("infra" when "infra/**" is protected) is refused too: the lock would cover them.

const escape = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
function matcher(pattern) {
  const p = pattern.trim().replace(/^\.?\//, '');
  const re = new RegExp(`^${escape(p).replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`, 'i');
  if (!p.includes('/')) return (path) => re.test(path.split('/').pop());
  // The folders that hold the protected paths: everything before the first wildcard, cut at the last "/".
  const fixed = p.split('*')[0], folder = fixed.slice(0, fixed.lastIndexOf('/')).toLowerCase();
  return (path) => re.test(path) || (folder !== '' && (folder === path.toLowerCase() || folder.startsWith(`${path.toLowerCase()}/`)));
}
/** Paths of a resource list ("src/a.js", "api:/items" and other non-file resources are left alone). */
const files = (resources) => resources.filter((r) => typeof r === 'string' && !/^[a-z]+:/i.test(r)).map((r) => r.replace(/^\.?\//, ''));

function check(resources, settings) {
  const rules = (settings.patterns || []).filter(Boolean).map((p) => [p, matcher(p)]);
  for (const path of files(resources)) {
    const hit = rules.find(([, test]) => test(path));
    if (hit) return `${path} matches the protected pattern "${hit[0]}". ${settings.message || ''}`.trim();
  }
  return null;
}

export default function setup(station) {
  station.guard('lock.take', ({ payload, settings }) => check(payload.resources, settings));
  station.guard('mission.create', ({ payload, settings }) => check(payload.resources, settings));
}
