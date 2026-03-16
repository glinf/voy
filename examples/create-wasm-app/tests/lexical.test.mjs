import test from "node:test";
import assert from "node:assert/strict";

import { buildLexicalShard, scoreCandidates } from "../lib/lexical-index.mjs";
import { normalizeText, tokenize } from "../lib/tokenize.mjs";

test("tokenize keeps normalized word variants", () => {
  const tokens = tokenize("Voy-powered search in foo-bar.example/path");

  assert(tokens.includes("voy-powered"));
  assert(tokens.includes("voy"));
  assert(tokens.includes("powered"));
  assert(tokens.includes("foo-bar.example/path"));
  assert(tokens.includes("foo"));
  assert(tokens.includes("bar"));
  assert.equal(normalizeText("Amazon   Rainforest"), "amazon rainforest");
});

test("lexical reranking favors exact title matches over loose body matches", () => {
  const shard = buildLexicalShard([
    {
      id: "title-match",
      title: "Amazon rainforest overview",
      text: "An introduction to the Amazon basin and rainforest ecology.",
      url: "/docs/title-match",
      embedding: [1, 0, 0],
    },
    {
      id: "body-match",
      title: "South America geography",
      text: "This document mentions the Amazon rainforest in passing only once.",
      url: "/docs/body-match",
      embedding: [0, 1, 0],
    },
  ]);

  const scores = scoreCandidates(
    shard,
    "Amazon rainforest overview",
    ["title-match", "body-match"],
  );

  assert(scores.get("title-match").lexicalScore > scores.get("body-match").lexicalScore);
  assert(scores.get("title-match").exactBoost > 0);
});
