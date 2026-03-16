import { countTokens, normalizeText, tokenize } from "./tokenize.mjs";

const DEFAULT_BM25_OPTIONS = {
  titleWeight: 1.4,
  bodyWeight: 1,
  vectorWeight: 0.55,
  lexicalWeight: 0.45,
  titleK1: 1.2,
  titleB: 0.75,
  bodyK1: 1.2,
  bodyB: 0.75,
  exactTitleBoost: 0.45,
  exactBodyBoost: 0.2,
  titleTokenOverlapBoost: 0.12,
};

function average(values) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function bm25Score(termFrequency, documentLength, averageLength, inverseDocumentFrequency, k1, b) {
  if (termFrequency === 0) {
    return 0;
  }

  const normalizedLength = averageLength > 0 ? documentLength / averageLength : 1;
  const denominator = termFrequency + k1 * (1 - b + b * normalizedLength);
  if (denominator === 0) {
    return 0;
  }

  return inverseDocumentFrequency * ((termFrequency * (k1 + 1)) / denominator);
}

function inverseDocumentFrequency(documentCount, documentFrequency) {
  if (documentFrequency === 0) {
    return 0;
  }

  return Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
}

function tokenizeDocument(document) {
  const titleTokens = tokenize(document.title);
  const bodyTokens = tokenize(document.text);

  return {
    ...document,
    normalizedTitle: normalizeText(document.title),
    normalizedBody: normalizeText(document.text),
    titleTokens,
    bodyTokens,
  };
}

export function summarizeText(text, length = 180) {
  if (text.length <= length) {
    return text;
  }

  return `${text.slice(0, length - 1)}...`;
}

export function buildLexicalShard(documents) {
  const preparedDocuments = documents.map(tokenizeDocument);
  const postings = Object.create(null);
  const titleLengths = [];
  const bodyLengths = [];

  preparedDocuments.forEach((document, documentIndex) => {
    const titleCounts = countTokens(document.titleTokens);
    const bodyCounts = countTokens(document.bodyTokens);
    titleLengths.push(document.titleTokens.length);
    bodyLengths.push(document.bodyTokens.length);

    const terms = new Set([...titleCounts.keys(), ...bodyCounts.keys()]);
    for (const term of terms) {
      const entries = postings[term] ?? [];
      entries.push([
        documentIndex,
        titleCounts.get(term) ?? 0,
        bodyCounts.get(term) ?? 0,
      ]);
      postings[term] = entries;
    }
  });

  return {
    version: 1,
    documents: preparedDocuments,
    titleLengths,
    bodyLengths,
    averageTitleLength: average(titleLengths),
    averageBodyLength: average(bodyLengths),
    postings,
  };
}

export function scoreCandidates(lexicalShard, queryText, candidateIds, options = {}) {
  const settings = {
    ...DEFAULT_BM25_OPTIONS,
    ...options,
  };
  const documentCount = lexicalShard.documents.length;
  const candidateSet = new Set(candidateIds);
  const queryTokens = tokenize(queryText);
  const uniqueQueryTokens = [...new Set(queryTokens)];
  const normalizedQuery = normalizeText(queryText);
  const lexicalScores = new Map();

  for (const candidateId of candidateSet) {
    lexicalScores.set(candidateId, {
      lexicalScore: 0,
      titleScore: 0,
      bodyScore: 0,
      exactBoost: 0,
    });
  }

  for (const token of uniqueQueryTokens) {
    const postings = lexicalShard.postings[token];
    if (!postings) {
      continue;
    }

    const idf = inverseDocumentFrequency(documentCount, postings.length);
    for (const [documentIndex, titleFrequency, bodyFrequency] of postings) {
      const document = lexicalShard.documents[documentIndex];
      if (!candidateSet.has(document.id)) {
        continue;
      }

      const score = lexicalScores.get(document.id);
      const titleScore = bm25Score(
        titleFrequency,
        lexicalShard.titleLengths[documentIndex],
        lexicalShard.averageTitleLength,
        idf,
        settings.titleK1,
        settings.titleB,
      );
      const bodyScore = bm25Score(
        bodyFrequency,
        lexicalShard.bodyLengths[documentIndex],
        lexicalShard.averageBodyLength,
        idf,
        settings.bodyK1,
        settings.bodyB,
      );

      score.titleScore += titleScore;
      score.bodyScore += bodyScore;
    }
  }

  for (const document of lexicalShard.documents) {
    if (!candidateSet.has(document.id)) {
      continue;
    }

    const score = lexicalScores.get(document.id);
    const titleTerms = new Set(document.titleTokens);
    const overlap = uniqueQueryTokens.filter((token) => titleTerms.has(token)).length;
    if (overlap > 0) {
      score.exactBoost += overlap * settings.titleTokenOverlapBoost;
    }

    if (normalizedQuery) {
      if (document.normalizedTitle.includes(normalizedQuery)) {
        score.exactBoost += settings.exactTitleBoost;
      } else if (document.normalizedBody.includes(normalizedQuery)) {
        score.exactBoost += settings.exactBodyBoost;
      }
    }

    score.lexicalScore =
      score.titleScore * settings.titleWeight +
      score.bodyScore * settings.bodyWeight +
      score.exactBoost;
  }

  return lexicalScores;
}

export function combineScores(vectorScore, lexicalScore, options = {}) {
  const settings = {
    ...DEFAULT_BM25_OPTIONS,
    ...options,
  };

  return vectorScore * settings.vectorWeight + lexicalScore * settings.lexicalWeight;
}
