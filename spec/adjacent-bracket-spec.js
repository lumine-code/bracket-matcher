const observeMatching = require("./helpers/async-matching");

describe("bracket matching beside automatic quote pairs", () => {
  let editor, matches, waitForMatching;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    const pack = await lumine.packages.activatePackage("bracket-matcher");
    matches = pack.mainModule.provideBracketMatcher();
    waitForMatching = observeMatching(pack);
    editor = await lumine.workspace.open();
  });

  afterEach(() => editor?.destroy());

  async function setGrammar(packageName, scopeName) {
    await lumine.packages.activatePackage(packageName);
    editor.setGrammar(lumine.grammars.grammarForScopeName(scopeName));
    await editor.whenGrammarSettled();
  }

  async function setText(text, column) {
    editor.setText(text);
    editor.setCursorBufferPosition([0, column]);
    await waitForMatching(editor);
  }

  async function dispatch(command) {
    await lumine.commands.dispatch(editor.getElement(), `bracket-matcher:${command}`);
    await waitForMatching(editor);
  }

  function expectMatch(start, end) {
    const match = matches.getMatchRanges(editor);
    expect(match).not.toBeNull();
    if (!match) return;
    const positions = [match.range1.start.column, match.range2.start.column].sort((a, b) => a - b);
    expect(positions).toEqual([start, end]);
  }

  for (const [packageName, scopeName] of [
    ["language-python", "source.python"],
    ["language-javascript", "source.js"],
    ["language-text", "text.plain"],
  ]) {
    describe(scopeName, () => {
      beforeEach(() => setGrammar(packageName, scopeName));

      for (const quote of ["'", '"']) {
        for (const [open, close] of [
          ["(", ")"],
          ["[", "]"],
          ["{", "}"],
        ]) {
          it(`matches ${open}${close} on both sides beside ${quote}`, async () => {
            const text = `${open}${quote}w_y${quote}${close}`;
            const end = text.length - 1;
            for (const column of [0, 1, end, end + 1]) {
              await setText(text, column);
              expectMatch(0, end);
            }
          });
        }
      }

      it("matches the reported function call on both sides of each parenthesis", async () => {
        const text = "Store(idc=301, act='w_y')";
        const start = text.indexOf("(");
        const end = text.lastIndexOf(")");
        for (const column of [start, start + 1, end, end + 1]) {
          await setText(text, column);
          expectMatch(start, end);
        }
      });

      it("navigates from before a closing bracket after a quote", async () => {
        await setText("('w_y')", 6);
        await dispatch("go-to-matching-bracket");
        expect(editor.getCursorBufferPosition()).toEqual([0, 1]);
      });

      it("selects the bracket pair beside a quote", async () => {
        await setText("('w_y')", 6);
        await dispatch("select-matching-brackets");
        expect(editor.getSelections().map((selection) => selection.getText())).toEqual([")", "("]);
      });

      it("selects the contents from before a closing bracket after a quote", async () => {
        await setText("('w_y')", 6);
        await dispatch("select-inside-brackets");
        expect(editor.getSelectedText()).toBe("'w_y'");
      });

      it("backspaces only the quote even when the surrounding brackets are highlighted", async () => {
        await setText("('w_y')", 6);
        expectMatch(0, 6);
        await dispatch("remove-matching-brackets");
        expect(editor.getText()).toBe("('w_y)");
        expect(editor.getCursorBufferPosition()).toEqual([0, 5]);
      });

      for (const column of [1, 7]) {
        it(`removes the exact preceding bracket pair at column ${column}`, async () => {
          await setText("('w_y')", column);
          await dispatch("remove-matching-brackets");
          expect(editor.getText()).toBe("'w_y'");
        });
      }
    });
  }

  describe("configurable pairs in plain text", () => {
    beforeEach(() => setGrammar("language-text", "text.plain"));

    it("ignores any configured symmetric pair when choosing an adjacent bracket", async () => {
      lumine.config.set("bracket-matcher.autocompleteCharacters", ["()", "||"]);
      for (const column of [1, 7]) {
        await setText("(|text|)", column);
        expectMatch(0, 7);
      }
    });

    it("continues matching configured asymmetric quote pairs", async () => {
      for (const column of [0, 1, 5, 6]) {
        await setText("«text»", column);
        expectMatch(0, 5);
      }
    });

    for (const selected of [false, true]) {
      it(`removes the preceding pair beside another opener with selection=${selected}`, async () => {
        await setText("()[]", 2);
        expectMatch(2, 3);
        if (selected)
          editor.setSelectedBufferRange(
            [
              [0, 1],
              [0, 2],
            ],
            { reversed: true },
          );
        await dispatch("remove-matching-brackets");
        expect(editor.getText()).toBe("[]");
        expect(editor.getCursorBufferPosition()).toEqual([0, 0]);
      });
    }
  });

  describe("JavaScript template strings", () => {
    beforeEach(() => setGrammar("language-javascript", "source.js"));

    it("ignores backticks beside the containing brackets", async () => {
      for (const column of [1, 6]) {
        await setText("(`w_y`)", column);
        expectMatch(0, 6);
      }
    });

    it("does not match bracket characters within a string", async () => {
      for (const column of [2, 3]) {
        await setText("(')')", column);
        expect(matches.getMatchRanges(editor)).toBeNull();
      }
    });
  });
});
