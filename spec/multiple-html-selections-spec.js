describe("Bracket selection inside multiple HTML elements", () => {
  let editor;

  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    jasmine.attachToDOM(lumine.workspace.getElement());
    const html = await lumine.packages.activatePackage("language-html");
    await html.resourceLoadPromise;
    await lumine.packages.activatePackage("bracket-matcher");
    editor = await lumine.workspace.open();
    editor.setGrammar(html.grammars.find((grammar) => grammar.scopeName === "text.html.basic"));
    expect(editor.getGrammar().scopeName).toBe("text.html.basic");
  });

  afterEach(() => editor?.destroy());

  async function select(source, positions) {
    editor.setText(source);
    expect(await editor.whenGrammarSettled()).toBeTrue();
    if (editor.getGrammar().scopeName === "text.html.basic") {
      const root = editor.getSyntaxNodeAtBufferPosition([0, 0], (node) => !node.parent);
      expect(root.hasError).toBeFalse();
    }
    editor.setSelectedBufferRanges(positions.map((position) => [position, position]));
    lumine.commands.dispatch(editor.getElement(), "bracket-matcher:select-inside-brackets");
    return editor.getSelectedBufferRanges();
  }

  it("selects the contents of each element from its own cursor", async () => {
    const ranges = await select("<div>alpha</div>\n<span>beta</span>", [
      [0, 7],
      [1, 8],
    ]);
    expect(ranges).toEqual([
      [
        [0, 5],
        [0, 10],
      ],
      [
        [1, 6],
        [1, 10],
      ],
    ]);
    expect(editor.getSelections().map((selection) => selection.getText())).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("retains ordinary selection inside one HTML element", async () => {
    expect(await select("<div>alpha</div>", [[0, 7]])).toEqual([
      [
        [0, 5],
        [0, 10],
      ],
    ]);
  });

  it("retains selection inside ordinary brackets at multiple cursors", async () => {
    lumine.grammars.assignLanguageMode(editor, null);
    expect(
      await select("(first)\n(second)", [
        [0, 3],
        [1, 3],
      ]),
    ).toEqual([
      [
        [0, 1],
        [0, 6],
      ],
      [
        [1, 1],
        [1, 7],
      ],
    ]);
  });
});
