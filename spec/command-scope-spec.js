describe("bracket-matcher command scopes", () => {
  const commands = [
    "go-to-matching-bracket",
    "go-to-enclosing-bracket",
    "select-inside-brackets",
    "select-matching-brackets",
    "close-tag",
    "remove-matching-brackets",
    "remove-brackets-from-selection",
  ].map((name) => `bracket-matcher:${name}`);
  let editor, mini, button;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("bracket-matcher");
    editor = await lumine.workspace.open();
    mini = lumine.workspace.buildTextEditor({ mini: true });
    button = document.createElement("button");
    lumine.workspace.getElement().append(mini.getElement(), button);
  });

  afterEach(async () => {
    button.remove();
    mini.destroy();
    editor.destroy();
    await lumine.packages.deactivatePackage("bracket-matcher");
  });

  it("exposes local actions only where their registered surface handles them", () => {
    for (const command of commands) {
      expect(lumine.commands.canDispatch(editor.getElement(), command))
        .withContext(command)
        .toBe(true);
      expect(lumine.commands.canDispatch(button, command)).withContext(command).toBe(false);
      expect(lumine.commands.canDispatch(lumine.workspace.getElement(), command))
        .withContext(command)
        .toBe(false);
      expect(lumine.commands.canDispatch(mini.getElement(), command))
        .withContext(command)
        .toBe(false);
    }
  });

  it("keeps selection and navigation available while disabling text mutations in a read-only editor", () => {
    editor.getElement().setAttribute("readonly", "");
    const mutators = new Set(
      ["close-tag", "remove-matching-brackets", "remove-brackets-from-selection"].map(
        (name) => `bracket-matcher:${name}`,
      ),
    );
    for (const command of commands)
      expect(lumine.commands.canDispatch(editor.getElement(), command))
        .withContext(command)
        .toBe(!mutators.has(command));
  });

  it("does not consume mutation shortcuts in a read-only editor", () => {
    const element = editor.getElement();
    for (const name of ["close-tag", "remove-brackets-from-selection", "remove-matching-brackets"])
      expect(
        lumine.keymaps.findKeyBindings({ target: element, command: `bracket-matcher:${name}` })
          .length,
      )
        .withContext(name)
        .toBeGreaterThan(0);
    element.setAttribute("readonly", "");
    for (const name of ["close-tag", "remove-brackets-from-selection", "remove-matching-brackets"])
      expect(
        lumine.keymaps.findKeyBindings({ target: element, command: `bracket-matcher:${name}` }),
      )
        .withContext(name)
        .toEqual([]);
    for (const name of ["go-to-matching-bracket", "select-inside-brackets"])
      expect(
        lumine.keymaps.findKeyBindings({ target: element, command: `bracket-matcher:${name}` })
          .length,
      )
        .withContext(name)
        .toBeGreaterThan(0);
  });

  it("does not offer local actions in an empty workspace", () => {
    editor.destroy();
    for (const command of commands)
      expect(lumine.commands.canDispatch(lumine.workspace.getElement(), command))
        .withContext(command)
        .toBe(false);
  });
});
