const { Point, Range } = require("lumine");
const SyntaxMatcher = require("./syntax-matcher");
const METHODS = new Set([
  "findMatchingEndBracket",
  "findMatchingStartBracket",
  "findPrecedingStartBracket",
  "findMatchingTagNameRangesWithSyntaxTree",
  "findMatchingTagsWithSyntaxTree",
  "findCurrentPair",
]);

exports.query = function (context, { method, args = [], position, pairs, inverse, regexes }) {
  const editor = {
    ...context,
    getTextInRange: context.getTextInBufferRange,
    getCursorBufferPosition: () => Point.fromObject(position),
  };
  const matcher = new SyntaxMatcher(editor, {
    pairedCharacters: pairs,
    pairedCharactersInverse: inverse,
    pairRegexes: regexes,
  });
  if (method === "pairAt") {
    editor.getCursorBufferPosition = () => Point.fromObject(args[0]);
    return matcher.findCurrentPair();
  }
  if (method === "state") {
    const pair = matcher.findCurrentPair();
    return {
      pair,
      tags:
        pair.position && pair.matchPosition
          ? {}
          : matcher.findMatchingTagNameRangesWithSyntaxTree(),
    };
  }
  if (method === "selections")
    return args[0].map((point) => {
      const position = Point.fromObject(point);
      let start = matcher.findPrecedingStartBracket(position);
      if (start) {
        const bracket = context.getTextInBufferRange(Range.fromPointWithDelta(start, 0, 1));
        const end = matcher.findMatchingEndBracket(start, bracket, pairs[bracket]);
        return end ? new Range(start.traverse([0, 1]), end) : null;
      }
      const { startRange, endRange } = matcher.findMatchingTagsWithSyntaxTree(true, position);
      return startRange ? new Range(startRange.end, endRange.start) : null;
    });
  if (!METHODS.has(method)) throw new Error(`Unknown bracket analysis: ${method}`);
  if (
    ["findMatchingEndBracket", "findMatchingStartBracket", "findPrecedingStartBracket"].includes(
      method,
    )
  )
    args[0] = Point.fromObject(args[0]);
  if (method === "findMatchingTagsWithSyntaxTree" && args[1]) args[1] = Point.fromObject(args[1]);
  return matcher[method](...args);
};

exports.interpolated = function (context, { position }) {
  const node = context.getSyntaxNodeAtBufferPosition(
    position,
    (node, grammar) =>
      grammar.scopeName === "source.ruby" &&
      /string|symbol/.test(node.type) &&
      Boolean(node.firstChild && ['"', ':"', "%("].includes(node.firstChild.text)),
  );
  return Boolean(node);
};

exports.interpolations = (context, { positions }) =>
  positions.map((position) => exports.interpolated(context, { position }));
