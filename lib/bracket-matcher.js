const { CompositeDisposable } = require("lumine");
const { adviseBefore, syntaxUnavailable } = require("./helpers");
const {
  selectionSource,
  bracketSelectionText,
  wrappedSource,
  precedingContext,
} = require("./text-source");

module.exports = class BracketMatcher {
  constructor(editor, editorElement, matchManager) {
    this.destroy = this.destroy.bind(this);
    this.insertText = this.insertText.bind(this);
    this.insertNewline = this.insertNewline.bind(this);
    this.backspace = this.backspace.bind(this);
    this.editor = editor;
    this.matchManager = matchManager;
    this.subscriptions = new CompositeDisposable();
    this.bracketMarkers = [];

    this.origEditorInsertText = this.editor.insertText.bind(this.editor);
    this.subscriptions.add(
      adviseBefore(this.editor, "insertText", this.insertText),
      adviseBefore(this.editor, "insertNewline", this.insertNewline),
      adviseBefore(this.editor, "backspace", this.backspace),
      this.editor.onDidDestroy(this.destroy),
    );
    const syntaxSubscription = this.editor.onDidChangeSyntaxAvailability?.(() => {
      if (this.destroyed || !syntaxUnavailable(this.editor)) return;
      this.interpolationController?.abort();
      this.pendingInterpolation = null;
      this.matchManager.changeBracketsMode = false;
      for (const marker of this.bracketMarkers) marker.destroy();
      this.bracketMarkers = [];
    });
    if (syntaxSubscription) this.subscriptions.add(syntaxSubscription);
  }

  insertText(text, options) {
    if (syntaxUnavailable(this.editor)) return true;
    if (!text) return true;
    if ((options && options.select) || (options && options.undo === "skip")) return true;

    let autoCompleteOpeningBracket, bracketMarker, pair;
    if (this.matchManager.changeBracketsMode) {
      this.matchManager.changeBracketsMode = false;
      if (this.isClosingBracket(text)) {
        text = this.matchManager.pairedCharactersInverse[text];
      }
      if (this.isOpeningBracket(text)) {
        this.editor.mutateSelectedText((selection) => {
          const selectionText = bracketSelectionText(selection, {
            ...this.matchManager.pairedCharacters,
            ...this.matchManager.pairedCharactersInverse,
          });
          if (this.isOpeningBracket(selectionText)) {
            selection.insertText(text);
          }
          if (this.isClosingBracket(selectionText)) {
            selection.insertText(this.matchManager.pairedCharacters[text]);
          }
        });
        return false;
      }
    }

    if (text === "#" && this.editor.getBuffer().getLanguageMode().asynchronousSyntax) {
      if (!this.allowsAutomaticPair("{")) return true;
      this.insertInterpolation(options);
      return false;
    }

    if (this.wrapSelectionInBrackets(text)) return false;
    if (this.editor.hasMultipleCursors()) return true;

    const cursorBufferPosition = this.editor.getCursorBufferPosition();
    const context = precedingContext(this.editor, cursorBufferPosition);
    const nextCharacter = this.editor.getTextInBufferRange([
      cursorBufferPosition,
      cursorBufferPosition.traverse([0, 1]),
    ]);
    const previousCharacter = context.previousCharacter;

    const hasWordAfterCursor = /\w/.test(nextCharacter);
    const hasWordBeforeCursor = /\w/.test(previousCharacter);
    const hasQuoteBeforeCursor = this.isQuote(previousCharacter) && previousCharacter === text[0];
    const hasEscapeCharacterBeforeCursor = context.escaped;
    const hasEscapeSequenceBeforeCursor = context.escapeSequence;

    if (text === "#" && this.isCursorOnInterpolatedString()) {
      autoCompleteOpeningBracket =
        this.getScopedSetting("bracket-matcher.autocompleteBrackets") &&
        this.allowsAutomaticPair("{") &&
        !hasEscapeCharacterBeforeCursor;
      text += "{";
      pair = "}";
    } else {
      autoCompleteOpeningBracket =
        this.isOpeningBracket(text) &&
        this.allowsAutomaticPair(text) &&
        !hasWordAfterCursor &&
        this.getScopedSetting("bracket-matcher.autocompleteBrackets") &&
        !(
          this.isQuote(text) &&
          (hasWordBeforeCursor || hasQuoteBeforeCursor || hasEscapeSequenceBeforeCursor)
        ) &&
        !hasEscapeCharacterBeforeCursor;
      pair = this.matchManager.pairedCharacters[text];
    }

    let skipOverExistingClosingBracket = false;
    if (
      this.isClosingBracket(text) &&
      this.allowsAutomaticPair(text) &&
      nextCharacter === text &&
      !hasEscapeCharacterBeforeCursor
    ) {
      bracketMarker = this.bracketMarkers.find(
        (marker) => marker.isValid() && marker.getBufferRange().end.isEqual(cursorBufferPosition),
      );
      if (bracketMarker || this.getScopedSetting("bracket-matcher.alwaysSkipClosingPairs")) {
        skipOverExistingClosingBracket = true;
      }
    }

    if (skipOverExistingClosingBracket) {
      if (bracketMarker) {
        bracketMarker.destroy();
        this.bracketMarkers.splice(this.bracketMarkers.indexOf(bracketMarker), 1);
      }
      this.editor.moveRight();
      return false;
    } else if (autoCompleteOpeningBracket) {
      if (this.editor.getBuffer().getLanguageMode().asynchronousSyntax) {
        return this.editor
          .transactWithAutoIndentation((editor) => {
            editor.insertText(text + pair);
            editor.moveLeft();
          }, options)
          .then((result) => {
            if (result === false || this.destroyed) return result;
            const end = this.editor.getCursorBufferPosition();
            this.bracketMarkers.push(
              this.editor.markBufferRange([[end.row, end.column - text.length], end]),
            );
            return result;
          });
      }
      this.editor.transact(() => {
        this.origEditorInsertText(text + pair);
        this.editor.moveLeft();
      });
      const range = [cursorBufferPosition, cursorBufferPosition.traverse([0, text.length])];
      this.bracketMarkers.push(this.editor.markBufferRange(range));
      return false;
    }
  }

  insertNewline() {
    if (syntaxUnavailable(this.editor)) return;
    if (this.editor.hasMultipleCursors()) return;
    if (!this.editor.getLastSelection().isEmpty()) return;

    const cursorBufferPosition = this.editor.getCursorBufferPosition();
    const context = precedingContext(this.editor, cursorBufferPosition);
    const nextCharacter = this.editor.getTextInBufferRange([
      cursorBufferPosition,
      cursorBufferPosition.traverse([0, 1]),
    ]);
    const previousCharacter = context.previousCharacter;
    const hasEscapeCharacterBeforeCursor = context.escaped;

    if (
      this.matchManager.pairsWithExtraNewline[previousCharacter] === nextCharacter &&
      this.allowsAutomaticPair(previousCharacter) &&
      !hasEscapeCharacterBeforeCursor
    ) {
      if (this.editor.getBuffer().getLanguageMode().asynchronousSyntax) {
        return this.editor.transactWithAutoIndentation((editor) => {
          editor.insertText("\n\n");
          editor.moveUp();
          if (this.getScopedSetting("editor.autoIndent")) {
            const row = editor.getCursorBufferPosition().row;
            editor.autoIndentBufferRows(row, row + 1);
          }
        });
      }
      this.editor.transact(() => {
        this.origEditorInsertText("\n\n");
        this.editor.moveUp();
        if (this.getScopedSetting("editor.autoIndent")) {
          const cursorRow = this.editor.getCursorBufferPosition().row;
          this.editor.autoIndentBufferRows(cursorRow, cursorRow + 1);
        }
      });
      return false;
    }
  }

  backspace() {
    if (syntaxUnavailable(this.editor)) return;
    if (this.editor.hasMultipleCursors()) return;
    if (!this.editor.getLastSelection().isEmpty()) return;

    const cursorBufferPosition = this.editor.getCursorBufferPosition();
    const context = precedingContext(this.editor, cursorBufferPosition);
    const nextCharacter = this.editor.getTextInBufferRange([
      cursorBufferPosition,
      cursorBufferPosition.traverse([0, 1]),
    ]);
    const previousCharacter = context.previousCharacter;
    const hasEscapeCharacterBeforeCursor = context.escaped;

    if (
      this.matchManager.pairedCharacters[previousCharacter] === nextCharacter &&
      this.allowsAutomaticPair(previousCharacter) &&
      !hasEscapeCharacterBeforeCursor &&
      this.getScopedSetting("bracket-matcher.autocompleteBrackets")
    ) {
      this.editor.transact(() => {
        this.editor.moveLeft();
        this.editor.delete();
        this.editor.delete();
      });
      return false;
    }
  }

  removeBrackets() {
    let bracketsRemoved = false;
    this.editor.mutateSelectedText((selection) => {
      let selectionEnd;
      if (!this.selectionIsWrappedByMatchingBrackets(selection)) return;

      const range = selection.getBufferRange();
      const options = { reversed: selection.isReversed() };
      const selectionStart = range.start;
      if (range.start.row === range.end.row) {
        selectionEnd = range.end.traverse([0, -2]);
      } else {
        selectionEnd = range.end.traverse([0, -1]);
      }

      const buffer = this.editor.getBuffer();
      const start = buffer.characterIndexForPosition(range.start);
      const end = buffer.characterIndexForPosition(range.end);
      buffer.setTextInIndependentRanges([
        { range: [range.start, buffer.positionForCharacterIndex(start + 1)], text: "" },
        { range: [buffer.positionForCharacterIndex(end - 1), range.end], text: "" },
      ]);
      selection.setBufferRange([selectionStart, selectionEnd], options);
      bracketsRemoved = true;
    });
    return bracketsRemoved;
  }

  wrapSelectionInBrackets(bracket) {
    const typedText = bracket;
    let pair;
    if (bracket === "#") {
      if (!this.allowsAutomaticPair("{")) return false;
      if (!this.isCursorOnInterpolatedString()) return false;
      bracket = "#{";
      pair = "}";
    } else {
      if (!this.isOpeningBracket(bracket)) return false;
      if (!this.allowsAutomaticPair(bracket)) return false;
      pair = this.matchManager.pairedCharacters[bracket];
    }

    if (
      !this.editor.selections.some(
        (s) => !s.isEmpty() && (bracket !== "#{" || s.getBufferRange().isSingleLine()),
      )
    )
      return false;
    if (!this.getScopedSetting("bracket-matcher.wrapSelectionsInBrackets")) return false;

    let selectionWrapped = false;
    this.editor.mutateSelectedText((selection) => {
      let selectionEnd;
      if (selection.isEmpty()) {
        selection.insertText(typedText);
        return;
      }

      // Don't wrap in #{} if the selection spans more than one line
      if (bracket === "#{" && !selection.getBufferRange().isSingleLine()) return;

      selectionWrapped = true;
      const range = selection.getBufferRange();
      const options = { reversed: selection.isReversed() };
      this.editor.getBuffer().setTextInIndependentRanges([
        { range: [range.start, range.start], text: bracket },
        { range: [range.end, range.end], text: pair },
      ]);
      const selectionStart = range.start.traverse([0, bracket.length]);
      if (range.start.row === range.end.row) {
        selectionEnd = range.end.traverse([0, bracket.length]);
      } else {
        selectionEnd = range.end;
      }
      selection.setBufferRange([selectionStart, selectionEnd], options);
    });

    return selectionWrapped;
  }

  isQuote(string) {
    return /['"`]/.test(string);
  }

  isCursorOnInterpolatedString() {
    return require("./syntax-analysis").interpolated(this.editor, {
      position: this.editor.getCursorBufferPosition(),
    });
  }

  insertInterpolation(options) {
    const editor = this.editor;
    const buffer = editor.getBuffer();
    const mode = buffer.getLanguageMode();
    const wrap = this.getScopedSetting("bracket-matcher.wrapSelectionsInBrackets");
    const autocomplete = this.getScopedSetting("bracket-matcher.autocompleteBrackets");
    const automaticPair = this.allowsAutomaticPair("{");
    const complete = autocomplete && automaticPair && !editor.hasMultipleCursors();
    const records = new Map(
      editor.getSelections().map((selection) => {
        const range = selection.getBufferRange();
        const position = selection.cursor.getBufferPosition();
        const escaped = precedingContext(editor, position).escaped;
        const wrapped = wrap && automaticPair && !range.isEmpty() && range.isSingleLine();
        return [
          selection.id,
          {
            text: wrapped ? selectionSource(selection) : null,
            reversed: selection.isReversed(),
            eligible: wrapped || (complete && !escaped),
          },
        ];
      }),
    );
    // Commit the key immediately. A later syntax answer may enrich that exact
    // insertion, but never delay, reorder or overwrite subsequent typing.
    this.origEditorInsertText("#", options);
    const revision = buffer.getTextRevision();
    const syntaxEpoch = mode.getSyntaxRequestEpoch?.();
    const selections = editor.getSelections().map((selection) => ({
      selection,
      range: selection.getBufferRange(),
      position: selection.cursor.getBufferPosition(),
      record: records.get(selection.id),
    }));
    if (!selections.some(({ record }) => record?.eligible)) return;
    if (syntaxUnavailable(editor)) return;
    this.interpolationController?.abort();
    const controller = (this.interpolationController = new AbortController());
    const pending = editor
      .analyzeSyntax(
        require.resolve("./syntax-analysis"),
        "interpolations",
        {
          positions: selections.map(({ position }) => position.traverse([0, -1])),
        },
        { signal: controller.signal },
      )
      .then((allowed) => {
        if (
          !allowed ||
          controller.signal.aborted ||
          editor.isDestroyed() ||
          (editor.isReadOnly() && !options?.bypassReadOnly) ||
          this.destroyed ||
          buffer.getLanguageMode() !== mode ||
          mode.getSyntaxRequestEpoch?.() !== syntaxEpoch ||
          buffer.getTextRevision() !== revision ||
          this.getScopedSetting("bracket-matcher.autocompleteBrackets") !== autocomplete ||
          this.allowsAutomaticPair("{") !== automaticPair ||
          this.getScopedSetting("bracket-matcher.wrapSelectionsInBrackets") !== wrap ||
          selections.length !== editor.getSelections().length ||
          selections.some(
            ({ selection, range }) =>
              selection.destroyed || !selection.getBufferRange().isEqual(range),
          )
        )
          return;
        const plans = selections.flatMap(({ selection, position, record }, index) =>
          allowed[index] && record?.eligible
            ? [
                {
                  selection,
                  record,
                  range: [position.traverse([0, -1]), position],
                  text: record.text ? wrappedSource(record.text, "#{", "}") : "#{}",
                },
              ]
            : [],
        );
        if (!plans.length) return;
        const markers = plans.map(({ range }) =>
          editor.markBufferRange(range, { invalidate: "never" }),
        );
        try {
          editor.transact(() => {
            buffer.setTextInIndependentRanges(
              plans.map(({ range, text }) => ({ range, text })),
              { expectedRevision: revision },
            );
            for (let i = 0; i < plans.length; i++) {
              const range = markers[i].getBufferRange();
              const { selection, record } = plans[i];
              selection.setBufferRange(
                [range.start.traverse([0, 2]), range.end.traverse([0, -1])],
                { reversed: record.reversed },
              );
              if (!record.text)
                this.bracketMarkers.push(
                  editor.markBufferRange([range.start, range.start.traverse([0, 2])]),
                );
            }
          });
          buffer.groupLastChanges();
        } finally {
          for (const marker of markers) marker.destroy();
        }
      });
    this.pendingInterpolation = pending;
    void pending.catch((error) => {
      if (!controller.signal.aborted && !this.destroyed)
        console.error("Unable to complete string interpolation", error);
    });
  }

  allowsAutomaticPair(character) {
    const disabled = this.matchManager.autocompleteDisabledCharacters;
    if (!disabled?.size) return true;
    const opening = Object.hasOwn(this.matchManager.pairedCharacters ?? {}, character)
      ? character
      : (this.matchManager.pairedCharactersInverse?.[character] ?? character);
    return !disabled.has(opening);
  }

  isOpeningBracket(string) {
    return Object.hasOwn(this.matchManager.pairedCharacters, string);
  }

  isClosingBracket(string) {
    return Object.hasOwn(this.matchManager.pairedCharactersInverse, string);
  }

  selectionIsWrappedByMatchingBrackets(selection) {
    if (selection.isEmpty()) return false;
    const selectedText = selectionSource(selection);
    if (selectedText.length < 2) return false;
    const firstCharacter = selectedText.slice(0, 1);
    const lastCharacter = selectedText.slice(-1);
    return this.matchManager.pairedCharacters[firstCharacter] === lastCharacter;
  }

  destroy() {
    this.destroyed = true;
    this.interpolationController?.abort();
    for (const marker of this.bracketMarkers.splice(0)) marker.destroy();
    this.subscriptions.dispose();
  }

  unsubscribe() {
    this.destroy();
  }

  getScopedSetting(key) {
    return lumine.config.get(key, { scope: this.editor.getRootScopeDescriptor() });
  }
};
