const { TextEditor } = require("lumine");

describe("source-backed bracket operations", () => {
  let editor, matcher, helpers;
  beforeEach(() => {
    const BracketMatcher = require("../lib/bracket-matcher");
    helpers = require("../lib/text-source");
    editor = new TextEditor();
    editor.setSoftWrapped(false);
    // Exercise model edits without mounting the separate Linux PRIMARY
    // clipboard observer, which legitimately reads bounded selections.
    matcher = new BracketMatcher(editor, null, {
      pairedCharacters: { "(": ")", "[": "]" },
      pairedCharactersInverse: { ")": "(", "]": "[" },
    });
    spyOn(matcher, "getScopedSetting").and.returnValue(true);
  });
  afterEach(() => {
    matcher.destroy();
    editor.destroy();
  });

  it("wraps and unwraps a large reversed selection without reading its text", () => {
    const text = "alpha 😀\r\nbeta\n".repeat(1000);
    editor.setText(text);
    const original = editor.getBuffer().getTextSnapshot();
    editor.setSelectedBufferRange(editor.getBuffer().getRange(), { reversed: true });
    editor.getBuffer().clearUndoStack();
    const selection = editor.getLastSelection();
    const read = spyOn(selection, "getText").and.throwError("full selection read");
    const marker = editor.markBufferRange(
      [
        [500, 0],
        [500, 5],
      ],
      { invalidate: "never" },
    );
    try {
      expect(matcher.wrapSelectionInBrackets("(")).toBeTrue();
      expect(selection.isReversed()).toBeTrue();
      expect(helpers.selectionSource(selection).equals(original)).toBeTrue();
      expect(editor.getBuffer().getTextInRange(marker.getBufferRange())).toBe("alpha");
      editor.setSelectedBufferRange(editor.getBuffer().getRange(), { reversed: true });
      expect(matcher.removeBrackets()).toBeTrue();
      expect(editor.getBuffer().getTextSnapshot().equals(original)).toBeTrue();
      expect(selection.isReversed()).toBeTrue();
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.and.callThrough();
      marker.destroy();
    }
    editor.undo();
    expect(editor.getBuffer().getTextSnapshot().slice(0, 1)).toBe("(");
    editor.undo();
    expect(editor.getBuffer().getTextSnapshot().equals(original)).toBeTrue();
  });

  it("examines only selection edges for a matching pair", () => {
    editor.setText("(" + "x".repeat(20000) + ")");
    editor.selectAll();
    const selection = editor.getLastSelection();
    const read = spyOn(selection, "getText").and.throwError("full selection read");
    try {
      expect(matcher.selectionIsWrappedByMatchingBrackets(selection)).toBeTrue();
      expect(helpers.bracketSelectionText(selection, { "(": ")" })).toBe("");
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.and.callThrough();
    }
  });

  it("gets escape parity from bounded suffix chunks, retaining odd/even and row boundaries", () => {
    for (const count of [0, 1, 2, 4095, 4096, 4097]) {
      for (const suffix of ["", "x"]) {
        const prefix = "ordinary".repeat(10000) + "\\".repeat(count) + suffix;
        editor.setText(prefix);
        const read = spyOn(editor, "getTextInBufferRange").and.throwError("whole prefix read");
        const result = helpers.precedingContext(editor, editor.getBuffer().getEndPosition());
        expect(result.previousCharacter).toBe(prefix.slice(-1));
        expect(result.escaped).toBe(!suffix && count % 2 === 1);
        expect(result.escapeSequence).toBe(
          count > 0 && (suffix ? count % 2 === 1 : count % 2 === 0),
        );
        expect(read).not.toHaveBeenCalled();
        read.and.callThrough();
        delete editor.getTextInBufferRange;
      }
    }
    editor.setText("\\\\\n");
    expect(helpers.precedingContext(editor, editor.getBuffer().getEndPosition())).toEqual({
      previousCharacter: "",
      escaped: false,
      escapeSequence: false,
    });
  });
});
