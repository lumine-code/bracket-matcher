describe("Bracket Matcher cleared selection matches", () => {
  let editor, main;
  beforeEach(async () => {
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("bracket-matcher")).mainModule;
    editor = await lumine.workspace.open();
    editor.setText("(one)\nnoise");
    editor.setCursorBufferPosition([0, 0]);
    expect(main.provideBracketMatcher().getMatchRanges(editor)).toBeTruthy();
  });
  afterEach(async () => {
    editor?.destroy();
    await lumine.packages.unloadPackage("bracket-matcher");
  });
  it("keeps an unrelated selection after its previous highlighted pair is cleared", () => {
    editor.setSelectedBufferRange([
      [1, 0],
      [1, 5],
    ]);
    expect(main.provideBracketMatcher().getMatchRanges(editor)).toBeNull();
    const selected = editor.getSelectedBufferRanges().map((range) => range.serialize());
    lumine.commands.dispatch(editor.getElement(), "bracket-matcher:select-matching-brackets");
    expect(editor.getSelectedBufferRanges().map((range) => range.serialize())).toEqual(selected);
  });
  it("still selects and replaces a currently highlighted pair", () => {
    lumine.commands.dispatch(editor.getElement(), "bracket-matcher:select-matching-brackets");
    expect(editor.getSelections().map((selection) => selection.getText())).toEqual(["(", ")"]);
    editor.insertText("[");
    expect(editor.getText()).toBe("[one]\nnoise");
  });
});
