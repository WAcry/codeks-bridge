import { isDeepStrictEqual } from 'node:util';

/** Compare unordered arrays as multisets; duplicate values still count. */
function sameAnswer(actual, expected, unordered) {
  if (!unordered) return isDeepStrictEqual(actual, expected);
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
  const remaining = [...actual];
  for (const value of expected) {
    const index = remaining.findIndex(candidate => isDeepStrictEqual(candidate, value));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
}

/** Score exact JSON values without turning missing answers into correct nulls. */
export function score(text, questions) {
  let parsed, parseError;
  try {
    parsed = JSON.parse(text.trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object');
  } catch (error) {
    parseError = error.message;
    parsed = {};
  }
  const group = () => ({ correct: 0, total: 0, accuracy: null });
  const result = {
    total: group(), known: group(), unknown: group(), by_category: Object.create(null),
    parse_error: parseError ?? null,
    unexpected_ids: Object.keys(parsed).filter(id => !questions.some(question => question.id === id)), answers: [],
  };
  for (const question of questions) {
    const present = Object.hasOwn(parsed, question.id);
    const correct = !parseError && present && sameAnswer(parsed[question.id], question.expected, question.unordered === true);
    const category = question.category ?? 'uncategorized';
    result.by_category[category] ??= group();
    for (const bucket of [result.total, question.expected === null ? result.unknown : result.known, result.by_category[category]]) {
      bucket.total++;
      bucket.correct += Number(correct);
      bucket.accuracy = bucket.correct / bucket.total;
    }
    result.answers.push({ id: question.id, category, correct, missing: !present,
      expected: question.expected, ...(present ? { actual: parsed[question.id] } : {}) });
  }
  return result;
}
