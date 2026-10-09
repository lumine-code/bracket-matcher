describe("Bracket input with mixed selections", () => {
  let editor;

  beforeEach(async () => {
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.returnValue(Promise.resolve());
    spyOn(lumine.application, "openWindow").and.returnValue(Promise.resolve());
    lumine.config.set("bracket-matcher.wrapSelectionsInBrackets", true);
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("bracket-matcher");
    editor = await lumine.workspace.open();
    editor.setText("word\nother");
    editor.setSelectedBufferRanges([
      [
        [0, 0],
        [0, 4],
      ],
      [
        [1, 5],
        [1, 5],
      ],
    ]);
  });

  afterEach(() => {
    editor?.destroy();
    lumine.config.unset("bracket-matcher.wrapSelectionsInBrackets");
    editor = null;
  });

  it("wraps selected text while preserving the same typed character at an empty cursor", () => {
    editor.insertText("(");
    expect(editor.getText()).toBe("(word)\nother(");
    expect(editor.getSelections().length).toBe(2);
    editor.undo();
    expect(editor.getText()).toBe("word\nother");
  });

  it("keeps ordinary insertion at every cursor when selection wrapping is disabled", () => {
    lumine.config.set("bracket-matcher.wrapSelectionsInBrackets", false);
    editor.insertText("(");
    expect(editor.getText()).toBe("(\nother(");
  });
});
