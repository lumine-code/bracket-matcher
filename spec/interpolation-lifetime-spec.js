describe("Deferred string interpolation lifetime", () => {
  let editor, matcher, release;

  beforeEach(async () => {
    await lumine.packages.activatePackage("bracket-matcher");
    const BracketMatcher = require("../lib/bracket-matcher");
    editor = lumine.workspace.buildTextEditor();
    matcher = new BracketMatcher(editor, null, {});
    lumine.config.set("bracket-matcher.autocompleteBrackets", true);
    lumine.config.set("bracket-matcher.wrapSelectionsInBrackets", true);
    editor.setText('""');
    editor.setCursorBufferPosition([0, 1]);
    spyOn(editor, "analyzeSyntax").and.callFake(
      () =>
        new Promise((resolve) => {
          release = () => resolve([true]);
        }),
    );
  });

  afterEach(async () => {
    release?.();
    await matcher?.pendingInterpolation;
    matcher?.destroy();
    editor?.destroy();
    await lumine.packages.deactivatePackage("bracket-matcher");
    release = null;
  });

  it("keeps the typed hash without writing braces after the editor becomes read-only", async () => {
    matcher.insertInterpolation();
    editor.setReadOnly(true);
    release();
    await matcher.pendingInterpolation;
    expect(editor.getText()).toBe('"#"');
    expect(editor.getCursorBufferPosition().toArray()).toEqual([0, 2]);
  });

  it("does not complete a retired autocomplete preference", async () => {
    matcher.insertInterpolation();
    lumine.config.set("bracket-matcher.autocompleteBrackets", false);
    release();
    await matcher.pendingInterpolation;
    expect(editor.getText()).toBe('"#"');
  });

  it("keeps the original insertion and its braces in one undo step", async () => {
    matcher.insertInterpolation();
    release();
    await matcher.pendingInterpolation;
    expect(editor.getText()).toBe('"#{}"');
    expect(editor.getCursorBufferPosition().toArray()).toEqual([0, 3]);
    editor.undo();
    expect(editor.getText()).toBe('""');
  });
});
