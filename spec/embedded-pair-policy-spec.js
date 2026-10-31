describe("Automatic pairs in embedded languages", () => {
  let editor;

  beforeEach(async () => {
    jasmine.useRealClock();
    for (const name of [
      "language-gfm",
      "language-haskell",
      "language-json",
      "language-javascript",
      "bracket-matcher",
    ])
      await lumine.packages.activatePackage(name);
    editor = await lumine.workspace.open();
    editor.update({ autoIndent: false });
  });

  afterEach(() => editor?.destroy());

  async function start(scope, text, position) {
    editor.setGrammar(lumine.grammars.grammarForScopeName(scope));
    editor.setText(text);
    editor.setCursorBufferPosition(position);
    await ready();
  }

  async function ready() {
    await editor.whenGrammarSettled();
    await editor.getScopeDescriptorsForBufferPositions(editor.getCursorBufferPositions());
  }

  async function type(text) {
    await editor.insertText(text);
    await ready();
  }

  it("uses the Haskell apostrophe policy inside Markdown code", async () => {
    await start("source.gfm", "```haskell\nvalue = \n```", [1, 8]);
    expect(editor.scopeDescriptorForBufferPosition([1, 7]).getScopesArray()).toContain(
      "source.haskell",
    );
    await type("'");
    expect(editor.getText()).toBe("```haskell\nvalue = '\n```");
  });

  it("uses JSON pairs in nonempty Markdown code", async () => {
    await start("source.gfm", '```json\n{"value": \n```', [1, 10]);
    await type("'");
    expect(editor.getText()).toBe('```json\n{"value": \'\n```');
  });

  it("does not guess the host quote policy in an empty code fence", async () => {
    await start("source.gfm", "```json\n\n```", [1, 0]);
    await type("'");
    expect(editor.getText()).toBe("```json\n'\n```");
  });

  it("refreshes rules when moving between prose and code", async () => {
    const source = "prose \n```haskell\nvalue = \n```";
    await start("source.gfm", source, [0, 6]);
    await type("'");
    expect(editor.lineTextForBufferRow(0)).toBe("prose ''");
    await start("source.gfm", source, [2, 8]);
    await type("'");
    expect(editor.lineTextForBufferRow(2)).toBe("value = '");
  });

  it("keeps ordinary pairs available in embedded code", async () => {
    await start("source.gfm", "```haskell\nvalue = \n```", [1, 8]);
    await type("(");
    expect(editor.lineTextForBufferRow(1)).toBe("value = ()");
  });

  it("refreshes pair rules after changing the root grammar", async () => {
    await start("source.haskell", "", [0, 0]);
    await type("'");
    expect(editor.getText()).toBe("'");
    await start("source.js", "", [0, 0]);
    await type("'");
    expect(editor.getText()).toBe("''");
    await start("source.haskell", "", [0, 0]);
    await type("'");
    expect(editor.getText()).toBe("'");
  });

  it("honors scoped user changes inside the same code fence", async () => {
    await start("source.gfm", "```haskell\nvalue = \n```", [1, 8]);
    lumine.config.set("bracket-matcher.autocompleteDisabledCharacters", [], {
      scopeSelector: ".source.haskell",
    });
    await type("'");
    expect(editor.lineTextForBufferRow(1)).toBe("value = ''");
  });

  it("honors scoped changes without changing text or cursor", async () => {
    await start("source.haskell", "", [0, 0]);
    await type("'");
    await start("source.haskell", "", [0, 0]);
    lumine.config.set("bracket-matcher.autocompleteDisabledCharacters", [], {
      scopeSelector: ".source.haskell",
    });
    await type("'");
    expect(editor.getText()).toBe("''");
  });

  it("leaves mixed-language selections to ordinary typing", async () => {
    await start("source.gfm", "prose\n```haskell\nvalue\n```", [0, 0]);
    editor.setSelectedBufferRanges([
      [
        [0, 0],
        [0, 5],
      ],
      [
        [2, 0],
        [2, 5],
      ],
    ]);
    await ready();
    await type("'");
    expect(editor.getText()).toBe("'\n```haskell\n'\n```");
  });

  if (process.env.LUMINE_SYNTAX_EXECUTION === "worker") {
    it("does not guess from stale scopes while exact analysis is pending", async () => {
      await start("source.gfm", "prose", [0, 5]);
      let release;
      spyOn(editor, "getScopeDescriptorsForBufferPositions").and.callFake(
        () =>
          new Promise((resolve) => {
            release = () => resolve(null);
          }),
      );
      editor.setText("```haskell\nvalue = \n```");
      editor.setCursorBufferPosition([1, 8]);
      await editor.insertText("'");
      expect(editor.lineTextForBufferRow(1)).toBe("value = '");
      await Promise.resolve();
      release?.();
    });
  }

  it("honors the global off switch with scoped pair defaults", async () => {
    lumine.config.set("bracket-matcher.autocompleteBrackets", false);
    lumine.config.set("bracket-matcher.wrapSelectionsInBrackets", false);
    await start("source.js", "", [0, 0]);
    await type("(");
    expect(editor.getText()).toBe("(");
    editor.setText("value");
    editor.selectAll();
    await ready();
    await type("(");
    expect(editor.getText()).toBe("(");
  });
});
