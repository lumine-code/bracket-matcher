const { CompositeDisposable, Emitter, Range, Point } = require("lumine");
const SyntaxMatcher = require("./syntax-matcher");
const { syntaxUnavailable } = require("./helpers");
const { bracketSelectionText } = require("./text-source");

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
    this.pairHighlighted = false;
    this.tagHighlighted = false;

    // ranges for possible selection
    this.bracket1Range = null;
    this.bracket2Range = null;

    this.subscriptions.add(
      this.editor.onDidTokenize(this.updateMatch),
      this.editor.getBuffer().onDidChangeText(this.updateMatch),
      this.editor.onDidChangeGrammar(() => {
        if (this.observeLanguageMode()) this.updateMatch();
      }),
      this.editor.onDidChangeSelectionRange(({ selection }) => {
        if (selection === this.editor.getLastSelection()) this.updateMatch();
      }),
      this.editor.onDidAddCursor(this.updateMatch),
      this.editor.onDidRemoveCursor(this.updateMatch),

      this.editor.onDidDestroy(this.destroy),
    );

    const syntaxSubscription = this.editor.onDidChangeSyntaxAvailability?.(() => {
      if (this.destroyed) return;
      if (this.observeLanguageMode()) this.updateMatch();
    });
    if (syntaxSubscription) this.subscriptions.add(syntaxSubscription);

    this.observeLanguageMode();
    this.updateMatch();
  }

  observeLanguageMode() {
    if (this.destroyed) return false;
    const mode = this.editor.getBuffer().getLanguageMode();
    if (this.observedLanguageMode === mode) return false;
    this.languageModeSubscription?.dispose();
    this.observedLanguageMode = mode;
    // onDidTokenize only signals the initial parse. An incremental parse with
    // injections can publish after text/selection callbacks have already run.
    this.languageModeSubscription = mode.onDidChangeHighlighting(this.updateMatch);
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.closeTagController?.abort();
    this.matchController?.abort();
    this.pendingMatchContext = null;
    this.matchPromise = null;
    this.languageModeSubscription?.dispose();
    this.clearMatch();
    this.subscriptions.dispose();
    this.emitter.dispose();
  }

  // Public: Invoke the given callback whenever the highlighted match changes,
  // including when it clears. Consumed through the `bracket-matcher` service.
  onDidChangeMatch(callback) {
    return this.emitter.on("did-change-match", callback);
  }

  updateMatch() {
    if (this.destroyed) return;
    if (syntaxUnavailable(this.editor)) {
      this.matchController?.abort();
      this.pendingMatchContext = null;
      this.matchPromise = null;
      if (this.clearMatch()) this.emitter.emit("did-change-match");
      return;
    }
    const context = this.captureMatchContext();
    if (
      this.matchPromise &&
      !this.matchController?.signal.aborted &&
      this.matchesContext(this.pendingMatchContext, context)
    )
      return this.matchPromise;
    this.matchController?.abort();
    this.pendingMatchContext = null;
    this.matchPromise = null;
    const controller = (this.matchController = new AbortController());
    if (this.editor.getBuffer().getLanguageMode().asynchronousSyntax) {
      // Highlight publications can repeat without changing the syntax request.
      // Keep a verified match painted while that same context is refreshed.
      if (
        (!this.matchesContext(this.paintedContext, context) ||
          this.startMarker?.isDestroyed() ||
          this.endMarker?.isDestroyed()) &&
        this.clearMatch()
      )
        this.emitter.emit("did-change-match");
      if (!this.editor.getLastSelection().isEmpty()) {
        this.clearMatch();
        this.emitter.emit("did-change-match");
        return;
      }
      if (controller.signal.aborted || this.destroyed) return;
      const promise = this.querySyntax("state", [], controller.signal).then((state) => {
        if (controller.signal.aborted || this.destroyed) return;
        if (!this.matchesContext(context, this.captureMatchContext())) {
          if (this.clearMatch()) this.emitter.emit("did-change-match");
          return;
        }
        if (state) {
          this.reportedFailureContext = null;
          this.applyMatch(state, context);
        }
      });
      this.matchPromise = promise;
      this.pendingMatchContext = context;
      const settled = () => {
        if (this.matchController === controller) this.pendingMatchContext = null;
      };
      void promise.then(settled, settled);
      void promise.catch((error) => {
        if (!controller.signal.aborted && !this.destroyed) {
          const current = this.matchesContext(context, this.captureMatchContext());
          if (this.clearMatch()) this.emitter.emit("did-change-match");
          const previous = this.reportedFailureContext;
          if (
            current &&
            (!previous ||
              previous.mode !== context.mode ||
              previous.revision !== context.revision ||
              previous.epoch !== context.epoch)
          ) {
            this.reportedFailureContext = context;
            console.error("Unable to update bracket match", error);
          }
        }
      });
      return promise;
    }
    this.clearMatch();
    if (!this.editor.getLastSelection().isEmpty()) {
      this.emitter.emit("did-change-match");
      return;
    }
    const pair = this.findCurrentPair();
    return this.applyMatch(
      {
        pair,
        tags:
          pair.position && pair.matchPosition ? {} : this.findMatchingTagNameRangesWithSyntaxTree(),
      },
      context,
    );
  }

  captureMatchContext() {
    const buffer = this.editor.getBuffer();
    const mode = buffer.getLanguageMode();
    return {
      buffer,
      revision: buffer.getTextRevision(),
      mode,
      epoch: mode.getSyntaxRequestEpoch?.(),
      selection: this.editor.getLastSelection(),
      position: this.editor.getCursorBufferPosition().copy(),
      pairs: this.matchManager.pairedCharacters,
      inverse: this.matchManager.pairedCharactersInverse,
      lineNumbers: lumine.config.get("bracket-matcher.highlightMatchingLineNumber", {
        scope: this.editor.getRootScopeDescriptor(),
      }),
    };
  }

  matchesContext(left, right) {
    return (
      left &&
      right &&
      left.buffer === right.buffer &&
      left.revision === right.revision &&
      left.mode === right.mode &&
      left.epoch === right.epoch &&
      left.selection === right.selection &&
      right.selection.isEmpty() &&
      left.position.isEqual(right.position) &&
      left.pairs === right.pairs &&
      left.inverse === right.inverse &&
      left.lineNumbers === right.lineNumbers
    );
  }

  clearMatch() {
    const changed = this.pairHighlighted || this.tagHighlighted;
    for (const marker of new Set([this.startMarker, this.endMarker])) marker?.destroy();
    this.startMarker = this.endMarker = null;
    this.pairHighlighted = false;
    this.tagHighlighted = false;
    this.bracket1Range = this.bracket2Range = null;
    this.paintedContext = null;
    return changed;
  }

  applyMatch({ pair: { position, matchPosition }, tags }, context = this.captureMatchContext()) {
    const controller = this.matchController;
    const current = () =>
      !this.destroyed &&
      this.matchController === controller &&
      this.matchesContext(context, this.captureMatchContext());
    let startRange;
    let endRange;
    let highlightTag = false;
    let highlightPair = false;
    if (position && matchPosition) {
      startRange = Range(position, position.traverse(ONE_CHAR_FORWARD_TRAVERSAL));
      endRange = Range(matchPosition, matchPosition.traverse(ONE_CHAR_FORWARD_TRAVERSAL));
      highlightPair = true;
    } else {
      ({ startRange, endRange } = tags);
      if (startRange) {
        highlightTag = true;
        highlightPair = true;
      }
    }

    if (!highlightTag && !highlightPair) {
      this.clearMatch();
      this.emitter.emit("did-change-match");
      return;
    }

    const unchanged =
      this.pairHighlighted &&
      this.tagHighlighted === highlightTag &&
      this.startMarker &&
      !this.startMarker.isDestroyed() &&
      this.startMarker.isValid() &&
      this.endMarker &&
      !this.endMarker.isDestroyed() &&
      this.endMarker.isValid() &&
      this.startMarker.getBufferRange().isEqual(startRange) &&
      this.endMarker.getBufferRange().isEqual(endRange);
    if (!unchanged) {
      this.clearMatch();
      let startMarker,
        endMarker,
        committed = false;
      try {
        if (!current()) return;
        startMarker = this.createMarker(startRange);
        if (!current()) return;
        endMarker = this.createMarker(endRange);
        if (!current()) return;
        this.startMarker = startMarker;
        this.endMarker = endMarker;
        committed = true;
      } finally {
        if (!committed) {
          for (const marker of new Set([startMarker, endMarker])) marker?.destroy();
        }
      }
    }
    this.bracket1Range = highlightTag ? null : startRange;
    this.bracket2Range = highlightTag ? null : endRange;
    this.pairHighlighted = highlightPair;
    this.tagHighlighted = highlightTag;
    this.paintedContext = context;
    this.emitter.emit("did-change-match");
  }

  querySyntax(method, args, signal) {
    if (syntaxUnavailable(this.editor)) return Promise.resolve(null);
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

  commandMatch() {
    if (!this.editor.getLastSelection().isEmpty()) return Promise.resolve({});
    return this.querySyntax("state").then((state) => {
      if (!state) return null;
      const { pair, tags } = state;
      if (pair.position && pair.matchPosition)
        return {
          startRange: Range.fromPointWithDelta(pair.position, 0, 1),
          endRange: Range.fromPointWithDelta(pair.matchPosition, 0, 1),
          tag: false,
        };
      return { ...tags, tag: Boolean(tags.startRange) };
    });
  }

  selectMatchingBrackets(prepared = null) {
    if (this.editor.getBuffer().getLanguageMode().asynchronousSyntax && !prepared)
      return this.withCurrentResult(this.commandMatch(), (state) =>
        this.selectMatchingBrackets(state),
      );
    if (prepared) {
      if (!prepared.startRange || prepared.tag) return;
      this.editor.setSelectedBufferRanges([prepared.startRange, prepared.endRange]);
      this.matchManager.changeBracketsMode = true;
      return;
    }
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

      const text = bracketSelectionText(this.editor.getLastSelection(), {
        ...this.matchManager.pairedCharacters,
        ...this.matchManager.pairedCharactersInverse,
      });
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
    try {
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
    } catch (error) {
      marker.destroy();
      throw error;
    }
  }

  goToMatchingBracket(prepared = null) {
    if (this.editor.getBuffer().getLanguageMode().asynchronousSyntax && !prepared)
      return this.withCurrentResult(this.commandMatch(), (state) =>
        this.goToMatchingBracket(state),
      );
    if (!(prepared ? prepared.startRange : this.pairHighlighted))
      return this.gotoPrecedingStartBracket(prepared);
    const position = this.editor.getCursorBufferPosition();

    if (prepared ? prepared.tag : this.tagHighlighted) {
      let tagCharacterOffset;
      let startRange = prepared ? prepared.startRange : this.startMarker.getBufferRange();
      const tagLength = startRange.end.column - startRange.start.column;
      let endRange = prepared ? prepared.endRange : this.endMarker.getBufferRange();
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
      const startPosition = prepared
        ? prepared.startRange.start
        : this.startMarker.getStartBufferPosition();
      const endPosition = prepared
        ? prepared.endRange.start
        : this.endMarker.getStartBufferPosition();

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

  gotoPrecedingStartBracket(prepared = null) {
    if (this.editor.getBuffer().getLanguageMode().asynchronousSyntax && !prepared)
      return this.withCurrentResult(this.commandMatch(), (state) =>
        this.gotoPrecedingStartBracket(state),
      );
    if (prepared ? prepared.startRange : this.pairHighlighted) return;

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

  selectInsideBrackets(prepared = null) {
    if (this.editor.getBuffer().getLanguageMode().asynchronousSyntax && !prepared)
      return this.withCurrentResult(this.commandMatch(), (state) =>
        this.selectInsideBrackets(state),
      );
    let endPosition, endRange, startPosition, startRange;
    if (prepared ? prepared.startRange : this.pairHighlighted) {
      startRange = prepared ? prepared.startRange : this.startMarker.getBufferRange();
      endRange = prepared ? prepared.endRange : this.endMarker.getBufferRange();

      if (prepared ? prepared.tag : this.tagHighlighted) {
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
  async closeTag() {
    const editor = this.editor;
    if (this.destroyed || editor.isDestroyed() || editor.isReadOnly()) return;
    this.closeTagController?.abort();
    const controller = (this.closeTagController = new AbortController());
    const buffer = editor.getBuffer();
    const revision = buffer.getTextRevision();
    const grammar = editor.getGrammar();
    const cursor = buffer.characterIndexForPosition(editor.getCursorBufferPosition());
    const subscriptions = new CompositeDisposable(
      buffer.onDidChange(() => controller.abort()),
      editor.onDidChangeSelectionRange(() => controller.abort()),
      editor.onDidChangeGrammar(() => controller.abort()),
      editor.onDidDestroy(() => controller.abort()),
    );
    try {
      const tag = await require("./source-tag-finder").closingTagForSource(
        buffer.getTextSnapshot(),
        cursor,
        { signal: controller.signal, xmlMode: !grammar.scopeName.startsWith("text.html") },
      );
      if (
        tag &&
        !controller.signal.aborted &&
        !this.destroyed &&
        !editor.isDestroyed() &&
        !editor.isReadOnly() &&
        buffer.getTextRevision() === revision &&
        editor.getGrammar() === grammar
      ) {
        subscriptions.dispose();
        editor.insertText(`</${tag}>`);
      }
    } catch (error) {
      if (!controller.signal.aborted && !this.destroyed)
        lumine.notifications.addWarning("Unable to close the tag", {
          detail: error.message,
          dismissable: true,
        });
    } finally {
      subscriptions.dispose();
      if (this.closeTagController === controller) this.closeTagController = null;
    }
  }
};
