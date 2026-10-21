const { Range, Point } = require("lumine");
const { escapeRegExp } = require("./helpers");
const MAX_ROWS_TO_SCAN = 10000;
const ONE_CHAR_FORWARD_TRAVERSAL = Object.freeze(Point(0, 1));
const ONE_CHAR_BACKWARD_TRAVERSAL = Object.freeze(Point(0, -1));
const MAX_ROWS_TO_SCAN_FORWARD_TRAVERSAL = Object.freeze(Point(MAX_ROWS_TO_SCAN, 0));
const MAX_ROWS_TO_SCAN_BACKWARD_TRAVERSAL = Object.freeze(Point(-MAX_ROWS_TO_SCAN, 0));

function rangeForNode(node) {
  return Range.fromObject([node.startPosition, node.endPosition]);
}

class SyntaxMatcher {
  constructor(editor, matchManager) {
    this.editor = editor;
    this.matchManager = matchManager;
  }
  findMatchingEndBracket(startBracketPosition, startBracket, endBracket) {
    if (startBracket === endBracket) return;
    if (this.shouldScanTextForBrackets()) {
      return this.findMatchingEndBracketWithTextScan(
        startBracketPosition,
        startBracket,
        endBracket,
      );
    }
    return this.findMatchingEndBracketWithSyntaxTree(
      startBracketPosition,
      startBracket,
      endBracket,
    );
  }

  findMatchingStartBracket(endBracketPosition, startBracket, endBracket) {
    if (startBracket === endBracket) return;
    if (this.shouldScanTextForBrackets()) {
      return this.findMatchingStartBracketWithTextScan(
        endBracketPosition,
        startBracket,
        endBracket,
      );
    }
    return this.findMatchingStartBracketWithSyntaxTree(
      endBracketPosition,
      startBracket,
      endBracket,
    );
  }

  findMatchingEndBracketWithSyntaxTree(bracketPosition, startBracket, endBracket) {
    let result;
    const bracketEndPosition = bracketPosition.traverse([0, startBracket.length]);
    this.editor.getSyntaxNodeContainingBufferRange(
      new Range(bracketPosition, bracketEndPosition),
      (node) => {
        if (
          bracketEndPosition.isGreaterThan(node.startPosition) &&
          bracketEndPosition.isLessThan(node.endPosition)
        ) {
          const matchNode = node.children.find(
            (child) =>
              bracketEndPosition.isLessThanOrEqual(child.startPosition) &&
              child.type === endBracket,
          );
          if (matchNode) result = Point.fromObject(matchNode.startPosition);
          return true;
        }
      },
    );
    return result;
  }

  findMatchingStartBracketWithSyntaxTree(bracketPosition, startBracket, _endBracket) {
    let result;
    const bracketEndPosition = bracketPosition.traverse([0, startBracket.length]);
    this.editor.getSyntaxNodeContainingBufferRange(
      new Range(bracketPosition, bracketEndPosition),
      (node) => {
        if (bracketPosition.isGreaterThan(node.startPosition)) {
          const matchNode = node.children.find(
            (child) =>
              bracketPosition.isGreaterThanOrEqual(child.endPosition) &&
              child.type === startBracket,
          );
          if (matchNode) result = Point.fromObject(matchNode.startPosition);
          return true;
        }
      },
    );
    return result;
  }

  shouldScanTextForBrackets() {
    const scopeName = this.editor.getGrammar()?.scopeName;
    return scopeName === "text.plain" || scopeName === "text.plain.null-grammar";
  }

  findMatchingEndBracketWithTextScan(startBracketPosition, startBracket, endBracket) {
    const pairRegex = this.matchManager.pairRegexes[startBracket];
    if (!pairRegex) return;
    const scanRange = new Range(
      startBracketPosition.traverse(ONE_CHAR_FORWARD_TRAVERSAL),
      startBracketPosition.traverse(MAX_ROWS_TO_SCAN_FORWARD_TRAVERSAL),
    );
    let endBracketPosition = null;
    let nestedPairCount = 0;
    this.editor.scanInBufferRange(pairRegex, scanRange, (result) => {
      if (result.match[0] === startBracket) {
        nestedPairCount++;
      } else if (result.match[0] === endBracket) {
        if (nestedPairCount === 0) {
          endBracketPosition = result.range.start;
          result.stop();
        } else {
          nestedPairCount--;
        }
      }
    });
    return endBracketPosition;
  }

  findMatchingStartBracketWithTextScan(endBracketPosition, startBracket, endBracket) {
    const pairRegex = this.matchManager.pairRegexes[startBracket];
    if (!pairRegex) return;
    const scanRange = new Range(
      endBracketPosition.traverse(MAX_ROWS_TO_SCAN_BACKWARD_TRAVERSAL),
      endBracketPosition,
    );
    let startBracketPosition = null;
    let nestedPairCount = 0;
    this.editor.backwardsScanInBufferRange(pairRegex, scanRange, (result) => {
      if (result.match[0] === endBracket) {
        nestedPairCount++;
      } else if (result.match[0] === startBracket) {
        if (nestedPairCount === 0) {
          startBracketPosition = result.range.start;
          result.stop();
        } else {
          nestedPairCount--;
        }
      }
    });
    return startBracketPosition;
  }

  findMatchingTagNameRangesWithSyntaxTree() {
    const position = this.editor.getCursorBufferPosition();
    const { startTag, endTag } = this.findContainingTagsWithSyntaxTree(position);
    if (
      startTag &&
      (rangeForNode(startTag).containsPoint(position) ||
        rangeForNode(endTag).containsPoint(position))
    ) {
      if (startTag === endTag) {
        const range = rangeForNode(startTag.child(1));
        return { startRange: range, endRange: range };
      } else if (endTag.firstChild.type === "</") {
        return {
          startRange: rangeForNode(startTag.child(1)),
          endRange: rangeForNode(endTag.child(1)),
        };
      } else {
        return {
          startRange: rangeForNode(startTag.child(1)),
          endRange: rangeForNode(endTag.child(2)),
        };
      }
    } else {
      return {};
    }
  }

  // `fullRange` spans the whole tag, delimiters included, while the default
  // spans only the tag name. Without that distinction `go-to-enclosing-bracket`
  // would put the cursor on the `<` rather than on the name.
  findMatchingTagsWithSyntaxTree(
    fullRange = false,
    position = this.editor.getCursorBufferPosition(),
  ) {
    const { startTag, endTag } = this.findContainingTagsWithSyntaxTree(position);
    if (!startTag) return {};

    if (fullRange) {
      return { startRange: rangeForNode(startTag), endRange: rangeForNode(endTag) };
    }

    // Child 1 is the tag name, so this skips the `<` — which is the difference
    // between the two. It cannot delegate to
    // findMatchingTagNameRangesWithSyntaxTree: that one first requires the
    // cursor to be inside one of the two tags, and the caller that wants name
    // ranges here is `go-to-enclosing-bracket`, which runs with the cursor in
    // the element's content, between them.
    return {
      startRange: rangeForNode(startTag.child(1)),
      endRange: rangeForNode(endTag.child(1)),
    };
  }

  findContainingTagsWithSyntaxTree(position) {
    let startTag, endTag;
    // Step back one column without mutating the caller-owned point.
    if (position.column === this.editor.buffer.lineLengthForRow(position.row))
      position = position.traverse([0, -1]);
    this.editor.getSyntaxNodeAtBufferPosition(position, (node) => {
      if (node.type.includes("element") && node.childCount > 0) {
        const { firstChild, lastChild } = node;
        if (firstChild.childCount > 2 && firstChild.firstChild.type === "<") {
          if (lastChild.id === firstChild.id && firstChild.lastChild.type === "/>") {
            startTag = firstChild;
            endTag = firstChild;
          } else if (
            lastChild.childCount > 2 &&
            (lastChild.firstChild.type === "</" ||
              (lastChild.firstChild.type === "<" && lastChild.child(1).type === "/"))
          ) {
            startTag = firstChild;
            endTag = lastChild;
          }
          return true;
        }
      }
    });
    return { startTag, endTag };
  }

  findPrecedingStartBracket(cursorPosition) {
    if (this.shouldScanTextForBrackets()) {
      return this.findPrecedingStartBracketWithTextScan(cursorPosition);
    }
    return this.findPrecedingStartBracketWithSyntaxTree(cursorPosition);
  }

  findPrecedingStartBracketWithSyntaxTree(cursorPosition) {
    let result;
    this.editor.getSyntaxNodeAtBufferPosition(cursorPosition, (node) => {
      for (const child of node.children) {
        if (cursorPosition.isLessThanOrEqual(child.startPosition)) break;
        if (
          child.type in this.matchManager.pairedCharacters ||
          child.type in this.matchManager.pairedCharactersInverse
        ) {
          result = Point.fromObject(child.startPosition);
          return true;
        }
      }
    });
    return result;
  }

  findPrecedingStartBracketWithTextScan(cursorPosition) {
    const startBrackets = Object.keys(this.matchManager.pairedCharacters).filter(
      (start) => this.matchManager.pairedCharacters[start] !== start,
    );
    const endBrackets = Object.keys(this.matchManager.pairedCharactersInverse).filter(
      (end) => this.matchManager.pairedCharactersInverse[end] !== end,
    );
    if (startBrackets.length === 0 || endBrackets.length === 0) return;
    const combinedRegExp = new RegExp(
      `[${escapeRegExp(startBrackets.join("") + endBrackets.join(""))}]`,
      "g",
    );
    const scanRange = new Range(
      cursorPosition.traverse(MAX_ROWS_TO_SCAN_BACKWARD_TRAVERSAL),
      cursorPosition,
    );
    const expectedStartBrackets = [];
    let startPosition = null;
    this.editor.backwardsScanInBufferRange(combinedRegExp, scanRange, (result) => {
      const character = result.match[0];
      const expectedStart = this.matchManager.pairedCharactersInverse[character];
      if (expectedStart && expectedStart !== character) {
        expectedStartBrackets.push(expectedStart);
        return;
      }
      if (!Object.hasOwn(this.matchManager.pairedCharacters, character)) return;
      if (expectedStartBrackets.length === 0) {
        startPosition = result.range.start;
        result.stop();
      } else if (expectedStartBrackets.at(-1) === character) {
        expectedStartBrackets.pop();
      }
    });
    return startPosition;
  }

  findCurrentPair() {
    const currentPosition = this.editor.getCursorBufferPosition();
    const previousPosition = currentPosition.traverse(ONE_CHAR_BACKWARD_TRAVERSAL);
    const nextPosition = currentPosition.traverse(ONE_CHAR_FORWARD_TRAVERSAL);
    const currentCharacter = this.editor.getTextInBufferRange(
      new Range(currentPosition, nextPosition),
    );
    const previousCharacter = this.editor.getTextInBufferRange(
      new Range(previousPosition, currentPosition),
    );

    let position, matchPosition, currentBracket, matchingBracket;
    if ((matchingBracket = this.matchManager.pairedCharacters[currentCharacter])) {
      position = currentPosition;
      currentBracket = currentCharacter;
      matchPosition = this.findMatchingEndBracket(position, currentBracket, matchingBracket);
    } else if ((matchingBracket = this.matchManager.pairedCharacters[previousCharacter])) {
      position = previousPosition;
      currentBracket = previousCharacter;
      matchPosition = this.findMatchingEndBracket(position, currentBracket, matchingBracket);
    } else if ((matchingBracket = this.matchManager.pairedCharactersInverse[previousCharacter])) {
      position = previousPosition;
      currentBracket = previousCharacter;
      matchPosition = this.findMatchingStartBracket(position, matchingBracket, currentBracket);
    } else if ((matchingBracket = this.matchManager.pairedCharactersInverse[currentCharacter])) {
      position = currentPosition;
      currentBracket = currentCharacter;
      matchPosition = this.findMatchingStartBracket(position, matchingBracket, currentBracket);
    }

    return { position, matchPosition, bracket: currentBracket };
  }
}
module.exports = SyntaxMatcher;
