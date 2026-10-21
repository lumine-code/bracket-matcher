const { CompositeDisposable, Emitter, Range, Point } = require("lumine");
const SyntaxMatcher = require("./syntax-matcher");
const TagFinder = require("./tag-finder");

const ONE_CHAR_FORWARD_TRAVERSAL = Object.freeze(Point(0, 1));
const ONE_CHAR_BACKWARD_TRAVERSAL = Object.freeze(Point(0, -1));
const TWO_CHARS_BACKWARD_TRAVERSAL = Object.freeze(Point(0, -2));

function revive(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(revive);
  if ("row" in value && "column" in value) return Point.fromObject(value);
  if ("start" in value && "end" in value) return Range.fromObject(value);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]));
}

module.exports = class BracketMatcherView {
  constructor(editor, editorElement, matchManager) {
    this.destroy = this.destroy.bind(this);
    this.updateMatch = this.updateMatch.bind(this);
    this.editor = editor;
    this.matchManager = matchManager;
    this.gutter = this.editor.gutterWithName("line-number");
    this.subscriptions = new CompositeDisposable();
    this.emitter = new Emitter();
    this.tagFinder = new TagFinder(this.editor);
    this.pairHighlighted = false;
    this.tagHighlighted = false;

    // ranges for possible selection
    this.bracket1Range = null;
    this.bracket2Range = null;

    this.subscriptions.add(
      this.editor.onDidTokenize(this.updateMatch),
      this.editor.getBuffer().onDidChangeText(this.updateMatch),
      this.editor.onDidChangeGrammar(() => {
        this.observeLanguageMode();
        this.updateMatch();
      }),
      this.editor.onDidChangeSelectionRange(({ selection }) => {
        if (selection === this.editor.getLastSelection()) this.updateMatch();
      }),
      this.editor.onDidAddCursor(this.updateMatch),
      this.editor.onDidRemoveCursor(this.updateMatch),

      this.editor.onDidDestroy(this.destroy),
    );

    this.observeLanguageMode();
    this.updateMatch();
  }

  observeLanguageMode() {
    this.languageModeSubscription?.dispose();
    // onDidTokenize only signals the initial parse. An incremental parse with
    // injections can publish after text/selection callbacks have already run.
    this.languageModeSubscription = this.editor
      .getBuffer()
      .getLanguageMode()
      .onDidChangeHighlighting(this.updateMatch);
  }

  destroy() {
    this.destroyed = true;
    this.matchController?.abort();
    this.languageModeSubscription?.dispose();
    for (const marker of new Set([this.startMarker, this.endMarker])) marker?.destroy();
    this.startMarker = null;
    this.endMarker = null;
    this.pairHighlighted = false;
    this.tagHighlighted = false;
    this.subscriptions.dispose();
    this.emitter.dispose();
  }

  // Public: Invoke the given callback whenever the highlighted match changes,
  // including when it clears. Consumed through the `bracket-matcher` service.
  onDidChangeMatch(callback) {
    return this.emitter.on("did-change-match", callback);
  }

  updateMatch() {
    this.matchController?.abort();
    const controller = (this.matchController = new AbortController());
    if (this.destroyed) return;
    if (this.editor.getBuffer().getLanguageMode().asynchronousSyntax) {
      this.clearMatch();
      if (!this.editor.getLastSelection().isEmpty()) {
        this.emitter.emit("did-change-match");
        return;
      }
      const promise = this.querySyntax("state", [], controller.signal).then((state) => {
        if (state && !controller.signal.aborted && !this.destroyed) this.applyMatch(state);
      });
      this.matchPromise = promise;
      void promise.catch((error) => {
        if (!controller.signal.aborted && !this.destroyed)
          console.error("Unable to update bracket match", error);
      });
      return promise;
    }
    this.clearMatch();
    if (!this.editor.getLastSelection().isEmpty()) {
      this.emitter.emit("did-change-match");
      return;
    }
    const pair = this.findCurrentPair();
    return this.applyMatch({
      pair,
      tags:
        pair.position && pair.matchPosition ? {} : this.findMatchingTagNameRangesWithSyntaxTree(),
    });
  }

  clearMatch() {
    if (this.pairHighlighted) {
      this.editor.destroyMarker(this.startMarker.id);
      this.editor.destroyMarker(this.endMarker.id);
    }

    this.pairHighlighted = false;
    this.tagHighlighted = false;
    this.bracket1Range = this.bracket2Range = null;
  }

  applyMatch({ pair: { position, matchPosition }, tags }) {
    let startRange;
    let endRange;
    let highlightTag = false;
    let highlightPair = false;
    if (position && matchPosition) {
      this.bracket1Range = startRange = Range(
        position,
        position.traverse(ONE_CHAR_FORWARD_TRAVERSAL),
      );
      this.bracket2Range = endRange = Range(
        matchPosition,
        matchPosition.traverse(ONE_CHAR_FORWARD_TRAVERSAL),
      );
      highlightPair = true;
    } else {
      this.bracket1Range = null;
      this.bracket2Range = null;
      ({ startRange, endRange } = tags);
      if (startRange) {
        highlightTag = true;
        highlightPair = true;
      }
    }

    if (!highlightTag && !highlightPair) {
      this.emitter.emit("did-change-match");
      return;
    }

    this.startMarker = this.createMarker(startRange);
    this.endMarker = this.createMarker(endRange);
    this.pairHighlighted = highlightPair;
    this.tagHighlighted = highlightTag;
    this.emitter.emit("did-change-match");
  }

  querySyntax(method, args, signal) {
    if (!this.editor.getBuffer().getLanguageMode().asynchronousSyntax)
      return new SyntaxMatcher(this.editor, this.matchManager)[method](...args);
    return this.editor
      .analyzeSyntax(
        require.resolve("./syntax-analysis"),
        "query",
        {
          method,
          args,
          position: this.editor.getCursorBufferPosition(),
          pairs: this.matchManager.pairedCharacters,
          inverse: this.matchManager.pairedCharactersInverse,
          regexes: this.matchManager.pairRegexes,
        },
        { signal },
      )
      .then(revive);
  }

  selectMatchingBrackets(prepared = false) {
    if (this.editor.getBuffer().getLanguageMode().asynchronousSyntax && !prepared)
      return this.withCurrentResult(this.updateMatch(), () => this.selectMatchingBrackets(true));
    if (!this.pairHighlighted) return;
    if (!this.bracket1Range && !this.bracket2Range) return;
    this.editor.setSelectedBufferRanges([this.bracket1Range, this.bracket2Range]);
    this.matchManager.changeBracketsMode = true;
  }

  removeMatchingBrackets(preparedPair) {
    if (this.editor.hasMultipleCursors()) {
      this.editor.backspace();
      return;
    }
    if (this.editor.getBuffer().getLanguageMode().asynchronousSyntax && !preparedPair) {
      const position = this.editor.getLastSelection().getBufferRange().end;
      return this.withCurrentResult(this.querySyntax("pairAt", [position]), (pair) =>
        this.removeMatchingBrackets(pair),
      );
    }

    this.editor.transact(() => {
      if (this.editor.getLastSelection().isEmpty()) {
        this.editor.selectLeft();
      }

      const text = this.editor.getSelectedText();
      this.editor.moveRight();

      // check if the character to the left is part of a pair
      if (
        Object.hasOwn(this.matchManager.pairedCharacters, text) ||
        Object.hasOwn(this.matchManager.pairedCharactersInverse, text)
      ) {
        let { position, matchPosition, bracket } = preparedPair ?? this.findCurrentPair();

        if (position && matchPosition) {
          this.editor.setCursorBufferPosition(matchPosition);
          this.editor.delete();
          // if on the same line and the cursor is in front of an end pair
          // offset by one to make up for the missing character
          if (
            position.row === matchPosition.row &&
            Object.hasOwn(this.matchManager.pairedCharactersInverse, bracket)
          ) {
            position = position.traverse(ONE_CHAR_BACKWARD_TRAVERSAL);
          }
          this.editor.setCursorBufferPosition(position);
          this.editor.delete();
        } else {
          this.editor.backspace();
        }
      } else {
        this.editor.backspace();
      }
    });
  }

  findMatchingEndBracket(...args) {
    return this.querySyntax("findMatchingEndBracket", args);
  }
  findMatchingStartBracket(...args) {
    return this.querySyntax("findMatchingStartBracket", args);
  }
  findPrecedingStartBracket(...args) {
    return this.querySyntax("findPrecedingStartBracket", args);
  }
  findMatchingTagNameRangesWithSyntaxTree(...args) {
    return this.querySyntax("findMatchingTagNameRangesWithSyntaxTree", args);
  }
  findMatchingTagsWithSyntaxTree(...args) {
    return this.querySyntax("findMatchingTagsWithSyntaxTree", args);
  }
  findCurrentPair(...args) {
    return this.querySyntax("findCurrentPair", args);
  }

  createMarker(bufferRange) {
    const marker = this.editor.markBufferRange(bufferRange);
    this.editor.decorateMarker(marker, {
      // Keep the highlight type for API compatibility, but decorate the text
      // too so the underline follows the font baseline in tall mini editors.
      type: ["highlight", "text"],
      class: "bracket-matcher",
      deprecatedRegionClass: "bracket-matcher",
    });
    if (
      lumine.config.get("bracket-matcher.highlightMatchingLineNumber", {
        scope: this.editor.getRootScopeDescriptor(),
      }) &&
      this.gutter
    ) {
      this.gutter.decorateMarker(marker, {
        type: "highlight",
        class: "bracket-matcher",
        deprecatedRegionClass: "bracket-matcher",
      });
    }
    return marker;
  }

  goToMatchingBracket(prepared = false) {
    if (this.editor.getBuffer().getLanguageMode().asynchronousSyntax && !prepared)
      return this.withCurrentResult(this.updateMatch(), () => this.goToMatchingBracket(true));
    if (!this.pairHighlighted) return this.gotoPrecedingStartBracket();
    const position = this.editor.getCursorBufferPosition();

    if (this.tagHighlighted) {
      let tagCharacterOffset;
      let startRange = this.startMarker.getBufferRange();
      const tagLength = startRange.end.column - startRange.start.column;
      let endRange = this.endMarker.getBufferRange();
      if (startRange.compare(endRange) > 0) {
        [startRange, endRange] = [endRange, startRange];
      }

      // include the <
      startRange = new Range(
        startRange.start.traverse(ONE_CHAR_BACKWARD_TRAVERSAL),
        endRange.end.traverse(ONE_CHAR_BACKWARD_TRAVERSAL),
      );
      // include the </
      endRange = new Range(
        endRange.start.traverse(TWO_CHARS_BACKWARD_TRAVERSAL),
        endRange.end.traverse(TWO_CHARS_BACKWARD_TRAVERSAL),
      );

      if (position.isLessThan(endRange.start)) {
        tagCharacterOffset = position.column - startRange.start.column;
        if (tagCharacterOffset > 0) {
          tagCharacterOffset++;
        }
        tagCharacterOffset = Math.min(tagCharacterOffset, tagLength + 2); // include </
        this.editor.setCursorBufferPosition(endRange.start.traverse([0, tagCharacterOffset]), {
          mode: "zone",
        });
      } else {
        tagCharacterOffset = position.column - endRange.start.column;
        if (tagCharacterOffset > 1) {
          tagCharacterOffset--;
        }
        tagCharacterOffset = Math.min(tagCharacterOffset, tagLength + 1); // include <
        this.editor.setCursorBufferPosition(startRange.start.traverse([0, tagCharacterOffset]), {
          mode: "zone",
        });
      }
    } else {
      const previousPosition = position.traverse(ONE_CHAR_BACKWARD_TRAVERSAL);
      const startPosition = this.startMarker.getStartBufferPosition();
      const endPosition = this.endMarker.getStartBufferPosition();

      if (position.isEqual(startPosition)) {
        this.editor.setCursorBufferPosition(endPosition.traverse(ONE_CHAR_FORWARD_TRAVERSAL), {
          mode: "zone",
        });
      } else if (previousPosition.isEqual(startPosition)) {
        this.editor.setCursorBufferPosition(endPosition, { mode: "zone" });
      } else if (position.isEqual(endPosition)) {
        this.editor.setCursorBufferPosition(startPosition.traverse(ONE_CHAR_FORWARD_TRAVERSAL), {
          mode: "zone",
        });
      } else if (previousPosition.isEqual(endPosition)) {
        this.editor.setCursorBufferPosition(startPosition, { mode: "zone" });
      }
    }
  }

  gotoPrecedingStartBracket() {
    if (this.pairHighlighted) return;

    const result = this.findPrecedingStartBracket(this.editor.getCursorBufferPosition());
    return this.withCurrentResult(result, (matchPosition) => {
      if (matchPosition) {
        this.editor.setCursorBufferPosition(matchPosition, { mode: "zone" });
      } else {
        return this.withCurrentResult(
          this.findMatchingTagsWithSyntaxTree(),
          ({ startRange, endRange }) => {
            if (startRange) {
              if (startRange.compare(endRange) > 0) {
                startRange = endRange;
              }
              this.editor.setCursorBufferPosition(startRange.start, { mode: "zone" });
            }
          },
        );
      }
    });
  }

  multiCursorSelect() {
    if (this.editor.getBuffer().getLanguageMode().asynchronousSyntax)
      return this.withCurrentResult(
        this.querySyntax("selections", [this.editor.getCursorBufferPositions()]),
        (ranges) => {
          this.editor.mergeIntersectingSelections(() => {
            for (const range of ranges) if (range) this.editor.addSelectionForBufferRange(range);
          });
        },
      );
    this.editor.getCursorBufferPositions().forEach((position) => {
      let startPosition = this.findPrecedingStartBracket(position);
      if (startPosition) {
        const startBracket = this.editor.getTextInRange(
          Range.fromPointWithDelta(startPosition, 0, 1),
        );
        const endPosition = this.findMatchingEndBracket(
          startPosition,
          startBracket,
          this.matchManager.pairedCharacters[startBracket],
        );
        startPosition = startPosition.traverse([0, 1]);
        if (startPosition && endPosition) {
          const rangeToSelect = new Range(startPosition, endPosition);
          this.editor.addSelectionForBufferRange(rangeToSelect);
        }
      } else {
        let startRange, endRange;
        ({ startRange, endRange } = this.findMatchingTagsWithSyntaxTree(true, position));
        if (startRange) {
          const startPosition = startRange.end;
          const endPosition = endRange.start;
          const rangeToSelect = new Range(startPosition, endPosition);
          this.editor.addSelectionForBufferRange(rangeToSelect);
        }
      }
    });
  }

  selectInsideBrackets(prepared = false) {
    if (this.editor.getBuffer().getLanguageMode().asynchronousSyntax && !prepared)
      return this.withCurrentResult(this.updateMatch(), () => this.selectInsideBrackets(true));
    let endPosition, endRange, startPosition, startRange;
    if (this.pairHighlighted) {
      startRange = this.startMarker.getBufferRange();
      endRange = this.endMarker.getBufferRange();

      if (this.tagHighlighted) {
        return this.withCurrentResult(
          this.findMatchingTagsWithSyntaxTree(true),
          ({ startRange, endRange }) => {
            if (startRange && endRange)
              this.editor.setSelectedBufferRange(new Range(startRange.end, endRange.start));
          },
        );
      }
      if (startRange.compare(endRange) > 0) [startRange, endRange] = [endRange, startRange];
      startPosition = startRange.end;
      endPosition = endRange.start;

      const rangeToSelect = new Range(startPosition, endPosition);
      this.editor.setSelectedBufferRange(rangeToSelect);
    } else {
      return this.multiCursorSelect();
    }
  }

  withCurrentResult(result, apply) {
    if (!result?.then) return apply(result);
    const revision = this.editor.getBuffer().getTextRevision();
    const mode = this.editor.getBuffer().getLanguageMode();
    const ranges = this.editor.getSelectedBufferRanges();
    const pairs = this.matchManager.pairedCharacters;
    return result.then((value) => {
      if (
        value === null ||
        this.destroyed ||
        this.editor.isDestroyed() ||
        revision !== this.editor.getBuffer().getTextRevision() ||
        mode !== this.editor.getBuffer().getLanguageMode() ||
        pairs !== this.matchManager.pairedCharacters
      )
        return;
      const selected = this.editor.getSelectedBufferRanges();
      if (
        selected.length !== ranges.length ||
        selected.some((range, i) => !range.isEqual(ranges[i]))
      )
        return;
      return apply(value);
    });
  }

  // Insert at the current cursor position a closing tag if there exists an
  // open tag that is not closed afterwards.
  closeTag() {
    const cursorPosition = this.editor.getCursorBufferPosition();
    const preFragment = this.editor.getTextInBufferRange([Point.ZERO, cursorPosition]);
    const postFragment = this.editor.getTextInBufferRange([cursorPosition, Point.INFINITY]);

    const tag = this.tagFinder.closingTagForFragments(preFragment, postFragment);
    if (tag) {
      this.editor.insertText(`</${tag}>`);
    }
  }
};
