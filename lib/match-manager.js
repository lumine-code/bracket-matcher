const { CompositeDisposable } = require("lumine");

module.exports = class MatchManager {
  appendPair(pairList, [itemLeft, itemRight]) {
    const newPair = {};
    newPair[itemLeft] = itemRight;
    Object.assign(pairList, newPair);
  }

  processAutoPairs(autocompletePairs = [], pairedList, dataFun) {
    if (autocompletePairs.length) {
      for (let autocompletePair of autocompletePairs) {
        const pairArray = autocompletePair.split("");
        this.appendPair(pairedList, dataFun(pairArray));
      }
    }
  }

  updateConfig() {
    this.pairedCharacters = {};
    this.pairedCharactersInverse = {};
    this.pairsWithExtraNewline = {};
    this.processAutoPairs(
      this.getScopedSetting("bracket-matcher.autocompleteCharacters"),
      this.pairedCharacters,
      (x) => [x[0], x[1]],
    );
    this.processAutoPairs(
      this.getScopedSetting("bracket-matcher.autocompleteCharacters"),
      this.pairedCharactersInverse,
      (x) => [x[1], x[0]],
    );
    this.processAutoPairs(
      this.getScopedSetting("bracket-matcher.pairsWithExtraNewline"),
      this.pairsWithExtraNewline,
      (x) => [x[0], x[1]],
    );
  }

  getScopedSetting(key) {
    return lumine.config.get(key, { scope: this.editor.getRootScopeDescriptor() });
  }

  constructor(editor, _editorElement) {
    this.destroy = this.destroy.bind(this);
    this.editor = editor;
    this.subscriptions = new CompositeDisposable();
    this.configSubscriptions = null;
    this.bindConfig();
    this.subscriptions.add(
      this.editor.onDidChangeGrammar(() => this.bindConfig()),
      this.editor.onDidDestroy(this.destroy),
    );

    this.changeBracketsMode = false;
  }

  bindConfig() {
    this.configSubscriptions?.dispose();
    this.configSubscriptions = new CompositeDisposable();
    const scope = this.editor.getRootScopeDescriptor();
    this.configSubscriptions.add(
      lumine.config.observe("bracket-matcher.autocompleteCharacters", { scope }, () =>
        this.updateConfig(),
      ),
      lumine.config.observe("bracket-matcher.pairsWithExtraNewline", { scope }, () =>
        this.updateConfig(),
      ),
    );
  }

  destroy() {
    this.configSubscriptions?.dispose();
    this.subscriptions.dispose();
  }
};
