describe("text editor lifecycle", () => {
  it("unwatches removed editors, watches them once when re-added, and cleans up on deactivate", async () => {
    await lumine.packages.activatePackage("bracket-matcher");

    const BracketMatcher = require("../lib/bracket-matcher");
    spyOn(BracketMatcher.prototype, "insertText").and.callThrough();
    const editor = lumine.workspace.buildTextEditor({ autoHeight: false });
    const originalMethods = {
      insertText: editor.insertText,
      insertNewline: editor.insertNewline,
      backspace: editor.backspace,
    };
    const mainModule = lumine.packages.getActivePackage("bracket-matcher").mainModule;
    const didChange = jasmine.createSpy("didChange");
    const matchSubscription = mainModule.provideBracketMatcher().observe(didChange);
    let registration;

    try {
      registration = lumine.textEditors.add(editor, { role: "fragment" });
      expect(editor.insertText).not.toBe(originalMethods.insertText);
      BracketMatcher.prototype.insertText.calls.reset();
      editor.insertText("(");
      expect(editor.getText()).toBe("()");
      expect(BracketMatcher.prototype.insertText.calls.count()).toBe(1);

      registration.dispose();
      registration = null;
      expect(editor.insertText).toBe(originalMethods.insertText);
      expect(editor.insertNewline).toBe(originalMethods.insertNewline);
      expect(editor.backspace).toBe(originalMethods.backspace);
      didChange.calls.reset();
      editor.setText("");
      BracketMatcher.prototype.insertText.calls.reset();
      editor.insertText("(");
      expect(editor.getText()).toBe("(");
      expect(BracketMatcher.prototype.insertText.calls.count()).toBe(0);
      expect(didChange).not.toHaveBeenCalled();

      registration = lumine.textEditors.add(editor, { role: "fragment" });
      editor.setText("text");
      editor.setCursorBufferPosition([0, 0]);
      didChange.calls.reset();
      BracketMatcher.prototype.insertText.calls.reset();

      editor.selectRight();

      expect(didChange.calls.count()).toBe(1);
      editor.setText("");
      editor.insertText("(");
      expect(editor.getText()).toBe("()");
      expect(BracketMatcher.prototype.insertText.calls.count()).toBe(1);

      await lumine.packages.deactivatePackage("bracket-matcher");
      expect(editor.insertText).toBe(originalMethods.insertText);
      expect(editor.insertNewline).toBe(originalMethods.insertNewline);
      expect(editor.backspace).toBe(originalMethods.backspace);
    } finally {
      registration?.dispose();
      matchSubscription.dispose();
      editor.destroy();
    }
  });
});
