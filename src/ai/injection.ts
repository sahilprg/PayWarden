/**
 * Cheap, deterministic first-pass scan for text that tries to give orders to an
 * AI agent. It is a signal, not a guarantee: the structural defence is that the
 * policy engine never obeys untrusted text at all. A hit here only forces a
 * human to look.
 */
const PATTERNS: [RegExp, string][] = [
  [/ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|messages?|prompts?)/i, 'tries to override earlier instructions'],
  [/disregard\s+(the\s+)?(user|system|previous|above)/i, 'tells the agent to disregard its instructions'],
  [/\b(system|developer)\s+(prompt|message|instruction)s?\b/i, 'refers to hidden system instructions'],
  [/\byou\s+(must|should|need\s+to|are\s+required\s+to)\s+(now\s+)?(also\s+)?(buy|purchase|pay|send|transfer|checkout|order)\b/i, 'issues purchase commands to the agent'],
  [/\b(also|additionally|and\s+then)\s+(buy|purchase|add|order|send)\b/i, 'tries to add extra purchases'],
  [/do\s+not\s+(tell|inform|notify|alert|mention)\s+(this\s+to\s+)?the\s+(user|buyer|customer|owner)/i, 'asks the agent to hide actions from the person'],
  [/\b(secretly|silently|quietly)\b|without\s+(asking|approval|telling|confirmation)/i, 'asks for covert action'],
  [/<\/?\s*(system|assistant|instructions?)\s*>/i, 'contains fake role or instruction tags'],
  [/\b(send|transfer|wire)\s+(the\s+)?(money|funds|payment|balance)\b/i, 'asks for a transfer of funds'],
];

export interface HeuristicScan {
  suspicious: boolean;
  matches: string[];
}

export function heuristicInjectionScan(text?: string): HeuristicScan {
  if (!text) return { suspicious: false, matches: [] };
  const matches = PATTERNS.filter(([re]) => re.test(text)).map(([, why]) => why);
  return { suspicious: matches.length > 0, matches };
}
