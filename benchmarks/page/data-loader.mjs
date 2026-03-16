const DIM = 384;

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function loadEmails(url, count) {
  const res = await fetch(url);
  const emails = await res.json();
  const subset = emails.slice(0, count);
  const rng = mulberry32(42);

  return subset.map((email) => ({
    id: email.id,
    title: email.subject,
    url: email.text,
    embeddings: Array.from({ length: DIM }, () => rng()),
  }));
}

export function generateQuery() {
  const rng = mulberry32(123);
  return new Float32Array(Array.from({ length: DIM }, () => rng()));
}

export function generateDocs(count, seed = 99) {
  const rng = mulberry32(seed);
  return Array.from({ length: count }, (_, i) => ({
    id: `synth-${i}`,
    title: `Document ${i}`,
    url: `/synth/${i}`,
    embeddings: Array.from({ length: DIM }, () => rng()),
  }));
}
