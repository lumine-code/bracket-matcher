const path = require("node:path");

describe("Deferred interpolation without cached scopes", () => {
  let editor, execution, pending;
  const heldScopes = [];

  beforeEach(async () => {
    jasmine.useRealClock();
    execution = lumine.grammars.syntaxExecution;
    lumine.grammars.syntaxExecution = "worker";
    await lumine.packages.activatePackage("language-ruby");
    await lumine.packages.activatePackage("language-gfm");
    const pack = await lumine.packages.activatePackage("bracket-matcher");
    const Matcher = require(path.join(pack.path, "lib/bracket-matcher"));
    const original = Matcher.prototype.insertInterpolation;
    spyOn(Matcher.prototype, "insertInterpolation").and.callFake(function (...args) {
      const result = original.apply(this, args);
      pending = this.pendingInterpolation;
      return result;
    });
    editor = await lumine.workspace.open();
  });

  afterEach(async () => {
    editor?.destroy();
    for (const release of heldScopes.splice(0)) release(null);
    await pending;
    pending = null;
    lumine.grammars.syntaxExecution = execution;
  });

  async function start(text, scope, position) {
    editor.setText(text);
    editor.setGrammar(lumine.grammars.grammarForScopeName(scope));
    await editor.whenGrammarSettled();
    spyOn(editor, "getScopeDescriptorsForBufferPositions").and.callFake(
      () => new Promise((resolve) => heldScopes.push(resolve)),
    );
    editor.setCursorBufferPosition(position);
    editor.getBuffer().clearUndoStack();
  }

  it("commits the hash immediately and resolves interpolation independently of prefetch", async () => {
    await start('foo = ""', "source.ruby", [0, 7]);
    editor.insertText("#");
    expect(editor.getText()).toBe('foo = "#"');
    await pending;
    expect(editor.getText()).toBe('foo = "#{}"');
    editor.undo();
    expect(editor.getText()).toBe('foo = ""');
  });

  it("uses exact embedded Ruby rules without a cached host scope", async () => {
    await start('```ruby\nvalue = ""\n```', "source.gfm", [1, 9]);
    editor.insertText("#");
    await pending;
    expect(editor.lineTextForBufferRow(1)).toBe('value = "#{}"');
  });

  it("honors an embedded brace opt-out when the prefetch is unavailable", async () => {
    await start('```ruby\nvalue = ""\n```', "source.gfm", [1, 9]);
    lumine.config.set("bracket-matcher.autocompleteDisabledCharacters", ["{"], {
      scopeSelector: ".source.ruby",
    });
    editor.insertText("#");
    await pending;
    expect(editor.lineTextForBufferRow(1)).toBe('value = "#"');
  });

  it("honors a scoped user enable over a global disable", async () => {
    await start('```ruby\nvalue = ""\n```', "source.gfm", [1, 9]);
    lumine.config.set("bracket-matcher.autocompleteBrackets", false);
    lumine.config.set("bracket-matcher.autocompleteBrackets", true, {
      scopeSelector: ".source.ruby",
    });
    editor.insertText("#");
    await pending;
    expect(editor.lineTextForBufferRow(1)).toBe('value = "#{}"');
  });

  it("still completes a replaced selection when wrapping is disabled", async () => {
    await start('foo = "bar"', "source.ruby", [0, 10]);
    lumine.config.set("bracket-matcher.wrapSelectionsInBrackets", false, {
      scopeSelector: ".source.ruby",
    });
    editor.setSelectedBufferRange([
      [0, 7],
      [0, 10],
    ]);
    editor.insertText("#");
    await pending;
    expect(editor.getText()).toBe('foo = "#{}"');
    editor.undo();
    expect(editor.getText()).toBe('foo = "bar"');
    expect(editor.getSelectedText()).toBe("bar");
  });

  it("does not enrich a cancelled hash insertion", async () => {
    await start('foo = "abc"', "source.ruby", [0, 9]);
    editor.onWillInsertText(({ text, cancel }) => {
      if (text === "#") cancel();
    });
    editor.insertText("#");
    await pending;
    expect(editor.getText()).toBe('foo = "abc"');
  });

  it("does not restore text from a selection redirected before insertion", async () => {
    await start('foo = "first second"', "source.ruby", [0, 12]);
    editor.setSelectedBufferRange([
      [0, 7],
      [0, 12],
    ]);
    editor.onWillInsertText(({ text }) => {
      if (text === "#")
        editor.setSelectedBufferRange([
          [0, 13],
          [0, 19],
        ]);
    });
    editor.insertText("#");
    await pending;
    expect(editor.getText()).toBe('foo = "first #"');
  });

  it("does not restore selection bytes changed by an insertion observer", async () => {
    await start('foo = "value"', "source.ruby", [0, 12]);
    editor.setSelectedBufferRange([
      [0, 7],
      [0, 12],
    ]);
    editor.onWillInsertText(({ text }) => {
      if (text !== "#") return;
      editor.getBuffer().setTextInRange(
        [
          [0, 7],
          [0, 12],
        ],
        "other",
      );
      editor.setSelectedBufferRange([
        [0, 7],
        [0, 12],
      ]);
    });
    editor.insertText("#");
    await pending;
    expect(editor.getText()).toBe('foo = "#"');
  });

  it("rejects an optional enrichment after configuration changes during analysis", async () => {
    await start('foo = ""', "source.ruby", [0, 7]);
    let release, entered;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const analyze = editor.analyzeSyntax.bind(editor);
    spyOn(editor, "analyzeSyntax").and.callFake((module, method, ...args) => {
      const result = analyze(module, method, ...args);
      if (method !== "interpolationContexts") return result;
      entered();
      return result.then(async (value) => {
        await gate;
        return value;
      });
    });
    editor.insertText("#");
    await started;
    lumine.config.set("bracket-matcher.autocompleteDisabledCharacters", ["{"], {
      scopeSelector: ".source.ruby",
    });
    release();
    await pending;
    expect(editor.getText()).toBe('foo = "#"');
  });
});
