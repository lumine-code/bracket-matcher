describe("Pairs without automatic edits", () => {
  let editor, pack, waitForMatching;

  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-javascript");
    pack = await lumine.packages.activatePackage("bracket-matcher");
    waitForMatching = require("./helpers/async-matching")(pack);
    lumine.config.set("editor.autoIndent", false);
    lumine.config.set("bracket-matcher.autocompleteCharacters", ["<>", "()", "{}", "''"], {
      scopeSelector: ".source.js",
    });
    lumine.config.set("bracket-matcher.autocompleteDisabledCharacters", ["<"], {
      scopeSelector: ".source.js",
    });
    lumine.config.set("bracket-matcher.pairsWithExtraNewline", ["<>", "()"]);
    editor = await lumine.workspace.open("selective-pairs.js");
    editor.update({ autoIndent: false });
    await editor.whenGrammarSettled();
  });

  afterEach(() => editor?.destroy());

  async function start(text, position = [0, Infinity]) {
    editor.setText(text);
    editor.setCursorBufferPosition(position);
    await waitForMatching(editor);
    editor.getBuffer().clearUndoStack();
  }

  async function type(text) {
    await editor.insertText(text);
    await waitForMatching(editor);
  }

  it("inserts an operator once while still completing other pairs", async () => {
    await start("value ");
    await type("<");
    expect(editor.getText()).toBe("value <");
    editor.undo();
    expect(editor.getText()).toBe("value ");
    await start("");
    await type("(");
    expect(editor.getText()).toBe("()");
  });

  it("does not skip a disabled closer even when always-skip is enabled", async () => {
    lumine.config.set("bracket-matcher.alwaysSkipClosingPairs", true);
    await start("<>", [0, 1]);
    await type(">");
    expect(editor.getText()).toBe("<>>");
    expect(editor.getCursorBufferPosition().column).toBe(2);
    await start("()", [0, 1]);
    await type(")");
    expect(editor.getText()).toBe("()");
  });

  it("deletes one character in a disabled pair and both in an ordinary pair", async () => {
    await start("<>", [0, 1]);
    await editor.backspace();
    expect(editor.getText()).toBe(">");
    await start("()", [0, 1]);
    await editor.backspace();
    expect(editor.getText()).toBe("");
  });

  it("replaces selected text with a disabled opener while ordinary pairs still wrap", async () => {
    await start("value");
    editor.selectAll();
    await type("<");
    expect(editor.getText()).toBe("<");
    await start("value");
    editor.selectAll();
    await type("(");
    expect(editor.getText()).toBe("(value)");
  });

  it("inserts one newline inside disabled pairs while ordinary pairs still expand", async () => {
    await start("<>", [0, 1]);
    await editor.insertNewline();
    await waitForMatching(editor);
    expect(editor.getText()).toBe("<\n>");
    await start("()", [0, 1]);
    await editor.insertNewline();
    await waitForMatching(editor);
    expect(editor.getText()).toBe("(\n\n)");
  });

  it("reacts to setting changes in the same editor", async () => {
    await start("");
    await type("<");
    expect(editor.getText()).toBe("<");
    lumine.config.set("bracket-matcher.autocompleteDisabledCharacters", [], {
      scopeSelector: ".source.js",
    });
    await start("");
    await type("<");
    expect(editor.getText()).toBe("<>");
  });

  it("retains highlighting and navigation for disabled pairs", async () => {
    await lumine.packages.activatePackage("language-rust");
    lumine.config.set("bracket-matcher.autocompleteDisabledCharacters", ["<"], {
      scopeSelector: ".source.rust",
    });
    editor.setGrammar(lumine.grammars.grammarForScopeName("source.rust"));
    const source = "type Items = Vec<T>;";
    await start(source, [0, source.indexOf("<")]);
    expect(pack.mainModule.provideBracketMatcher().getMatchRanges(editor)).not.toBeNull();
    await lumine.commands.dispatch(editor.getElement(), "bracket-matcher:go-to-matching-bracket");
    await waitForMatching(editor);
    expect(editor.getCursorBufferPosition().column).toBe(source.indexOf(">") + 1);
  });

  it("keeps explicit bracket removal available", async () => {
    await start("<value>");
    editor.selectAll();
    await lumine.commands.dispatch(
      editor.getElement(),
      "bracket-matcher:remove-brackets-from-selection",
    );
    await waitForMatching(editor);
    expect(editor.getText()).toBe("value");
  });

  it("does not complete interpolation when its brace pair is disabled", async () => {
    await lumine.packages.activatePackage("language-ruby");
    lumine.config.set("bracket-matcher.autocompleteDisabledCharacters", ["{"], {
      scopeSelector: ".source.ruby",
    });
    editor.setGrammar(lumine.grammars.grammarForScopeName("source.ruby"));
    await start('"hello "', [0, 7]);
    await type("#");
    expect(editor.getText()).toBe('"hello #"');
  });
});
