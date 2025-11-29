// Mixed, cozy wordlists (nature + city + coffee + color/material + analog/print)
export const adjectives = [
  'olive','amber','linen','cedar','fern','meadow','pebble','beacon','harbor','drift',
  'plaza','metro','bistro','arcade','ferry','market','bridge','corner','terrace','gallery',
  'latte','mocha','crema','roast','croissant','brioche','scone','bagel','vanilla','syrup',
  'cobalt','sepia','coral','slate','oak','brass','velvet','quartz','clay','granite',
  'neon','cassette','pixel','analog','mixtape','pager','retro','vinyl','matte','frame'
];

export const nouns = [
  'harbor','meadow','river','grove','shore','bridge','corner','terrace','gallery','plaza',
  'trailer','cameo','reel','foley','scene','slate','pulp','zine','frame','cut',
  'latte','brioche','scone','bagel','mocha','croissant','vanilla','syrup','roast','crema',
  'cobalt','sepia','coral','oak','brass','velvet','quartz','clay','linen','quarry',
  'neon','cassette','pixel','analog','mixtape','pager','retro','vinyl','matte','codec'
];

function rand(max: number): number {
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] % max;
  }
  return Math.floor(Math.random() * max);
}

export function generateRoomCode(): string {
  const a = adjectives[rand(adjectives.length)];
  const n = nouns[rand(nouns.length)];
  const num = String(rand(1000)).padStart(3, '0');
  return `${a}-${n}-${num}`;
}

export function normalizeRoomCode(input: string): string {
  const cleaned = input.trim().toLowerCase().replace(/[\s_]+/g, '-');
  const m = cleaned.match(/^([a-z]+)-([a-z]+)-?(\d{1,3})$/);
  if (!m) return '';
  const num = m[3].padStart(3, '0');
  return `${m[1]}-${m[2]}-${num}`;
}

export function isValidRoomCode(code: string): boolean {
  return /^[a-z]+-[a-z]+-\d{3}$/.test(code);
}

/** Check if a word is in either wordlist */
export function isKnownWord(word: string): boolean {
  const w = word.toLowerCase();
  return adjectives.includes(w) || nouns.includes(w);
}
