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
    const inputSubscription = this.editor.onWillInsertText?.(() =>
      this.interpolationController?.abort(),
    );
    if (inputSubscription) this.subscriptions.add(inputSubscription);
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
      if (this.getAutomaticPolicy() !== null && !this.allowsAutomaticPair("{")) return true;
      const result = this.insertInterpolation(options);
      return result?.then ? result : false;
    }

    if (this.wrapSelectionInBrackets(text)) return false;
    if (this.editor.hasMultipleCursors()) return true;
    const automatic = this.getAutomaticPolicy();
    const pairs = automatic?.pairedCharacters ?? this.matchManager.pairedCharacters;
    const inverse = automatic?.pairedCharactersInverse ?? this.matchManager.pairedCharactersInverse;

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
        Object.hasOwn(pairs, text) &&
        this.allowsAutomaticPair(text) &&
        !hasWordAfterCursor &&
        this.getScopedSetting("bracket-matcher.autocompleteBrackets") &&
        !(
          this.isQuote(text) &&
          (hasWordBeforeCursor || hasQuoteBeforeCursor || hasEscapeSequenceBeforeCursor)
        ) &&
        !hasEscapeCharacterBeforeCursor;
      pair = pairs[text];
    }

    let skipOverExistingClosingBracket = false;
    if (
      Object.hasOwn(inverse, text) &&
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
      (this.getAutomaticPolicy()?.pairsWithExtraNewline ?? this.matchManager.pairsWithExtraNewline)[
        previousCharacter
      ] === nextCharacter &&
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
      (this.getAutomaticPolicy()?.pairedCharacters ?? this.matchManager.pairedCharacters)[
        previousCharacter
      ] === nextCharacter &&
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
    if (this.editor.getSelections().every((selection) => selection.isEmpty())) return false;
    const typedText = bracket;
    const pairs = this.getAutomaticPolicy()?.pairedCharacters ?? this.matchManager.pairedCharacters;
    let pair;
    if (bracket === "#") {
      if (!this.allowsAutomaticPair("{")) return false;
      if (!this.isCursorOnInterpolatedString()) return false;
      bracket = "#{";
      pair = "}";
    } else {
      if (!Object.hasOwn(pairs, bracket)) return false;
      if (!this.allowsAutomaticPair(bracket)) return false;
      pair = pairs[bracket];
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
    const automaticPolicy = this.getAutomaticPolicy();
    const unknownScope = automaticPolicy === null;
    const automaticScope = automaticPolicy?.scope;
    const policyVersion = this.matchManager.automaticPolicyVersion;
    const wrap =
      unknownScope ||
      this.getScopedSetting("bracket-matcher.wrapSelectionsInBrackets", automaticScope);
    const autocomplete =
      unknownScope || this.getScopedSetting("bracket-matcher.autocompleteBrackets", automaticScope);
    const automaticPair = unknownScope || this.allowsAutomaticPair("{");
    const complete = autocomplete && automaticPair && !editor.hasMultipleCursors();
    const records = new Map(
      editor.getSelections().map((selection) => {
        const range = selection.getBufferRange();
        const position = selection.cursor.getBufferPosition();
        const escaped = precedingContext(editor, position).escaped;
        const canWrap = !range.isEmpty() && range.isSingleLine();
        const canComplete = !editor.hasMultipleCursors() && !escaped;
        const wrapped = wrap && automaticPair && canWrap;
        return [
          selection.id,
          {
            selection,
            range: range.copy(),
            text: canWrap ? selectionSource(selection) : null,
            reversed: selection.isReversed(),
            canWrap,
            canComplete,
            eligible: wrapped || (complete && !escaped),
          },
        ];
      }),
    );
    // Commit the key immediately. A later syntax answer may enrich that exact
    // insertion, but never delay, reorder or overwrite subsequent typing.
    const orderedRecords = editor
      .getSelectionsOrderedByBufferPosition()
      .map((selection) => records.get(selection.id));
    const beforeRevision = buffer.getTextRevision();
    let acceptedTarget = false;
    const acceptance = editor.onWillInsertText?.(({ text }) => {
      if (text !== "#") return;
      const current = editor.getSelections();
      acceptedTarget =
        buffer.getTextRevision() === beforeRevision &&
        current.length === records.size &&
        current.every((selection) => {
          const record = records.get(selection.id);
          return (
            record?.selection === selection && selection.getBufferRange().isEqual(record.range)
          );
        });
    });
    let insertion;
    try {
      insertion = this.origEditorInsertText("#", options);
    } finally {
      acceptance?.dispose();
    }
    // Queued preparation owns its future insertion. Optional interpolation
    // cannot claim text that was rejected, redirected or has not appeared yet.
    if (insertion?.then) {
      this.pendingInterpolation = insertion;
      return insertion;
    }
    if (
      !acceptedTarget ||
      !Array.isArray(insertion) ||
      buffer.getTextRevision() !== beforeRevision + records.size ||
      insertion.length !== editor.getSelections().length ||
      insertion.some((range, index) => {
        const record = orderedRecords[index];
        if (!range || !record) return true;
        const expectedStart = index
          ? insertion[index - 1].end.traverse(
              record.range.start.traversalFrom(orderedRecords[index - 1].range.end),
            )
          : record.range.start;
        return (
          range.start.row !== range.end.row ||
          range.end.column - range.start.column !== 1 ||
          !range.start.isEqual(expectedStart) ||
          buffer.getTextInRange(range) !== "#" ||
          !editor.getSelections().includes(record.selection) ||
          !record.selection.isEmpty() ||
          !record.selection.cursor.getBufferPosition().isEqual(range.end)
        );
      })
    )
      return insertion;
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
        "interpolationContexts",
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
          (policyVersion !== undefined &&
            this.matchManager.automaticPolicyVersion !== policyVersion) ||
          (!unknownScope &&
            (this.getScopedSetting("bracket-matcher.autocompleteBrackets", automaticScope) !==
              autocomplete ||
              this.allowsAutomaticPair("{", automaticScope) !== automaticPair ||
              this.getScopedSetting("bracket-matcher.wrapSelectionsInBrackets", automaticScope) !==
                wrap)) ||
          selections.length !== editor.getSelections().length ||
          selections.some(
            ({ selection, range }) =>
              selection.destroyed || !selection.getBufferRange().isEqual(range),
          )
        )
          return;
        const plans = selections.flatMap(({ selection, position, record }, index) => {
          const result = allowed[index];
          const scope = result?.scopes ?? automaticScope ?? editor.getRootScopeDescriptor();
          const interpolated = typeof result === "boolean" ? result : result?.interpolated;
          const wrapping =
            record?.canWrap &&
            this.getScopedSetting("bracket-matcher.wrapSelectionsInBrackets", scope);
          const completing =
            record?.canComplete &&
            this.getScopedSetting("bracket-matcher.autocompleteBrackets", scope);
          return interpolated &&
            record?.eligible &&
            (wrapping || completing) &&
            this.allowsAutomaticPair("{", scope)
            ? [
                {
                  selection,
                  record: { ...record, text: wrapping ? record.text : null },
                  range: [position.traverse([0, -1]), position],
                  text: wrapping ? wrappedSource(record.text, "#{", "}") : "#{}",
                },
              ]
            : [];
        });
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

  getAutomaticPolicy() {
    return this.matchManager.getAutomaticPolicy?.();
  }

  allowsAutomaticPair(character, scope) {
    const policy = scope
      ? this.matchManager.automaticPolicyForScope?.(scope)
      : this.getAutomaticPolicy();
    if (policy === null) return false;
    const disabled =
      policy?.autocompleteDisabledCharacters ?? this.matchManager.autocompleteDisabledCharacters;
    if (!disabled?.size) return true;
    const pairs = policy?.pairedCharacters ?? this.matchManager.pairedCharacters;
    const inverse = policy?.pairedCharactersInverse ?? this.matchManager.pairedCharactersInverse;
    const opening = Object.hasOwn(pairs ?? {}, character)
      ? character
      : (inverse?.[character] ?? character);
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

  getScopedSetting(key, scope) {
    return lumine.config.get(key, {
      scope: scope ?? this.getAutomaticPolicy()?.scope ?? this.editor.getRootScopeDescriptor(),
    });
  }
};
