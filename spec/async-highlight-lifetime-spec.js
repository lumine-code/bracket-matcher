const { Emitter, Point } = require("lumine");

describe("Asynchronous bracket highlight lifetime", () => {
  // Processing fixtures use a real grammar; None deliberately disables this package.
  beforeEach(async () => {
    await lumine.packages.activatePackage("language-text");
  });

  let editor, view, mode, events, queries, manager, epoch;
  const pair = (end = 4) => ({
    pair: { position: new Point(0, 0), matchPosition: new Point(0, end) },
    tags: {},
  });
  const noPair = () => ({ pair: {}, tags: {} });
  const markers = () => [view.startMarker, view.endMarker];
  const paint = () =>
    editor.getHighlightDecorations().filter((d) => d.properties.class === "bracket-matcher");

  beforeEach(async () => {
    editor = lumine.workspace.buildTextEditor();
    editor.setText("(one)\nother");
    editor.setCursorBufferPosition([0, 0]);
    queries = [];
    epoch = 1;
    events = new Emitter();
    mode = editor.getBuffer().getLanguageMode();
    mode.asynchronousSyntax = true;
    mode.getSyntaxRequestEpoch = () => epoch;
    mode.onDidChangeHighlighting = (callback) => events.on("highlight", callback);
    spyOn(editor, "analyzeSyntax").and.callFake(
      () => new Promise((resolve, reject) => queries.push({ resolve, reject })),
    );
    manager = {
      pairedCharacters: { "(": ")" },
      pairedCharactersInverse: { ")": "(" },
      pairRegexes: {},
    };
    const View = require("../lib/bracket-matcher-view");
    view = new View(editor, editor.getElement(), manager);
    queries.at(-1).resolve(pair());
    await view.matchPromise;
  });
  afterEach(async () => {
    view.destroy();
    for (const query of queries) query.resolve(noPair());
    await view.matchPromise?.catch(() => {});
    editor.destroy();
    events.dispose();
  });

  it("keeps the same markers painted through repeated highlighting while one query is pending", async () => {
    const previous = markers(),
      count = queries.length;
    events.emit("highlight");
    const pending = view.matchPromise;
    for (let i = 0; i < 10; i++) events.emit("highlight");
    expect(queries.length).toBe(count + 1);
    expect(paint().length).toBe(2);
    expect(markers()).toEqual(previous);
    expect(previous.every((marker) => !marker.isDestroyed())).toBe(true);
    queries.at(-1).resolve(pair());
    await pending;
    expect(markers()).toEqual(previous);
    expect(paint().length).toBe(2);
  });

  it("does not clear a confirmed undo match when its highlighting arrives later", async () => {
    editor.setCursorBufferPosition([1, 0]);
    editor.insertText("    ");
    editor.undo();
    editor.setCursorBufferPosition([0, 0]);
    queries.at(-1).resolve(pair());
    await view.matchPromise;
    const restored = markers();
    events.emit("highlight");
    expect(paint().length).toBe(2);
    expect(markers()).toEqual(restored);
    queries.at(-1).resolve(pair());
    await view.matchPromise;
    expect(markers()).toEqual(restored);
  });

  for (const change of ["cursor", "selection", "edit", "epoch", "pairs", "grammar"]) {
    it(`clears an obsolete pair immediately after ${change} and ignores the older reply`, async () => {
      const previous = markers();
      const obsolete = view.updateMatch(),
        oldQuery = queries.at(-1);
      if (change === "cursor") editor.setCursorBufferPosition([1, 0]);
      if (change === "selection")
        editor.setSelectedBufferRange([
          [0, 0],
          [0, 2],
        ]);
      if (change === "edit") editor.getBuffer().insert([0, 2], ")");
      if (change === "epoch") epoch++;
      if (change === "pairs") manager.pairedCharacters = { "[": "]" };
      if (change === "grammar") {
        const replacement = lumine.grammars.languageModeForGrammarAndBuffer(
          editor.getGrammar(),
          editor.getBuffer(),
        );
        replacement.asynchronousSyntax = true;
        editor.getBuffer().setLanguageMode(replacement);
      }
      view.updateMatch();
      expect(previous.every((marker) => marker.isDestroyed())).toBe(true);
      expect(paint().length).toBe(0);
      oldQuery.resolve(pair());
      await obsolete;
      expect(paint().length).toBe(0);
      for (const query of queries) query.resolve(noPair());
      await view.matchPromise;
      expect(paint().length).toBe(0);
    });
  }

  it("clears a retained match when the current query reports no pair", async () => {
    const previous = markers(),
      pending = view.updateMatch();
    expect(paint().length).toBe(2);
    queries.at(-1).resolve(noPair());
    await pending;
    expect(paint().length).toBe(0);
    expect(previous.every((marker) => marker.isDestroyed())).toBe(true);
    expect(view.bracket1Range).toBeNull();
  });

  it("releases retained markers and reports a current query failure", async () => {
    spyOn(console, "error");
    const pending = view.updateMatch(),
      failure = new Error("syntax failed");
    queries.at(-1).reject(failure);
    await expectAsync(pending).toBeRejectedWith(failure);
    expect(paint().length).toBe(0);
    expect(console.error).toHaveBeenCalledWith("Unable to update bracket match", failure);
  });

  it("stops requests after a known parser failure and resumes when the mode recovers", async () => {
    const report = spyOn(console, "error");
    const pending = view.updateMatch();
    const failure = new Error("Permanent WASM parse failure");
    mode.error = failure;
    queries.at(-1).reject(failure);
    await expectAsync(pending).toBeRejectedWith(failure);
    const count = queries.length;
    for (let index = 0; index < 5; index++) {
      editor.setCursorBufferPosition([0, index]);
      events.emit("highlight");
      view.updateMatch();
    }
    expect(await view.querySyntax("state", [])).toBeNull();
    expect(queries.length).toBe(count);
    expect(paint().length).toBe(0);
    expect(report).toHaveBeenCalledOnceWith("Unable to update bracket match", failure);
    mode.error = null;
    const resumed = view.updateMatch();
    expect(queries.length).toBe(count + 1);
    queries.at(-1).resolve(pair());
    await resumed;
    expect(paint().length).toBe(2);
  });

  it("reports repeated processor errors once per source input while preserving rejection", async () => {
    const report = spyOn(console, "error");
    for (const column of [1, 2]) {
      editor.setCursorBufferPosition([0, column]);
      const pending = view.matchPromise;
      queries.at(-1).reject(new Error("Same unavailable parser"));
      await expectAsync(pending).toBeRejected();
    }
    expect(report).toHaveBeenCalledTimes(1);
    epoch++;
    const fresh = view.updateMatch();
    queries.at(-1).reject(new Error("New syntax input failed"));
    await expectAsync(fresh).toBeRejected();
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("clears quarantined paint and requests once when both mode events announce recovery", async () => {
    view.destroy();
    let available = true;
    editor.getSyntaxAvailability = () => ({ available });
    editor.onDidChangeSyntaxAvailability = (callback) => events.on("availability", callback);
    const View = require("../lib/bracket-matcher-view");
    view = new View(editor, editor.element, manager);
    queries.at(-1).resolve(pair());
    await view.matchPromise;
    const replace = () => {
      const replacement = lumine.grammars.languageModeForGrammarAndBuffer(
        editor.getGrammar(),
        editor.getBuffer(),
      );
      replacement.asynchronousSyntax = true;
      editor.getBuffer().setLanguageMode(replacement);
      events.emit("availability", { available });
    };
    const before = queries.length;
    available = false;
    replace();
    expect(paint().length).toBe(0);
    expect(queries.length).toBe(before);
    available = true;
    replace();
    expect(queries.length).toBe(before + 1);
    queries.at(-1).resolve(pair());
    await view.matchPromise;
    expect(paint().length).toBe(2);
  });

  it("keeps plain typing, newline and backspace available without failed-mode enrichment", () => {
    const Matcher = require("../lib/bracket-matcher");
    const matcher = new Matcher(editor, editor.element, manager);
    try {
      mode.error = new Error("Known unavailable parser");
      spyOn(matcher, "getScopedSetting").and.throwError("Failed syntax must not enrich typing");
      editor.analyzeSyntax.calls.reset();
      editor.setCursorBufferPosition([0, 5]);
      editor.insertText("x#");
      editor.insertNewline();
      editor.backspace();
      expect(editor.getText()).toBe("(one)x#\nother");
      expect(editor.analyzeSyntax).not.toHaveBeenCalled();
      expect(matcher.getScopedSetting).not.toHaveBeenCalled();
    } finally {
      matcher.destroy();
    }
  });

  it("does not erase a newer match or report an obsolete query failure", async () => {
    spyOn(console, "error");
    const obsolete = view.updateMatch(),
      oldQuery = queries.at(-1);
    editor.setCursorBufferPosition([0, 5]);
    queries.at(-1).resolve(pair());
    await view.matchPromise;
    const current = markers();
    oldQuery.reject(new Error("retired syntax failed"));
    await expectAsync(obsolete).toBeRejected();
    expect(markers()).toEqual(current);
    expect(current.every((marker) => !marker.isDestroyed())).toBe(true);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("does not report a query failure after its epoch changes without a highlight event", async () => {
    spyOn(console, "error");
    const obsolete = view.updateMatch();
    epoch++;
    queries.at(-1).reject(new Error("retired syntax epoch"));
    await expectAsync(obsolete).toBeRejected();
    expect(paint().length).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("destroys retained markers once and ignores a reply after disposal", async () => {
    const previous = markers(),
      pending = view.updateMatch();
    view.destroy();
    view.destroy();
    queries.at(-1).resolve(pair());
    await pending;
    expect(previous.every((marker) => marker.isDestroyed())).toBe(true);
    expect(paint().length).toBe(0);
    expect(view.startMarker).toBeNull();
    expect(view.pendingMatchContext).toBeNull();
  });

  it("releases partially created markers when a decoration observer destroys the view", async () => {
    editor.setText("(other)");
    const pending = view.matchPromise;
    const count = editor.getMarkerCount();
    const subscription = editor.onDidAddDecoration(() => view.destroy());
    queries.at(-1).resolve(pair(6));
    await pending;
    subscription.dispose();
    expect(paint().length).toBe(0);
    expect(editor.getMarkerCount()).toBe(count);
  });

  it("releases both markers when creating the second decoration fails", async () => {
    spyOn(console, "error");
    editor.setText("(other)");
    const pending = view.matchPromise;
    const count = editor.getMarkerCount();
    const decorate = editor.decorateMarker;
    let calls = 0;
    const failure = new Error("decoration failed");
    spyOn(editor, "decorateMarker").and.callFake(function (...args) {
      if (++calls === 2) throw failure;
      return decorate.apply(this, args);
    });
    queries.at(-1).resolve(pair(6));
    await expectAsync(pending).toBeRejectedWith(failure);
    expect(paint().length).toBe(0);
    expect(editor.getMarkerCount()).toBe(count);
  });
});
