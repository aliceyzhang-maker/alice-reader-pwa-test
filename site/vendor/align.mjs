// ../tools/stalign/node_modules/itertools/dist/index.js
function* count(start = 0, step = 1) {
  let n = start;
  for (; ; ) {
    yield n;
    n += step;
  }
}
function* takewhile(iterable, predicate) {
  let index = 0;
  const it = iter(iterable);
  let res;
  while (!(res = it.next()).done) {
    const value = res.value;
    if (!predicate(value, index++)) return;
    yield value;
  }
}
function* enumerate(iterable, start = 0) {
  let index = start;
  for (const value of iterable) {
    yield [index++, value];
  }
}
function iter(iterable) {
  return iterable[Symbol.iterator]();
}
function range_(start, stop, step) {
  const counter = count(start, step);
  const pred = step >= 0 ? (n) => n < stop : (n) => n > stop;
  return takewhile(counter, pred);
}
function range(startOrStop, definitelyStop, step = 1) {
  if (definitelyStop !== void 0) {
    return range_(startOrStop, definitelyStop, step);
  } else {
    return range_(0, startOrStop, step);
  }
}

// ../tools/stalign/node_modules/@storyteller-platform/align/dist/align/ctc/forcedAlign.js
function buildStateGraph(labels, starId, blankId) {
  const tokens = new Int32Array(2 * labels.length + 1).fill(blankId);
  for (const [i, label] of labels.entries())
    tokens[2 * i + 1] = label;
  const skipLegal = new Uint8Array(tokens.length);
  for (let s = 2; s < tokens.length; s++) {
    skipLegal[s] = tokens[s] !== tokens[s - 2] || tokens[s] === starId ? 1 : 0;
  }
  return { tokens, skipLegal };
}
function ctcViterbiAlign({ values, frames: numFrames, classes }, labels, blankId, starId, starScore) {
  if (!labels.length)
    return [];
  if (!numFrames)
    return [];
  const { tokens, skipLegal } = buildStateGraph(labels, starId, blankId);
  const numStates = tokens.length;
  const starColumn = classes;
  const columns = classes + 1;
  const scores = new Float32Array(numFrames * columns);
  for (let t = 0; t < numFrames; t++) {
    scores.set(values.subarray(t * classes, (t + 1) * classes), t * columns);
    scores[t * columns + starColumn] = starScore;
  }
  const stateColumn = new Int32Array(numStates);
  for (let s = 0; s < numStates; s++) {
    stateColumn[s] = tokens[s] === starId ? starColumn : tokens[s];
  }
  let prevScores = new Float32Array(numStates).fill(-Infinity);
  let currScores = new Float32Array(numStates);
  const backpointers = new Uint8Array(numFrames * numStates);
  prevScores[0] = scores[stateColumn[0]];
  prevScores[1] = scores[stateColumn[1]];
  if (labels[0] === starId) {
    prevScores[2] = scores[stateColumn[2]];
    prevScores[3] = scores[stateColumn[3]];
  }
  for (let t = 1; t < numFrames; t++) {
    const row = t * columns;
    const backpointerRow = t * numStates;
    for (let s = 0; s < numStates; s++) {
      let best = prevScores[s];
      let bestOp = 0;
      if (s > 0 && prevScores[s - 1] > best) {
        best = prevScores[s - 1];
        bestOp = 1;
      }
      if (skipLegal[s] && prevScores[s - 2] > best) {
        best = prevScores[s - 2];
        bestOp = 2;
      }
      currScores[s] = scores[row + stateColumn[s]] + best;
      backpointers[backpointerRow + s] = bestOp;
    }
    ;
    [prevScores, currScores] = [currScores, prevScores];
  }
  const terminalCandidates = [
    numStates - 1,
    numStates - 2,
    // Same as above, only allow skipping the last label
    // if it's a star
    ...labels.at(-1) === starId ? [numStates - 3, numStates - 4] : []
  ].filter((s) => s >= 0);
  let terminal = terminalCandidates[0];
  for (const s of terminalCandidates) {
    if (prevScores[s] > prevScores[terminal])
      terminal = s;
  }
  if (prevScores[terminal] === -Infinity) {
    return labels.map((label) => ({
      label,
      startFrame: -1,
      endFrame: -1,
      score: -Infinity
    }));
  }
  const path = new Int32Array(numFrames);
  path[numFrames - 1] = terminal;
  for (let t = numFrames - 1; t > 0; t--) {
    const s = path[t];
    const op = backpointers[t * numStates + s];
    path[t - 1] = s - op;
  }
  const firstFrames = new Int32Array(numStates).fill(-1);
  const lastFrames = new Int32Array(numStates).fill(-1);
  const scoreSums = new Float64Array(numStates);
  const frameCounts = new Int32Array(numStates);
  for (let t = 0; t < numFrames; t++) {
    const s = path[t];
    if (firstFrames[s] === -1)
      firstFrames[s] = t;
    lastFrames[s] = t;
    scoreSums[s] += scores[t * columns + stateColumn[s]];
    frameCounts[s]++;
  }
  const alignments = [];
  for (let l = 0; l < labels.length; l++) {
    const state = 2 * l + 1;
    const startFrame = firstFrames[state];
    const endFrame = lastFrames[state];
    const scoreSum = scoreSums[state];
    const frameCount = frameCounts[state];
    const meanScore = frameCount > 0 ? scoreSum / frameCount : -Infinity;
    alignments.push({
      label: labels[l],
      startFrame,
      endFrame,
      score: meanScore
    });
  }
  return alignments;
}
function detectDroppedLabels(alignments, startOffset, endOffset, minLength = 8) {
  if (endOffset < startOffset || endOffset - startOffset <= minLength) {
    return false;
  }
  const endFrame = alignments[endOffset]?.endFrame;
  if (endFrame === void 0) {
    throw new Error(`endOffset ${endOffset} out of bounds`);
  }
  const startFrame = alignments[startOffset]?.startFrame;
  if (startFrame === void 0) {
    throw new Error(`startOffset ${startOffset} out of bounds`);
  }
  const framesPerChar = (endFrame - startFrame) / (endOffset - startOffset);
  if (framesPerChar >= 2)
    return false;
  const goodChars = alignments.slice(startOffset, endOffset + 1).reduce((acc, a) => acc + (a.score > -4 ? 1 : 0), 0);
  return goodChars / (endOffset + 1 - startOffset) < 0.5;
}
function removeLabelRanges(input, removals) {
  const inputIndices = [];
  let nextRemovalIndex = 0;
  const result = [];
  let i = 0;
  while (i < input.length) {
    const l = input[i];
    const nextRemoval = removals[nextRemovalIndex];
    if (!nextRemoval) {
      inputIndices.push(i);
      result.push(l);
      i++;
      continue;
    }
    if (i >= nextRemoval[0] && i <= nextRemoval[1]) {
      i++;
      continue;
    }
    if (i > nextRemoval[1]) {
      nextRemovalIndex++;
      continue;
    }
    inputIndices.push(i);
    result.push(l);
    i++;
  }
  return { result, inputIndices };
}
var STAR_SCORE = -3;
function ctcForcedAlign(baseline, emissions, anchors, vocab, blankId, dropLabels = () => []) {
  const star = vocab.size;
  const segments = [];
  for (let i = 0; i < anchors.length + 1; i++) {
    const prevAnchor = anchors[i - 1];
    const nextAnchor = anchors[i];
    const framesFrom = prevAnchor?.position ?? 0;
    const framesTo = nextAnchor?.position ?? emissions.frames;
    segments.push({
      labels: baseline.slice(prevAnchor?.offset, nextAnchor?.offset).split("").map((c) => vocab.get(c) ?? star),
      labelsStart: prevAnchor?.offset ?? 0,
      emissions: {
        values: emissions.values.subarray(framesFrom * emissions.classes, framesTo * emissions.classes),
        frames: framesTo - framesFrom,
        classes: emissions.classes
      },
      emissionsStart: framesFrom
    });
  }
  segments[0]?.labels.unshift(star);
  segments.at(-1)?.labels.push(star);
  const alignmentsWithRemovals = [];
  const inputIndices = [];
  for (const segment of segments) {
    let stripBoundingStars = function(arr) {
      let result = arr;
      if (segment === segments[0]) {
        result = result.slice(1);
      }
      if (segment === segments.at(-1)) {
        result = result.slice(0, -1);
      }
      return result;
    };
    let indices = Array.from(range(stripBoundingStars(segment.labels).length));
    let unmapped = ctcViterbiAlign(segment.emissions, segment.labels, blankId, star, STAR_SCORE);
    const dropped = dropLabels(segment.labelsStart, stripBoundingStars(unmapped)).map(([s, e]) => [
      s - segment.labelsStart,
      e - segment.labelsStart
    ]);
    if (dropped.length) {
      const { result: adjustedLabels, inputIndices: adjustedIndices } = removeLabelRanges(stripBoundingStars(segment.labels), dropped);
      indices = adjustedIndices;
      if (segment === segments[0]) {
        adjustedLabels.unshift(star);
      }
      if (segment === segments.at(-1)) {
        adjustedLabels.push(star);
      }
      unmapped = ctcViterbiAlign(segment.emissions, adjustedLabels, blankId, star, STAR_SCORE);
    }
    const segmentAlignments = unmapped.map((a) => ({
      ...a,
      startFrame: a.startFrame + segment.emissionsStart,
      endFrame: a.endFrame + segment.emissionsStart
    }));
    inputIndices.push(...indices.map((i) => i + segment.labelsStart));
    alignmentsWithRemovals.push(...segmentAlignments);
  }
  const alignments = [];
  for (const [k, a] of enumerate(alignmentsWithRemovals.slice(1, -1))) {
    const i = inputIndices[k];
    const lastUndroppedIndex = alignments.length - 1;
    const lastUndropped = alignments[lastUndroppedIndex] ?? {
      startFrame: 0,
      endFrame: 0,
      score: -Infinity,
      label: star
    };
    for (const j of range(lastUndroppedIndex, i - 1)) {
      alignments.push({
        startFrame: lastUndropped.endFrame,
        endFrame: lastUndropped.endFrame,
        score: -Infinity,
        label: vocab.get(baseline[j])
      });
    }
    alignments[i] = a;
  }
  return alignments;
}

// ../tools/stalign/node_modules/@storyteller-platform/align/dist/align/ctc/greedyDecode.js
function argmax(values, offset, length) {
  let best = 0;
  for (let i = 1; i < length; i++) {
    if (values[offset + i] > values[offset + best])
      best = i;
  }
  return best;
}
async function ctcGreedyDecode(emissionsReader) {
  const charByToken = /* @__PURE__ */ new Map();
  for (const [char, id] of emissionsReader.vocab.entries()) {
    if (id !== emissionsReader.blankId && char.length === 1 && char !== "|") {
      charByToken.set(id, char);
    }
  }
  const chars = [];
  const frames = [];
  let previous = -1;
  let t = 0;
  for await (const { values, frames: count2, classes } of emissionsReader.blocks()) {
    for (let f = 0; f < count2; f++) {
      const best = argmax(values, f * classes, classes);
      if (best !== previous) {
        const char = charByToken.get(best);
        if (char !== void 0) {
          chars.push(char);
          frames.push(t);
        }
      }
      previous = best;
      t++;
    }
  }
  return { text: chars.join(""), frames };
}

// ../tools/stalign/node_modules/@storyteller-platform/align/dist/align/ctc/search.js
var NGRAM_SIZE = 10;
var RANSAC_ITERATIONS = 500;
var MIN_INLIERS = 10;
var MAX_PAIR_SEPARATION_REQUIREMENT = 200;
var MIN_CONFIDENCE = 0.5;
var MIN_COVERAGE = 0.3;
var REFINE_COUNT = 25;
var ANCHOR_SPACING = 2e3;
var BOUNDARY_PAD_FRAMES = 500;
var EVIDENCE_GAP_MULTIPLIER = 3;
var EVIDENCE_GAP_FLOOR = 500;
var EVIDENCE_GAP_PERCENTILE = 0.99;
var MIN_EDGE_CLUSTER_OFFSETS = 10;
var EDGE_EXTENSION_MAX_GAP = 1e3;
var EDGE_EXTENSION_WINDOW = 250;
var EDGE_EXTENSION_PAIR_SEPARATION = 50;
var ANCHOR_CONTEXT = 40;
var ANCHOR_AGREEMENT_FRACTION = 0.4;
var ANCHOR_AGREEMENT_FLOOR = 0.05;
var ANCHOR_CALIBRATION_MINIMUM = 5;
var ngramIndexes = /* @__PURE__ */ new WeakMap();
var decodedEmissions = /* @__PURE__ */ new WeakMap();
function median(values) {
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function getNgramIndex(document) {
  const cached = ngramIndexes.get(document);
  if (cached)
    return cached;
  const { text, positions } = document;
  const index = /* @__PURE__ */ new Map();
  for (const i of range(text.length - NGRAM_SIZE + 1)) {
    const ngram = text.slice(i, i + NGRAM_SIZE);
    const position = positions[i];
    const entries = index.get(ngram);
    if (entries) {
      entries.push(position);
    } else {
      index.set(ngram, [position]);
    }
  }
  ngramIndexes.set(document, index);
  return index;
}
function collectMatches(query, document, excludedRanges) {
  const index = getNgramIndex(document);
  const queryNgramOffsets = /* @__PURE__ */ new Map();
  const matches = [];
  for (const i of range(query.length - NGRAM_SIZE + 1)) {
    const queryNgram = query.slice(i, i + NGRAM_SIZE);
    const offsets = queryNgramOffsets.get(queryNgram);
    if (offsets)
      offsets.push(i);
    else
      queryNgramOffsets.set(queryNgram, [i]);
    const positions = index.get(queryNgram);
    if (!positions)
      continue;
    for (const position of positions) {
      if (excludedRanges.some(([start, end]) => start <= position && position < end)) {
        continue;
      }
      matches.push({ offset: i, position });
    }
  }
  return { matches, queryNgramOffsets };
}
function fitLine(matches, pairSeparation, { minSlope, maxSlope, inlierTolerance }) {
  let seed = 625341585;
  const random = () => {
    seed = Math.imul(seed, 1103515245) + 12345 & 2147483647;
    return seed / 2147483648;
  };
  let best = null;
  for (let i = 0; i < RANSAC_ITERATIONS; i++) {
    const a = matches[Math.floor(random() * matches.length)];
    const b = matches[Math.floor(random() * matches.length)];
    if (Math.abs(b.offset - a.offset) < pairSeparation)
      continue;
    const slope2 = (b.position - a.position) / (b.offset - a.offset);
    if (slope2 < minSlope || slope2 > maxSlope)
      continue;
    const intercept2 = a.position - slope2 * a.offset;
    let count2 = 0;
    for (const m of matches) {
      const predicted = intercept2 + slope2 * m.offset;
      if (Math.abs(m.position - predicted) <= inlierTolerance)
        count2++;
    }
    if (!best || count2 > best.count) {
      best = { slope: slope2, intercept: intercept2, count: count2 };
    }
  }
  if (!best || best.count < MIN_INLIERS)
    return null;
  const inliers = matches.filter((m) => {
    const predicted = best.intercept + best.slope * m.offset;
    return Math.abs(m.position - predicted) <= inlierTolerance;
  });
  const sorted = inliers.sort((a, b) => a.offset - b.offset);
  const stride = Math.max(Math.floor(sorted.length / 2), 1);
  const slopes = [];
  for (let i = 0; i + stride < sorted.length; i++) {
    const lo = sorted[i];
    const hi = sorted[i + stride];
    if (hi.offset - lo.offset < pairSeparation)
      continue;
    slopes.push((hi.position - lo.position) / (hi.offset - lo.offset));
  }
  const slope = slopes.length ? median(slopes) : best.slope;
  const intercept = sorted.length ? median(sorted.map((m) => m.position - slope * m.offset)) : best.intercept;
  return {
    slope,
    intercept,
    inliers
  };
}
function bigramSimilarity(a, b) {
  if (a.length < 2 || b.length < 2)
    return 0;
  const bigrams = /* @__PURE__ */ new Map();
  for (const i of range(a.length - 1)) {
    const bigram = a.slice(i, i + 2);
    bigrams.set(bigram, (bigrams.get(bigram) ?? 0) + 1);
  }
  let shared = 0;
  for (const i of range(b.length - 1)) {
    const bigram = b.slice(i, i + 2);
    const remaining = bigrams.get(bigram) ?? 0;
    if (remaining > 0) {
      shared++;
      bigrams.set(bigram, remaining - 1);
    }
  }
  return shared / Math.max(a.length - 1, b.length - 1);
}
function positionToDocumentIndex(document, position) {
  const { positions } = document;
  let low = 0;
  let high = positions.length - 1;
  while (low < high) {
    const mid = low + high >> 1;
    if (positions[mid] < position)
      low = mid + 1;
    else
      high = mid;
  }
  return low;
}
function contextAgreement(match, query, document) {
  const index = positionToDocumentIndex(document, match.position);
  const queryLeft = query.slice(Math.max(0, match.offset - ANCHOR_CONTEXT), match.offset);
  const documentLeft = document.text.slice(Math.max(0, index - ANCHOR_CONTEXT), index);
  const queryRight = query.slice(match.offset + NGRAM_SIZE, match.offset + NGRAM_SIZE + ANCHOR_CONTEXT);
  const documentRight = document.text.slice(index + NGRAM_SIZE, index + NGRAM_SIZE + ANCHOR_CONTEXT);
  return Math.max(bigramSimilarity(queryLeft, documentLeft), bigramSimilarity(queryRight, documentRight));
}
function selectAnchors(query, inliers, queryNgramOffsets, document, slope, intercept) {
  const documentNgramIndex = getNgramIndex(document);
  const agreements = /* @__PURE__ */ new Map();
  const agreement = (match) => {
    let score = agreements.get(match);
    if (score === void 0) {
      score = contextAgreement(match, query, document);
      agreements.set(match, score);
    }
    return score;
  };
  const select = (minAgreement) => {
    const anchors2 = [];
    for (let i = 0; i < query.length; i += ANCHOR_SPACING) {
      const windowStart = Math.max(0, i - ANCHOR_SPACING / 2);
      const windowEnd = Math.min(query.length, i + ANCHOR_SPACING / 2);
      const candidates = inliers.filter(({ offset }) => windowStart <= offset && offset < windowEnd).sort(({ offset: a }, { offset: b }) => Math.abs(a - i) - Math.abs(b - i));
      for (const c of candidates) {
        const gram = query.slice(c.offset, c.offset + NGRAM_SIZE);
        if (documentNgramIndex.get(gram)?.length !== 1) {
          continue;
        }
        if (queryNgramOffsets.get(gram)?.length !== 1) {
          continue;
        }
        if (minAgreement !== null && agreement(c) < minAgreement) {
          continue;
        }
        anchors2.push(c);
        break;
      }
    }
    return anchors2;
  };
  let anchors = select(null);
  if (anchors.length >= ANCHOR_CALIBRATION_MINIMUM) {
    const threshold = Math.max(ANCHOR_AGREEMENT_FRACTION * median(anchors.map(agreement)), ANCHOR_AGREEMENT_FLOOR);
    anchors = select(threshold);
  }
  const monotonicAnchors = [];
  for (const a of anchors) {
    while (true) {
      const b = monotonicAnchors.at(-1);
      if (!b || a.position - b.position >= a.offset - b.offset) {
        monotonicAnchors.push(a);
        break;
      }
      const aDist = Math.abs(a.position - (intercept + slope * a.offset));
      const bDist = Math.abs(b.position - (intercept + slope * b.offset));
      if (aDist > bDist)
        break;
      else
        monotonicAnchors.pop();
    }
  }
  return monotonicAnchors;
}
function fitLocalLine(points, fallbackSlope) {
  const stride = Math.max(Math.floor(points.length / 2), 1);
  const slopes = [];
  for (const i of range(0, points.length - stride, stride)) {
    const lo = points[i];
    const hi = points[i + stride];
    if (hi.offset - lo.offset < EDGE_EXTENSION_PAIR_SEPARATION)
      continue;
    slopes.push((hi.position - lo.position) / (hi.offset - lo.offset));
  }
  const slope = slopes.length ? median(slopes) : fallbackSlope;
  const intercept = median(points.map((m) => m.position - slope * m.offset));
  return { slope, intercept };
}
function extendEdge(sortedMatches, sortedInliers, globalSlope, inlierTolerance) {
  const lastInlier = sortedInliers.at(-1);
  if (!lastInlier)
    return [];
  const window = sortedInliers.slice(-EDGE_EXTENSION_WINDOW);
  const accepted = [];
  let lastAcceptedOffset = lastInlier.offset;
  let local = fitLocalLine(window, globalSlope);
  for (const match of sortedMatches) {
    if (match.offset <= lastInlier.offset)
      continue;
    if (match.offset - lastAcceptedOffset > EDGE_EXTENSION_MAX_GAP)
      break;
    const predicted = local.intercept + local.slope * match.offset;
    if (Math.abs(match.position - predicted) > inlierTolerance)
      continue;
    accepted.push(match);
    window.push(match);
    if (window.length > EDGE_EXTENSION_WINDOW)
      window.shift();
    lastAcceptedOffset = match.offset;
    local = fitLocalLine(window, globalSlope);
  }
  return accepted;
}
function extendInlierEdges(matches, sortedInliers, slope, inlierTolerance) {
  const byOffset = matches.toSorted((a, b) => a.offset - b.offset);
  const tail = extendEdge(byOffset, sortedInliers, slope, inlierTolerance);
  function mirror(m) {
    return { offset: -m.offset, position: -m.position };
  }
  const head = extendEdge(byOffset.map(mirror).reverse(), sortedInliers.map(mirror).reverse(), slope, inlierTolerance).map(mirror).reverse();
  return [...head, ...sortedInliers, ...tail];
}
function computeEvidenceRange(offsets, queryLength) {
  if (offsets.length < 2) {
    return { evidenceRange: [0, queryLength], matchedRange: [0, queryLength] };
  }
  const gaps = [];
  for (let i = 1; i < offsets.length; i++) {
    gaps.push(offsets[i] - offsets[i - 1]);
  }
  const sortedGaps = gaps.toSorted((a, b) => a - b);
  const p99 = sortedGaps[Math.min(sortedGaps.length - 1, Math.floor(sortedGaps.length * EVIDENCE_GAP_PERCENTILE))];
  const threshold = Math.max(EVIDENCE_GAP_MULTIPLIER * p99, EVIDENCE_GAP_FLOOR);
  const clusters = [];
  let clusterStart = 0;
  for (const [i, gap] of enumerate(gaps, 1)) {
    if (gap <= threshold)
      continue;
    clusters.push([clusterStart, i - 1]);
    clusterStart = i;
  }
  clusters.push([clusterStart, offsets.length - 1]);
  let firstCluster = 0;
  let lastCluster = clusters.length - 1;
  while (firstCluster < lastCluster && clusters[firstCluster][1] - clusters[firstCluster][0] + 1 < MIN_EDGE_CLUSTER_OFFSETS) {
    firstCluster++;
  }
  while (lastCluster > firstCluster && clusters[lastCluster][1] - clusters[lastCluster][0] + 1 < MIN_EDGE_CLUSTER_OFFSETS) {
    lastCluster--;
  }
  const first = offsets[clusters[firstCluster][0]];
  const last = offsets[clusters[lastCluster][1]] + NGRAM_SIZE;
  return {
    matchedRange: [first, last],
    evidenceRange: [
      first > threshold ? first - threshold : 0,
      queryLength - last > threshold ? last + threshold : queryLength
    ]
  };
}
function findBoundariesInDocument(query, document, options) {
  const gramCount = Math.max(query.length - NGRAM_SIZE + 1, 0);
  const pairSeparation = Math.min(Math.max(Math.floor(gramCount / 4), 20), MAX_PAIR_SEPARATION_REQUIREMENT);
  const { matches, queryNgramOffsets } = collectMatches(query, document, options.excludedRanges);
  if (matches.length < MIN_INLIERS)
    return null;
  const line = fitLine(matches, pairSeparation, options);
  if (!line)
    return null;
  const { slope, intercept, inliers } = line;
  const byOffset = extendInlierEdges(matches, inliers.sort((a, b) => a.offset - b.offset), slope, options.inlierTolerance);
  const inlierOffsets = Array.from(new Set(byOffset.map(({ offset }) => offset)));
  const { evidenceRange, matchedRange } = computeEvidenceRange(inlierOffsets, query.length);
  const head = byOffset.slice(0, REFINE_COUNT);
  const tail = byOffset.slice(-REFINE_COUNT);
  const extrapolatedStart = Math.min(...head.map((m) => m.position - slope * m.offset));
  const extrapolatedEnd = Math.max(...tail.map((m) => m.position + slope * (query.length - m.offset)));
  const startPad = Math.max(
    BOUNDARY_PAD_FRAMES,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    0.25 * (head[0].position - extrapolatedStart)
  );
  const start = extrapolatedStart - startPad;
  const endPad = Math.max(
    BOUNDARY_PAD_FRAMES,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    0.25 * (extrapolatedEnd - tail.at(-1).position)
  );
  const end = extrapolatedEnd + endPad;
  if (end <= start)
    return null;
  const matchedGrams = new Set(matches.map((m) => m.offset)).size;
  const inlierGrams = inlierOffsets.length;
  const confidence = inlierGrams / matchedGrams;
  if (confidence < MIN_CONFIDENCE)
    return null;
  const first = byOffset[0];
  const last = byOffset[byOffset.length - 1];
  const coverage = (last.offset - first.offset + NGRAM_SIZE) / query.length;
  if (coverage < MIN_COVERAGE)
    return null;
  const anchors = selectAnchors(query, inliers, queryNgramOffsets, document, slope, intercept);
  return {
    start: Math.round(start),
    end: Math.round(end),
    confidence,
    anchors,
    evidenceRange,
    matchedRange
  };
}
async function findCtcBoundaries(query, emissionsReader, excludedRanges) {
  let document = decodedEmissions.get(emissionsReader);
  if (!document) {
    const { text, frames } = await ctcGreedyDecode(emissionsReader);
    document = { text, positions: frames };
    decodedEmissions.set(emissionsReader, document);
  }
  const result = findBoundariesInDocument(query, document, {
    excludedRanges,
    minSlope: 2,
    maxSlope: 15,
    inlierTolerance: query.length > 15e3 ? 5e3 : 2500
  });
  if (!result)
    return null;
  return {
    ...result,
    start: Math.max(result.start, 0),
    end: Math.min(result.end, emissionsReader.numFrames - 1)
  };
}

// ../tools/stalign/node_modules/@storyteller-platform/ghost-story/dist/emission/melFrontend.js
var HOP_SAMPLES = 160;
var PRE_EMPHASIS = 0.97;
var LOG_GUARD = 2 ** -24;
var STD_GUARD = 1e-5;
var MEL_LINEAR_HZ_PER_MEL = 200 / 3;
var MEL_LOG_START_HZ = 1e3;
var MEL_LOG_START = MEL_LOG_START_HZ / MEL_LINEAR_HZ_PER_MEL;
var MEL_LOG_STEP = Math.log(6.4) / 27;
function fftSizeFor(windowSamples) {
  return 2 ** Math.ceil(Math.log2(windowSamples));
}
function hzToMel(hz) {
  if (hz < MEL_LOG_START_HZ)
    return hz / MEL_LINEAR_HZ_PER_MEL;
  return MEL_LOG_START + Math.log(hz / MEL_LOG_START_HZ) / MEL_LOG_STEP;
}
function melToHz(mel) {
  if (mel < MEL_LOG_START)
    return mel * MEL_LINEAR_HZ_PER_MEL;
  return MEL_LOG_START_HZ * Math.exp(MEL_LOG_STEP * (mel - MEL_LOG_START));
}
function slaneyMelFilters(sampleRate, fftSize, melBins) {
  const bins = fftSize / 2 + 1;
  const maxMel = hzToMel(sampleRate / 2);
  const edges = Array.from({ length: melBins + 2 }, (_, i) => melToHz(maxMel * i / (melBins + 1)));
  const filters = new Float32Array(bins * melBins);
  for (let m = 0; m < melBins; m++) {
    const lower = edges[m];
    const centre = edges[m + 1];
    const upper = edges[m + 2];
    const norm = 2 / (upper - lower);
    for (let k = 0; k < bins; k++) {
      const hz = k * sampleRate / fftSize;
      const rising = (hz - lower) / (centre - lower);
      const falling = (upper - hz) / (upper - centre);
      const weight = Math.max(0, Math.min(rising, falling));
      filters[k * melBins + m] = weight * norm;
    }
  }
  return filters;
}
function hannWindow(windowSamples, fftSize) {
  const window = new Float32Array(fftSize);
  for (let n = 0; n < windowSamples; n++) {
    window[n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / windowSamples);
  }
  return window;
}
function createRfft(size) {
  const levels = Math.log2(size);
  if (!Number.isInteger(levels)) {
    throw new Error(`FFT size ${size} is not a power of two`);
  }
  const reversed = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++)
      r = r << 1 | i >> b & 1;
    reversed[i] = r;
  }
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let k = 0; k < size / 2; k++) {
    cos[k] = Math.cos(2 * Math.PI * k / size);
    sin[k] = -Math.sin(2 * Math.PI * k / size);
  }
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const power = new Float64Array(size / 2 + 1);
  return function powerSpectrum(input) {
    for (let i = 0; i < size; i++) {
      re[reversed[i]] = input[i];
      im[reversed[i]] = 0;
    }
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1;
      const step = size / len;
      for (let start = 0; start < size; start += len) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step];
          const wi = sin[k * step];
          const a = start + k;
          const b = a + half;
          const br = re[b];
          const bi = im[b];
          const tr = br * wr - bi * wi;
          const ti = br * wi + bi * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] = re[a] + tr;
          im[a] = im[a] + ti;
        }
      }
    }
    for (let k = 0; k <= size / 2; k++) {
      const r = re[k];
      const i = im[k];
      power[k] = r * r + i * i;
    }
    return power;
  };
}
var MelFrontend = class {
  fftSize;
  melBins;
  filters;
  window;
  powerSpectrum;
  constructor(config) {
    this.fftSize = fftSizeFor(config.windowSamples);
    this.melBins = config.melBins;
    this.filters = slaneyMelFilters(config.sampleRate, this.fftSize, config.melBins);
    this.window = hannWindow(config.windowSamples, this.fftSize);
    this.powerSpectrum = createRfft(this.fftSize);
  }
  get minSamples() {
    return this.fftSize * 4;
  }
  features(samples) {
    const pad = this.fftSize / 2;
    if (samples.length <= pad) {
      throw new Error(`Need more than ${pad} samples for mel features, got ${samples.length}`);
    }
    const padded = new Float32Array(samples.length + 2 * pad);
    padded[pad] = samples[0];
    for (let i = 1; i < samples.length; i++) {
      padded[pad + i] = samples[i] - PRE_EMPHASIS * samples[i - 1];
    }
    for (let j = 1; j <= pad; j++) {
      padded[pad - j] = padded[pad + j];
      padded[pad + samples.length - 1 + j] = padded[pad + samples.length - 1 - j];
    }
    const frames = 1 + Math.floor((padded.length - this.fftSize) / HOP_SAMPLES);
    const bins = this.fftSize / 2 + 1;
    const melBins = this.melBins;
    const frame = new Float64Array(this.fftSize);
    const values = new Float32Array(frames * melBins);
    const sum = new Float64Array(melBins);
    const sumSquares = new Float64Array(melBins);
    for (let f = 0; f < frames; f++) {
      const offset = f * HOP_SAMPLES;
      for (let i = 0; i < this.fftSize; i++) {
        frame[i] = padded[offset + i] * this.window[i];
      }
      const power = this.powerSpectrum(frame);
      for (let m = 0; m < melBins; m++) {
        let energy = 0;
        for (let k = 0; k < bins; k++) {
          energy += power[k] * this.filters[k * melBins + m];
        }
        const value = Math.log(energy + LOG_GUARD);
        values[f * melBins + m] = value;
        sum[m] = sum[m] + value;
        sumSquares[m] = sumSquares[m] + value * value;
      }
    }
    for (let m = 0; m < melBins; m++) {
      const mean = sum[m] / frames;
      const variance = frames > 1 ? (sumSquares[m] - frames * mean * mean) / (frames - 1) : 0;
      const scale = Math.sqrt(Math.max(variance, 0)) + STD_GUARD;
      for (let f = 0; f < frames; f++) {
        const index = f * melBins + m;
        values[index] = (values[index] - mean) / scale;
      }
    }
    return { values, frames, melBins };
  }
};

// node_modules/diff/libesm/diff/base.js
var Diff = class {
  diff(oldStr, newStr, options = {}) {
    let callback;
    if (typeof options === "function") {
      callback = options;
      options = {};
    } else if ("callback" in options) {
      callback = options.callback;
    }
    const oldString = this.castInput(oldStr, options);
    const newString = this.castInput(newStr, options);
    const oldTokens = this.removeEmpty(this.tokenize(oldString, options));
    const newTokens = this.removeEmpty(this.tokenize(newString, options));
    return this.diffWithOptionsObj(oldTokens, newTokens, options, callback);
  }
  diffWithOptionsObj(oldTokens, newTokens, options, callback) {
    var _a;
    const done = (value) => {
      value = this.postProcess(value, options);
      if (callback) {
        setTimeout(function() {
          callback(value);
        }, 0);
        return void 0;
      } else {
        return value;
      }
    };
    const newLen = newTokens.length, oldLen = oldTokens.length;
    let editLength = 1;
    let maxEditLength = newLen + oldLen;
    if (options.maxEditLength != null) {
      maxEditLength = Math.min(maxEditLength, options.maxEditLength);
    }
    const maxExecutionTime = (_a = options.timeout) !== null && _a !== void 0 ? _a : Infinity;
    const abortAfterTimestamp = Date.now() + maxExecutionTime;
    const bestPath = [{ oldPos: -1, lastComponent: void 0 }];
    let newPos = this.extractCommon(bestPath[0], newTokens, oldTokens, 0, options);
    if (bestPath[0].oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
      return done(this.buildValues(bestPath[0].lastComponent, newTokens, oldTokens));
    }
    let minDiagonalToConsider = -Infinity, maxDiagonalToConsider = Infinity;
    const execEditLength = () => {
      for (let diagonalPath = Math.max(minDiagonalToConsider, -editLength); diagonalPath <= Math.min(maxDiagonalToConsider, editLength); diagonalPath += 2) {
        let basePath;
        const removePath = bestPath[diagonalPath - 1], addPath = bestPath[diagonalPath + 1];
        if (removePath) {
          bestPath[diagonalPath - 1] = void 0;
        }
        let canAdd = false;
        if (addPath) {
          const addPathNewPos = addPath.oldPos - diagonalPath;
          canAdd = addPath && 0 <= addPathNewPos && addPathNewPos < newLen;
        }
        const canRemove = removePath && removePath.oldPos + 1 < oldLen;
        if (!canAdd && !canRemove) {
          bestPath[diagonalPath] = void 0;
          continue;
        }
        if (!canRemove || canAdd && removePath.oldPos < addPath.oldPos) {
          basePath = this.addToPath(addPath, true, false, 0, options);
        } else {
          basePath = this.addToPath(removePath, false, true, 1, options);
        }
        newPos = this.extractCommon(basePath, newTokens, oldTokens, diagonalPath, options);
        if (basePath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
          return done(this.buildValues(basePath.lastComponent, newTokens, oldTokens)) || true;
        } else {
          bestPath[diagonalPath] = basePath;
          if (basePath.oldPos + 1 >= oldLen) {
            maxDiagonalToConsider = Math.min(maxDiagonalToConsider, diagonalPath - 1);
          }
          if (newPos + 1 >= newLen) {
            minDiagonalToConsider = Math.max(minDiagonalToConsider, diagonalPath + 1);
          }
        }
      }
      editLength++;
    };
    if (callback) {
      (function exec() {
        setTimeout(function() {
          if (editLength > maxEditLength || Date.now() > abortAfterTimestamp) {
            return callback(void 0);
          }
          if (!execEditLength()) {
            exec();
          }
        }, 0);
      })();
    } else {
      while (editLength <= maxEditLength && Date.now() <= abortAfterTimestamp) {
        const ret = execEditLength();
        if (ret) {
          return ret;
        }
      }
    }
  }
  addToPath(path, added, removed, oldPosInc, options) {
    const last = path.lastComponent;
    if (last && !options.oneChangePerToken && last.added === added && last.removed === removed) {
      return {
        oldPos: path.oldPos + oldPosInc,
        lastComponent: { count: last.count + 1, added, removed, previousComponent: last.previousComponent }
      };
    } else {
      return {
        oldPos: path.oldPos + oldPosInc,
        lastComponent: { count: 1, added, removed, previousComponent: last }
      };
    }
  }
  extractCommon(basePath, newTokens, oldTokens, diagonalPath, options) {
    const newLen = newTokens.length, oldLen = oldTokens.length;
    let oldPos = basePath.oldPos, newPos = oldPos - diagonalPath, commonCount = 0;
    while (newPos + 1 < newLen && oldPos + 1 < oldLen && this.equals(oldTokens[oldPos + 1], newTokens[newPos + 1], options)) {
      newPos++;
      oldPos++;
      commonCount++;
      if (options.oneChangePerToken) {
        basePath.lastComponent = { count: 1, previousComponent: basePath.lastComponent, added: false, removed: false };
      }
    }
    if (commonCount && !options.oneChangePerToken) {
      basePath.lastComponent = { count: commonCount, previousComponent: basePath.lastComponent, added: false, removed: false };
    }
    basePath.oldPos = oldPos;
    return newPos;
  }
  equals(left, right, options) {
    if (options.comparator) {
      return options.comparator(left, right);
    } else {
      return left === right || !!options.ignoreCase && left.toLowerCase() === right.toLowerCase();
    }
  }
  removeEmpty(array) {
    const ret = [];
    for (let i = 0; i < array.length; i++) {
      if (array[i]) {
        ret.push(array[i]);
      }
    }
    return ret;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  castInput(value, options) {
    return value;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tokenize(value, options) {
    return Array.from(value);
  }
  join(chars) {
    return chars.join("");
  }
  postProcess(changeObjects, options) {
    return changeObjects;
  }
  get useLongestToken() {
    return false;
  }
  buildValues(lastComponent, newTokens, oldTokens) {
    const components = [];
    let nextComponent;
    while (lastComponent) {
      components.push(lastComponent);
      nextComponent = lastComponent.previousComponent;
      delete lastComponent.previousComponent;
      lastComponent = nextComponent;
    }
    components.reverse();
    const componentLen = components.length;
    let componentPos = 0, newPos = 0, oldPos = 0;
    for (; componentPos < componentLen; componentPos++) {
      const component = components[componentPos];
      if (!component.removed) {
        if (!component.added && this.useLongestToken) {
          let value = newTokens.slice(newPos, newPos + component.count);
          value = value.map(function(value2, i) {
            const oldValue = oldTokens[oldPos + i];
            return oldValue.length > value2.length ? oldValue : value2;
          });
          component.value = this.join(value);
        } else {
          component.value = this.join(newTokens.slice(newPos, newPos + component.count));
        }
        newPos += component.count;
        if (!component.added) {
          oldPos += component.count;
        }
      } else {
        component.value = this.join(oldTokens.slice(oldPos, oldPos + component.count));
        oldPos += component.count;
      }
    }
    return components;
  }
};

// node_modules/diff/libesm/diff/array.js
var ArrayDiff = class extends Diff {
  tokenize(value) {
    return value.slice();
  }
  join(value) {
    return value;
  }
  removeEmpty(value) {
    return value;
  }
};
var arrayDiff = new ArrayDiff();
function diffArrays(oldArr, newArr, options) {
  return arrayDiff.diff(oldArr, newArr, options);
}
export {
  MelFrontend,
  PRE_EMPHASIS,
  ctcForcedAlign,
  ctcGreedyDecode,
  detectDroppedLabels,
  diffArrays,
  findCtcBoundaries
};
/*! Bundled license information:

itertools/dist/index.js:
  (* istanbul ignore else -- @preserve *)
  (* istanbul ignore if -- @preserve *)
*/
