const path = require("path");

// Observe the current package generation's real operations. Tests still drive
// commands and edits through the editor, then await the work they started.
module.exports = function observeMatching(pack) {
  const pending = new Map();
  const remember = (editor, promise) => {
    if (!promise?.then) return;
    let promises = pending.get(editor);
    if (!promises) pending.set(editor, (promises = new Set()));
    promises.add(promise);
    const done = () => promises.delete(promise);
    promise.then(done, done);
  };
  const View = require(path.join(pack.path, "lib/bracket-matcher-view"));
  for (const name of [
    "updateMatch",
    "querySyntax",
    "selectMatchingBrackets",
    "selectInsideBrackets",
    "goToMatchingBracket",
    "gotoPrecedingStartBracket",
    "closeTag",
    "removeMatchingBrackets",
  ]) {
    const original = View.prototype[name];
    spyOn(View.prototype, name).and.callFake(function (...args) {
      const result = original.apply(this, args);
      remember(this.editor, result);
      return result;
    });
  }
  const Matcher = require(path.join(pack.path, "lib/bracket-matcher"));
  const insert = Matcher.prototype.insertInterpolation;
  spyOn(Matcher.prototype, "insertInterpolation").and.callFake(function (...args) {
    const result = insert.apply(this, args);
    remember(this.editor, this.pendingInterpolation);
    return result;
  });
  return async function waitForMatching(editor) {
    await editor.whenGrammarSettled();
    await editor.getBuffer().getLanguageMode().refresh?.();
    while (pending.get(editor)?.size) await Promise.all([...pending.get(editor)]);
  };
};
