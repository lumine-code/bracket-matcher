describe("atomic bracket insertion", () => {
  let editor, execution;
  beforeEach(async () => {
    jasmine.useRealClock();
    execution = lumine.grammars.syntaxExecution;
    lumine.grammars.syntaxExecution = "worker";
    await lumine.packages.activatePackage("language-javascript");
    await lumine.packages.activatePackage("bracket-matcher");
    editor = await lumine.workspace.open();
    editor.update({ autoIndent: true, tabLength: 2, softTabs: true });
    lumine.config.set("bracket-matcher.autocompleteBrackets", true);
    lumine.config.set("editor.autoIndent", true);
  });
  afterEach(() => {
    editor?.destroy();
    lumine.grammars.syntaxExecution = execution;
  });
  for (const scenario of [
    {
      name: "Enter between braces",
      text: "if (ok) {}",
      position: [0, 9],
      action: (editor) => editor.insertNewline(),
      expected: "if (ok) {\n  \n}",
      cursor: [1, 2],
    },
    {
      name: "an inserted pair",
      text: "if (ok) {\n  ",
      position: [1, 2],
      action: (editor) => editor.insertText("("),
      expected: "if (ok) {\n  ()",
      cursor: [1, 3],
    },
  ])
    it(`publishes ${scenario.name} with final indentation and cursor`, async () => {
      editor.setText(scenario.text);
      lumine.grammars.assignLanguageMode(editor.getBuffer(), "source.js");
      await editor.whenGrammarSettled();
      editor.setCursorBufferPosition(scenario.position);
      editor.getBuffer().clearUndoStack();
      const frames = [],
        publications = [];
      editor.getBuffer().onDidApplyChanges(() =>
        publications.push({
          text: editor.getText(),
          cursor: editor.getCursorBufferPosition().serialize(),
        }),
      );
      const mode = editor.getBuffer().getLanguageMode(),
        request = mode.service.client.request.bind(mode.service.client);
      let release, entered;
      const gate = new Promise((resolve) => (release = resolve)),
        ready = new Promise((resolve) => (entered = resolve));
      spyOn(mode.service.client, "request").and.callFake(async (operation, ...args) => {
        const result = request(operation, ...args);
        if (operation === "prepared-indent") {
          entered();
          await gate;
        }
        return result;
      });
      const pending = scenario.action(editor);
      try {
        await ready;
        for (let i = 0; i < 5; i++) {
          await new Promise(requestAnimationFrame);
          frames.push(editor.getText());
        }
        expect(frames).toEqual(Array(5).fill(scenario.text));
        expect(publications).toEqual([]);
      } finally {
        release();
      }
      await pending;
      expect(publications).toEqual([{ text: scenario.expected, cursor: scenario.cursor }]);
      editor.undo();
      expect(editor.getText()).toBe(scenario.text);
      expect(editor.getCursorBufferPosition().serialize()).toEqual(scenario.position);
      editor.redo();
      expect(editor.getText()).toBe(scenario.expected);
      expect(editor.getCursorBufferPosition().serialize()).toEqual(scenario.cursor);
    });
});
