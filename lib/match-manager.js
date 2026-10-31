const { CompositeDisposable } = require("lumine");
const { escapeRegExp } = require("./helpers");

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
    this.automaticPolicyCache = null;
    this.autocompleteDisabledCharacters = new Set(
      this.getScopedSetting("bracket-matcher.autocompleteDisabledCharacters") ?? [],
    );
    this.pairedCharacters = {};
    this.pairedCharactersInverse = {};
    this.pairRegexes = {};
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
    for (const startPair in this.pairedCharacters) {
      const endPair = this.pairedCharacters[startPair];
      this.pairRegexes[startPair] = new RegExp(`[${escapeRegExp(startPair + endPair)}]`, "g");
    }
  }

  getScopedSetting(key) {
    return lumine.config.get(key, { scope: this.editor.getRootScopeDescriptor() });
  }

  automaticContext() {
    const positions = this.editor.getCursorBufferPositions();
    const mode = this.editor.getBuffer().getLanguageMode();
    return {
      mode,
      epoch: mode.getSyntaxRequestEpoch?.(),
      revision: this.editor.getBuffer().getTextRevision(),
      positions,
      key: positions.map(({ row, column }) => `${row}:${column}`).join(";"),
    };
  }

  sameAutomaticContext(left, right) {
    return (
      left?.mode === right.mode &&
      left.epoch === right.epoch &&
      left.revision === right.revision &&
      left.key === right.key
    );
  }

  scheduleAutomaticScopes() {
    if (this.automaticScopesScheduled || this.destroyed) return;
    this.automaticScopesScheduled = true;
    queueMicrotask(() => {
      this.automaticScopesScheduled = false;
      this.refreshAutomaticScopes();
    });
  }

  refreshAutomaticScopes() {
    if (this.destroyed) return;
    if (
      this.editor.hasMultipleCursors() &&
      this.editor.getSelections().every((selection) => selection.isEmpty())
    )
      return;
    const context = this.automaticContext();
    if (!context.mode.asynchronousSyntax) return;
    if (this.sameAutomaticContext(this.automaticScopes, context)) return;
    if (this.sameAutomaticContext(this.pendingAutomaticScopes?.context, context)) return;
    this.automaticScopeController?.abort();
    const controller = (this.automaticScopeController = new AbortController());
    const promise = this.editor
      .getScopeDescriptorsForBufferPositions(context.positions, { signal: controller.signal })
      .then((scopes) => {
        if (
          scopes &&
          !this.destroyed &&
          !controller.signal.aborted &&
          this.sameAutomaticContext(context, this.automaticContext())
        )
          this.automaticScopes = { ...context, scopes };
      })
      .catch((error) => {
        if (!controller.signal.aborted && !this.destroyed)
          console.error("Unable to resolve automatic bracket scopes", error);
      })
      .finally(() => {
        if (this.pendingAutomaticScopes?.context === context) this.pendingAutomaticScopes = null;
      });
    this.pendingAutomaticScopes = { context, promise };
    return promise;
  }

  automaticPolicyForScope(scope) {
    const names = Array.isArray(scope) ? scope : scope.getScopesArray();
    const embedded = names.findIndex((name) => name.startsWith("meta.embedded.block."));
    // An empty code fence may have no injection yet. Its host's quote policy
    // is not evidence that an automatic edit is valid in the unknown language.
    if (
      embedded !== -1 &&
      !names.slice(embedded + 1).some((name) => lumine.grammars.grammarForScopeName(name))
    )
      return null;
    const read = (name) => lumine.config.get(`bracket-matcher.${name}`, { scope });
    const pairs = read("autocompleteCharacters");
    const newlines = read("pairsWithExtraNewline");
    const disabled = read("autocompleteDisabledCharacters") ?? [];
    const policy = {
      scope,
      pairedCharacters: {},
      pairedCharactersInverse: {},
      pairsWithExtraNewline: {},
      autocompleteDisabledCharacters: new Set(disabled),
      signature: JSON.stringify([
        pairs,
        newlines,
        disabled,
        read("autocompleteBrackets"),
        read("wrapSelectionsInBrackets"),
        read("alwaysSkipClosingPairs"),
      ]),
    };
    this.processAutoPairs(pairs, policy.pairedCharacters, (pair) => pair);
    this.processAutoPairs(pairs, policy.pairedCharactersInverse, ([left, right]) => [right, left]);
    this.processAutoPairs(newlines, policy.pairsWithExtraNewline, (pair) => pair);
    return policy;
  }

  getAutomaticPolicy() {
    if (
      this.editor.hasMultipleCursors() &&
      this.editor.getSelections().every((selection) => selection.isEmpty())
    )
      return null;
    const context = this.automaticContext();
    if (
      this.automaticPolicyCache &&
      this.sameAutomaticContext(this.automaticPolicyCache.context, context)
    )
      return this.automaticPolicyCache.policy;
    let scopes;
    if (context.mode.asynchronousSyntax) {
      if (!this.sameAutomaticContext(this.automaticScopes, context)) {
        this.scheduleAutomaticScopes();
        return null;
      }
      scopes = this.automaticScopes.scopes;
    } else {
      scopes = context.positions.map((position) =>
        this.editor.scopeDescriptorForBufferPosition(position),
      );
    }
    const key = JSON.stringify(scopes.map((scope) => scope.getScopesArray()));
    if (this.automaticPolicyCache?.key === key) {
      this.automaticPolicyCache.context = context;
      return this.automaticPolicyCache.policy;
    }
    const uniqueScopes = new Map();
    const policies = scopes.map((scope) => {
      const scopeKey = scope.getScopeChain();
      if (!uniqueScopes.has(scopeKey))
        uniqueScopes.set(scopeKey, this.automaticPolicyForScope(scope));
      return uniqueScopes.get(scopeKey);
    });
    const policy = policies.every((item) => item && item.signature === policies[0]?.signature)
      ? policies[0]
      : null;
    this.automaticPolicyCache = { key, context, policy };
    return policy;
  }

  constructor(editor, _editorElement) {
    this.destroy = this.destroy.bind(this);
    this.editor = editor;
    this.automaticPolicyVersion = 0;
    this.subscriptions = new CompositeDisposable();
    this.configSubscriptions = null;
    this.bindConfig();
    this.subscriptions.add(
      this.editor.onDidChangeGrammar(() => {
        this.automaticScopes = null;
        this.automaticPolicyCache = null;
        this.bindConfig();
        this.scheduleAutomaticScopes();
      }),
      this.editor.onDidChangeSelectionRange(() => this.scheduleAutomaticScopes()),
      this.editor.getBuffer().onDidChangeText(() => this.scheduleAutomaticScopes()),
      this.editor.onDidTokenize(() => this.scheduleAutomaticScopes()),
      lumine.config.onDidChangeConfiguration(() => {
        this.automaticPolicyCache = null;
        this.automaticPolicyVersion++;
      }),
      this.editor.onDidDestroy(this.destroy),
    );

    this.scheduleAutomaticScopes();

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
      lumine.config.observe("bracket-matcher.autocompleteDisabledCharacters", { scope }, () =>
        this.updateConfig(),
      ),
    );
  }

  destroy() {
    this.destroyed = true;
    this.automaticScopeController?.abort();
    this.configSubscriptions?.dispose();
    this.subscriptions.dispose();
  }
};
