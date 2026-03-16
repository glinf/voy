const WORD_SEGMENTER = new Intl.Segmenter("und", {
  granularity: "word",
});

const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const TOKEN_HAS_CONTENT = /[\p{L}\p{N}]/u;
const SPLIT_VARIANTS = /[-/._:@]+/u;
const COMPOUND_CONNECTOR = /^[-/._:@]+$/u;

function normalizeToken(token) {
  const normalized = token.normalize("NFKC").toLocaleLowerCase().replace(EDGE_PUNCTUATION, "");
  return TOKEN_HAS_CONTENT.test(normalized) ? normalized : "";
}

function splitVariants(token) {
  if (!SPLIT_VARIANTS.test(token)) {
    return [token];
  }

  return token
    .split(SPLIT_VARIANTS)
    .map((part) => normalizeToken(part))
    .filter(Boolean);
}

export function normalizeText(text) {
  return Array.from(WORD_SEGMENTER.segment(text ?? ""))
    .filter((segment) => segment.isWordLike)
    .map((segment) => normalizeToken(segment.segment))
    .filter(Boolean)
    .join(" ");
}

export function tokenize(text) {
  const segments = Array.from(WORD_SEGMENTER.segment(text ?? ""));
  const tokens = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment.isWordLike) {
      continue;
    }

    const normalized = normalizeToken(segment.segment);
    if (!normalized) {
      continue;
    }

    const variants = new Set([normalized, ...splitVariants(normalized)]);
    for (const variant of variants) {
      if (variant) {
        tokens.push(variant);
      }
    }

    let compound = normalized;
    let compoundLength = 1;
    while (
      index + compoundLength + 1 < segments.length &&
      COMPOUND_CONNECTOR.test(segments[index + compoundLength].segment) &&
      segments[index + compoundLength + 1].isWordLike
    ) {
      const nextToken = normalizeToken(segments[index + compoundLength + 1].segment);
      if (!nextToken) {
        break;
      }

      compound += segments[index + compoundLength].segment + nextToken;
      compoundLength += 2;
    }

    if (compoundLength > 1) {
      const compoundVariants = new Set([compound, ...splitVariants(compound)]);
      for (const variant of compoundVariants) {
        if (variant) {
          tokens.push(variant);
        }
      }
    }
  }

  return tokens;
}

export function countTokens(tokens) {
  const counts = new Map();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}
