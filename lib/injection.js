// Heuristics, not a guarantee. Findings contain categories and positions, never excerpts or secrets.
import { sanitizeText } from './sanitize.js';
const RULES = [
  ['instruction override', /\b(?:ignore|disregard|forget)\s+(?:(?:all|the|your|any)\s+)*(?:previous|prior|above|earlier|system)\s+(?:instructions?|rules?|prompts?)|\b(?:ignora|dimentica|non seguire)\s+(?:(?:tutte|le|queste)\s+)*(?:istruzioni|regole)(?:\s+(?:precedenti|di sistema))?/gi],
  ['role manipulation', /\byou are now\b|\b(?:new rules|system prompt|developer message)\b|\b(?:ora sei|nuove regole|prompt di sistema)\b/gi],
  ['concealment', /\b(?:do not|don't|never)\s+(?:tell|inform|notify)\s+(?:the|your)\s+(?:user|human)|\bnon\s+(?:dire|informare|avvisare)\s+(?:l['’]utente|il tuo umano)/gi],
  ['fake role or tool call', /<\/?(?:system|developer|assistant|tool)(?:\s[^>]*|)>|\[\/?INST\]|\[im_start\]|<\|(?:im_start|im_end|system|assistant|tool)[^>]*>|\b(?:tool_calls?|function_call)\s*["']?\s*:/gi],
  ['encoded payload', /\b(?:[A-Za-z0-9+/]{100,}={0,2}|[a-f0-9]{100,})\b/gi],
  ['dangerous command', /\brm\s+(?:-[a-z]*[rf][a-z]*\s+){1,3}|\b(?:curl|wget)\b[^\n|]{0,300}\|\s*(?:sh|bash|zsh)\b|\bgit\s+push\b[^\n]{0,200}(?:--force(?:-with-lease)?|-f)(?:\s|$)|\b(?:Invoke-WebRequest|iwr|DownloadString)\b[^\n]{0,300}(?:Invoke-Expression|\biex\b)/gi],
  ['data exfiltration', /\b(?:send|upload|post|forward|invia|carica|inoltra)\b[^\n]{0,100}\b(?:tokens?|keys?|secrets?|passwords?|files?|chiavi|segreti)\b[^\n]{0,150}(?:https?:\/\/|\b(?:elsewhere|external|esterno|altrove)\b)/gi],
];
export function detectInjection(text) {
  const s = sanitizeText(text), findings = [];
  for (const [type, re] of RULES) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) {
      findings.push({ type, index: m.index, length: m[0].length });
      if (findings.length >= 50) return findings;
    }
  }
  return findings;
}
