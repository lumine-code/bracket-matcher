const path = require("path");
const { CompositeDisposable } = require("lumine");

describe("advice dispatch during text editor lifecycle changes", () => {
  let editor, adviseBefore, disposables;
  beforeEach(async () => {
    await lumine.packages.activatePackage(path.join(__dirname, ".."));
    // Lifecycle specs must use the helper from the active package generation.
    ({ adviseBefore } = require("../lib/helpers"));
    disposables = new CompositeDisposable();
    editor = lumine.workspace.buildTextEditor();
  });
  afterEach(async () => {
    disposables.dispose();
    editor.destroy();
    await lumine.packages.deactivatePackage("bracket-matcher");
  });

  it("runs a newer advice once when it removes an older advice during insertText", () => {
    const older = jasmine.createSpy("older");
    const oldLease = adviseBefore(editor, "insertText", older);
    const newer = jasmine.createSpy("newer").and.callFake(() => oldLease.dispose());
    disposables.add(oldLease, adviseBefore(editor, "insertText", newer));
    const changed = jasmine.createSpy("changed");
    disposables.add(editor.getBuffer().onDidChangeText(changed));
    editor.insertText("x");
    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(editor.getText()).toBe("x");
  });

  it("restores the editor method while all advice retires during its dispatch", () => {
    const original = editor.insertText;
    const leases = new CompositeDisposable();
    disposables.add(leases);
    const older = jasmine.createSpy("older");
    const newer = jasmine.createSpy("newer").and.callFake(() => leases.dispose());
    leases.add(
      adviseBefore(editor, "insertText", older),
      adviseBefore(editor, "insertText", newer),
    );
    expect(() => editor.insertText("x")).not.toThrow();
    expect(editor.getText()).toBe("x");
    expect(editor.insertText).toBe(original);
    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).not.toHaveBeenCalled();
  });

  it("defers new advice registered inside a callback until the next editor call", () => {
    const order = [];
    let added;
    const original = editor.insertText;
    // Preserve arguments, receiver, return value and the original call timing.
    editor.insertText = function (...args) {
      order.push("original");
      return original.apply(this, args);
    };
    disposables.add(
      adviseBefore(editor, "insertText", function (text) {
        expect(this).toBe(editor);
        expect(text).toBe("x");
        order.push("first");
        added ??= adviseBefore(editor, "insertText", () => order.push("added"));
        disposables.add(added);
      }),
    );
    editor.insertText("x");
    expect(order).toEqual(["first", "original"]);
    order.length = 0;
    editor.insertText("x");
    expect(order).toEqual(["added", "first", "original"]);
    expect(editor.getText()).toBe("xx");
  });

  it("skips the package's bracket advice when activation retires inside newer advice", async () => {
    const main = lumine.packages.getActivePackage("bracket-matcher").mainModule;
    const original = editor.insertText;
    const registration = lumine.textEditors.add(editor, { role: "fragment" });
    disposables.add(registration);
    const lease = adviseBefore(editor, "insertText", () => main.deactivate());
    disposables.add(lease);
    expect(() => editor.insertText("(")).not.toThrow();
    expect(editor.getText()).toBe("(");
    lease.dispose();
    expect(editor.insertText).toBe(original);
    // The Package layer owns generation teardown after the synchronous hook.
    await lumine.packages.deactivatePackage("bracket-matcher");
    const pack = await lumine.packages.activatePackage(path.join(__dirname, ".."));
    expect(pack.mainModule).not.toBeNull();
    editor.setText("");
    editor.insertText("(");
    expect(editor.getText()).toBe("()");
  });

  it("preserves a false advice result as suppression of the original editor method", () => {
    disposables.add(adviseBefore(editor, "insertText", () => false));
    editor.insertText("x");
    expect(editor.getText()).toBe("");
  });
});
