const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID（時間排序）。rand 可注入以便測試。 */
export function ulid(now: number = Date.now(), rand: (n: number) => Uint8Array = randBytes): string {
  let t = "";
  let ms = now;
  for (let i = 0; i < 10; i++) {
    t = CROCKFORD[ms % 32] + t;
    ms = Math.floor(ms / 32);
  }
  const r = rand(16);
  let s = "";
  for (let i = 0; i < 16; i++) s += CROCKFORD[r[i] % 32];
  return t + s;
}

function randBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}
