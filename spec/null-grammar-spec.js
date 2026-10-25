const path = require("node:path");

describe("bracket-matcher with no grammar", () => {
  let editor;
  beforeEach(async () => {
    await lumine.packages.activatePackage("language-text");
    await lumine.packages.activatePackage(path.join(__dirname, ".."));
    editor = await lumine.workspace.open();
  });
  afterEach(() => editor?.destroy());

  it("removes matching, advice and pending highlights, then resumes for a grammar", () => {
    const grammar = lumine.grammars.grammarForScopeName("text.plain");
    editor.setGrammar(grammar);
    const advised = editor.insertText;
    editor.insertText("(");
    expect(editor.getText()).toBe("()");
    editor.setGrammar(lumine.grammars.nullGrammar);
    expect(editor.insertText).not.toBe(advised);
    editor.setText("");
    editor.insertText("(");
    expect(editor.getText()).toBe("(");
    const main = lumine.packages.getActivePackage("bracket-matcher").mainModule;
    expect(main.provideBracketMatcher().getMatchRanges(editor)).toBeNull();
    editor.setGrammar(grammar);
    editor.setText("");
    editor.insertText("(");
    expect(editor.getText()).toBe("()");
  });
});
