const MatchManager = require("./match-manager");
const BracketMatcherView = require("./bracket-matcher-view");
const BracketMatcher = require("./bracket-matcher");
const { Emitter } = require("lumine");

const editorViews = new WeakMap();
const editorMatchers = new WeakMap();

module.exports = {
  activate() {
    this.matchEmitter = new Emitter();

    // Observe every registered text editor, not just workspace panes, so
    // brackets match in editors embedded in docks, panels, and dialogs.
    lumine.textEditors.observe((editor) => {
      const editorElement = lumine.views.getView(editor);
      const matchManager = new MatchManager(editor, editorElement);
      const view = new BracketMatcherView(editor, editorElement, matchManager);
      editorViews.set(editor, view);
      view.onDidChangeMatch(() => this.matchEmitter.emit("did-change-match", editor));
      editorMatchers.set(editor, new BracketMatcher(editor, editorElement, matchManager));
    });

    // One registration on the workspace rather than one per editor element.
    // Selection > Select Inside Brackets and the six items in Packages >
    // Bracket Matcher dispatch at whatever holds focus, so on the element scope
    // none of them worked unless an editor was focused. The docks, panels and
    // dialogs the observer above exists for are all inside the workspace.
    const forEditor = (run) => (event) => {
      const clicked = event?.target?.closest?.("lumine-text-editor")?.getModel?.();
      const editor = clicked ?? lumine.workspace.getActiveTextEditor();
      if (editor) run(editor, event);
    };

    this.commandsDisposable = lumine.commands.add("lumine-workspace", {
      "bracket-matcher:go-to-matching-bracket": forEditor((editor) =>
        editorViews.get(editor)?.goToMatchingBracket(),
      ),
      "bracket-matcher:go-to-enclosing-bracket": forEditor((editor) =>
        editorViews.get(editor)?.gotoPrecedingStartBracket(),
      ),
      "bracket-matcher:select-inside-brackets": forEditor((editor) =>
        editorViews.get(editor)?.selectInsideBrackets(),
      ),
      "bracket-matcher:close-tag": forEditor((editor) => editorViews.get(editor)?.closeTag()),
      "bracket-matcher:remove-matching-brackets": forEditor((editor) =>
        editorViews.get(editor)?.removeMatchingBrackets(),
      ),
      "bracket-matcher:select-matching-brackets": forEditor((editor) =>
        editorViews.get(editor)?.selectMatchingBrackets(),
      ),
      // Aborting lets `ctrl-]` fall through to the next binding when there is
      // nothing to unwrap; the dispatched event forwards abortKeyBinding
      // whatever level the handler ran at.
      "bracket-matcher:remove-brackets-from-selection": forEditor((editor, event) => {
        if (!editorMatchers.get(editor)?.removeBrackets()) event.abortKeyBinding();
      }),
    });
  },

  deactivate() {
    this.matchEmitter.dispose();
    this.commandsDisposable?.dispose();
    this.commandsDisposable = null;
  },

  provideBracketMatcher() {
    const api = {
      getMatchRanges(editor) {
        const view = editorViews.get(editor);
        if (!view || !view.pairHighlighted) return null;
        if (view.bracket1Range && view.bracket2Range) {
          return { range1: view.bracket1Range, range2: view.bracket2Range };
        }
        if (view.startMarker) {
          return {
            range1: view.startMarker.getBufferRange(),
            range2: view.endMarker.getBufferRange(),
          };
        }
        return null;
      },
      observe: (callback) => {
        return this.matchEmitter.on("did-change-match", (editor) => {
          callback(editor, api.getMatchRanges(editor));
        });
      },
    };
    return api;
  },
};
