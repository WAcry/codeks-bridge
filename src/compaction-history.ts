type Item = Record<string, any>;
const isMessage = (item: Item): boolean => item.type === "message" || (!item.type && typeof item.role === "string");

/** Save source instructions and Lite declarations, without saving old conversation turns. */
export function splitCompactionPrefix(input: readonly Item[]): { prefix: Item[]; history: Item[] } {
  const prefix: Item[] = [];
  const history: Item[] = [];
  let leading = true;
  for (const item of input) {
    if (item.type === "additional_tools") {
      prefix.push(item);
    } else if (leading && isMessage(item) && ["system", "developer"].includes(item.role)) {
      prefix.push(item);
    } else {
      leading = false;
      history.push(item);
    }
  }
  return { prefix, history };
}
